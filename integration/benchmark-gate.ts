/**
 * Benchmark gate — runs the curated golden dataset against the live engine
 * as a CI deployment gate, complementing the synthetic eval gate:
 *
 *   eval-gate       synthetic goldens, broad regression net
 *   benchmark-gate  curated, annotated cases with an enforced distribution
 *                   (common / distractor / multi-hop / no-answer)
 *
 * Per the benchmark design rules:
 *   - distribution bands are validated before any case executes;
 *   - retrieval is scored exactly against annotated supporting doc ids;
 *   - no-answer cases pass only on refusal (hallucination = failure);
 *   - the runner enforces judge ≠ dataset-generator model separation.
 *
 * Exits non-zero when any case or band fails — wire it into CI:
 * `npm run benchmark`.
 *
 * Usage: node dist/examples/benchmark-gate.js [--db path] [--report path] [--jury]
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { MemoryEngine } from '../src/engine.js';
import { BenchmarkRunner, type BenchmarkReport } from '../__test__/eval/benchmark.js';
import { benchmarkRetriever } from '../__test__/eval/retriever.js';
import { LexicalJudge, JudgeJury } from '../__test__/eval/judge.js';
import { benchmarkDataset } from '../__test__/benchmark/dataset.js';
import { uiEcosystemDataset } from '../__test__/benchmark/ui-ecosystem-dataset.js';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const DB_PATH = arg('db', join(process.cwd(), '.data', 'benchmark-gate.db'));
const REPORT_PATH = arg('report', join(process.cwd(), '.data', 'benchmark-report.json'));
const USE_JURY = process.argv.includes('--jury');

const DATASETS = [benchmarkDataset, uiEcosystemDataset];

async function main(): Promise<void> {
  mkdirSync(dirname(REPORT_PATH), { recursive: true });
  const judge = USE_JURY
    ? new JudgeJury([
        new LexicalJudge({ attributionThreshold: 0.6 }),
        new LexicalJudge({ attributionThreshold: 0.7 }),
        new LexicalJudge({ attributionThreshold: 0.8 }),
      ])
    : new LexicalJudge();

  const reports: BenchmarkReport[] = [];
  for (const dataset of DATASETS) {
    // isolated DB per dataset — corpora must not contaminate each other
    const dbPath = DB_PATH.replace(/\.db$/, `-${dataset.name}.db`);
    mkdirSync(dirname(dbPath), { recursive: true });
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${dbPath}${suffix}`, { force: true });

    const engine = await MemoryEngine.open({ dbPath, graph: 'benchmark-gate', minReaders: 2 });
    try {
      for (const doc of dataset.corpus) await engine.ingestDocument(doc);
      const runner = new BenchmarkRunner({ retrieve: benchmarkRetriever(engine, { limit: 5 }), judge });
      const report = await runner.run(dataset);
      reports.push(report);

      console.log(`benchmark-gate: dataset = ${report.dataset} (${report.totals.cases} cases)`);
      console.log(`benchmark-gate: judge = ${report.judge}`);
      console.log(
        `benchmark-gate: distribution = ${JSON.stringify(report.distribution.fractions)}` +
          (report.distribution.ok ? ' (in band)' : ` VIOLATIONS: ${report.distribution.violations.join('; ')}`),
      );
      for (const [type, t] of Object.entries(report.perType)) {
        console.log(`benchmark-gate:   ${type.padEnd(10)} ${t.passed}/${t.cases} passed`);
      }
    } finally {
      await engine.close();
    }
  }

  const passed = reports.every((r) => r.passed);
  writeFileSync(REPORT_PATH, JSON.stringify({ passed, datasets: reports }, null, 2));
  console.log(`benchmark-gate: report written to ${REPORT_PATH}`);

  if (!passed) {
    for (const r of reports.filter((x) => !x.passed)) {
      for (const c of r.cases.filter((x) => !x.passed)) {
        for (const m of c.metrics.filter((x) => !x.passed)) {
          console.error(`  FAIL ${r.dataset}/${c.id} [${m.component}] ${m.name} ${m.score} < ${m.threshold} — ${m.reason}`);
        }
      }
    }
    console.error('benchmark-gate: GATE FAILED — deployment blocked');
    process.exitCode = 1;
    return;
  }
  console.log('benchmark-gate: GATE PASSED');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
