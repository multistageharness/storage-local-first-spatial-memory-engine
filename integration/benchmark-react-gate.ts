/**
 * React-repo benchmark gate — loads a MASSIVE real code repository
 * (facebook/react) through the engine's full chunk → route → FTS5 pipeline
 * and benchmarks retrieval + generation over it:
 *
 *   1. Clone (or reuse) a shallow facebook/react checkout.
 *   2. Load every source file under packages/ as a corpus document
 *      (~950 files, ~7 MB → tens of thousands of FTS5-indexed atoms).
 *   3. Auto-annotate a golden dataset from the checkout itself:
 *      identifier-definition lookups (common), organically cross-referenced
 *      identifiers whose referencing files act as real lures (distractor),
 *      two-file questions (multi-hop), and absent identifiers (no-answer) —
 *      emitted at the recommended 55/25/10/10 distribution.
 *   4. Run the BenchmarkRunner dynamically and emit a JSON report with
 *      corpus scale, ingestion timing, and per-type pass rates.
 *
 * Exits non-zero on any failing case or band — `npm run benchmark:react`
 * or `make benchmark-react`.
 *
 * Usage: node dist/examples/benchmark-react-gate.js
 *        [--repo .repos/react] [--subdir packages] [--max-files 0]
 *        [--cases 20] [--seed 42] [--db path] [--report path]
 */
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { MemoryEngine } from '../dist/src/engine.js';
import { BenchmarkRunner } from '../__test__/eval/benchmark.js';
import { benchmarkRetriever } from '../__test__/eval/retriever.js';
import { buildRepoBenchmark, loadRepoCorpus } from '../__test__/benchmark/repo-loader.js';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const REPO = arg('repo', join(process.cwd(), '.repos', 'react'));
const REPO_URL = arg('repo-url', 'https://github.com/facebook/react');
const SUBDIR = arg('subdir', 'packages');
const MAX_FILES = Number(arg('max-files', '0'));
const CASES = Number(arg('cases', '20'));
const SEED = Number(arg('seed', '42'));
// top-K is wider than the prose gates: file-anchor terms match every chunk
// of a file equally, so the definition chunk needs more fused slots to
// survive RRF ties within its own document
const LIMIT = Number(arg('limit', '8'));
const DB_PATH = arg('db', join(process.cwd(), '.data', 'benchmark-react.db'));
const REPORT_PATH = arg('report', join(process.cwd(), '.data', 'benchmark-react-report.json'));

async function main(): Promise<void> {
  if (!existsSync(join(REPO, SUBDIR))) {
    console.log(`benchmark-react-gate: cloning ${REPO_URL} (shallow) into ${REPO} …`);
    mkdirSync(dirname(REPO), { recursive: true });
    execSync(`git clone --depth 1 ${REPO_URL} "${REPO}"`, { stdio: 'inherit' });
  }

  console.log(`benchmark-react-gate: loading corpus from ${join(REPO, SUBDIR)}`);
  const corpus = loadRepoCorpus(join(REPO, SUBDIR), { maxFiles: MAX_FILES });
  const bytes = corpus.reduce((s, d) => s + d.text.length, 0);
  console.log(`benchmark-react-gate: ${corpus.length} source files, ${(bytes / 1048576).toFixed(1)} MB`);

  mkdirSync(dirname(DB_PATH), { recursive: true });
  rmSync(DB_PATH, { force: true });
  rmSync(`${DB_PATH}-wal`, { force: true });
  rmSync(`${DB_PATH}-shm`, { force: true });

  const engine = await MemoryEngine.open({ dbPath: DB_PATH, graph: 'benchmark-react', minReaders: 2 });
  try {
    const t0 = Date.now();
    let chunks = 0;
    for (const [i, doc] of corpus.entries()) {
      const res = await engine.ingestDocument(doc);
      chunks += res.chunks;
      if ((i + 1) % 200 === 0) console.log(`benchmark-react-gate: ingested ${i + 1}/${corpus.length} files…`);
    }
    const ingestMs = Date.now() - t0;
    console.log(`benchmark-react-gate: ingested ${corpus.length} files → ${chunks} atoms in ${(ingestMs / 1000).toFixed(1)}s`);

    const dataset = buildRepoBenchmark(corpus, { seed: SEED, totalCases: CASES, name: 'facebook-react-source-v1' });
    console.log(`benchmark-react-gate: auto-annotated ${dataset.cases.length} cases from the checkout`);

    const runner = new BenchmarkRunner({ retrieve: benchmarkRetriever(engine, { limit: LIMIT }) });
    const t1 = Date.now();
    const report = await runner.run(dataset);
    const evalMs = Date.now() - t1;

    const full = {
      ...report,
      corpus: { files: corpus.length, bytes, atoms: chunks, ingestMs, evalMs },
    };
    writeFileSync(REPORT_PATH, JSON.stringify(full, null, 2));
    console.log(`benchmark-react-gate: judge = ${report.judge}`);
    console.log(
      `benchmark-react-gate: distribution = ${JSON.stringify(report.distribution.fractions)}` +
        (report.distribution.ok ? ' (in band)' : ` VIOLATIONS: ${report.distribution.violations.join('; ')}`),
    );
    for (const [type, t] of Object.entries(report.perType)) {
      console.log(`benchmark-react-gate:   ${type.padEnd(10)} ${t.passed}/${t.cases} passed`);
    }
    console.log(`benchmark-react-gate: report written to ${REPORT_PATH}`);

    if (!report.passed) {
      for (const c of report.cases.filter((x) => !x.passed)) {
        for (const m of c.metrics.filter((x) => !x.passed)) {
          console.error(`  FAIL ${c.id} [${m.component}] ${m.name} ${m.score} < ${m.threshold} — ${m.reason}`);
          console.error(`       input: ${c.input}`);
        }
      }
      console.error('benchmark-react-gate: GATE FAILED — deployment blocked');
      process.exitCode = 1;
      return;
    }
    console.log('benchmark-react-gate: GATE PASSED');
  } finally {
    await engine.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
