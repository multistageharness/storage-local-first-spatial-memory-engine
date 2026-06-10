/**
 * Repo loader + auto-annotator tests — over a small synthetic fixture
 * "repository" written to a temp dir (no network, no facebook/react
 * checkout needed). The full-scale react run lives behind
 * `make benchmark-react` / `npm run benchmark:react`, not in unit tests.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { MemoryEngine } from '../src/engine.js';
import { loadRepoCorpus, buildRepoBenchmark } from './benchmark/repo-loader.js';
import { BenchmarkRunner, validateDistribution } from './eval/benchmark.js';
import { benchmarkRetriever } from './eval/retriever.js';

const dir = mkdtempSync(join(tmpdir(), 'sme-repo-'));
const repoRoot = join(dir, 'fixture-repo');

/** Synthetic source file: one uniquely-named exported function + helpers. */
function sourceFile(name: string, extra = ''): string {
  return (
    `export function ${name}(payload) {\n` +
    `  const normalized = sanitize(payload);\n` +
    `  return ${name}Impl(normalized);\n` +
    `}\n` +
    `function ${name}Impl(value) {\n` +
    `  return value;\n` +
    `}\n` +
    extra
  );
}

// 14 single-definition identifiers (common + multi-hop pools) and enough
// cross-referenced ones (distractor pool) to annotate 20 cases at 11/5/2/2.
const FILES: Record<string, string> = {};
const NAMES = [
  'resolveQuantumLedger', 'computeNebulaDigest', 'mergeAuroraStream', 'packGlacierBundle',
  'traceOrbitalVector', 'foldZephyrMatrix', 'scanTundraIndex', 'liftMonsoonPayload',
  'bindCalderaSocket', 'parseObsidianToken', 'weaveSavannaGraph', 'chartLagoonRoute',
  'snapMeridianFrame', 'driftCobaltSignal', 'lockHarborMutex', 'spinPrairieWheel',
];
for (const [i, name] of NAMES.entries()) {
  FILES[`pkg-${String(i).padStart(2, '0')}/src/${name}.js`] = sourceFile(name);
}
// cross-referenced identifiers: defined once, referenced from sibling files
const SHARED = ['syncBoreal', 'hashCascade', 'pruneEstuary', 'mapJunction', 'tagPinnacle', 'fuseDelta'];
for (const [i, name] of SHARED.entries()) {
  FILES[`shared-${i}/src/define-${name}.js`] = sourceFile(name);
  FILES[`shared-${i}/src/use-${name}.js`] = `import { ${name} } from './define-${name}.js';\nexport const wired${i} = ${name}({ flag: true });\n`;
}
// noise that the loader must skip
FILES['pkg-00/src/__tests__/skipme.test.js'] = 'export function shouldNeverLoad() {}';
FILES['pkg-00/src/readme.md'] = '# not source';

before(() => {
  for (const [rel, text] of Object.entries(FILES)) {
    mkdirSync(dirname(join(repoRoot, rel)), { recursive: true });
    writeFileSync(join(repoRoot, rel), text);
  }
});

after(() => rmSync(dir, { recursive: true, force: true }));

test('loader: walks sources deterministically, skips tests and non-source files', () => {
  const corpus = loadRepoCorpus(repoRoot);
  const titles = corpus.map((d) => d.title);
  assert.equal(corpus.length, NAMES.length + SHARED.length * 2);
  assert.ok(!titles.some((t) => t.includes('__tests__')), 'test dirs excluded');
  assert.ok(!titles.some((t) => t.endsWith('.md')), 'non-source excluded');
  assert.deepEqual(titles, [...titles].sort(), 'deterministic sorted walk');
  // doc id is the repo-relative path
  assert.ok(titles.includes(`pkg-00/src/${NAMES[0]}.js`));
  // maxFiles cap respected
  assert.equal(loadRepoCorpus(repoRoot, { maxFiles: 3 }).length, 3);
});

test('annotator: emits the recommended distribution with exact annotations', () => {
  const corpus = loadRepoCorpus(repoRoot);
  const ds = buildRepoBenchmark(corpus, { seed: 7, totalCases: 20 });
  assert.equal(ds.cases.length, 20);
  assert.ok(validateDistribution(ds.cases).ok, 'auto distribution must sit in band');
  assert.equal(ds.provenance.generatedBy, 'repo-auto-annotator-v1');

  for (const c of ds.cases) {
    if (!c.metadata.answerable) {
      assert.equal(c.supportingDocs.length, 0);
      assert.equal(c.expectedAnswer, '');
      continue;
    }
    assert.ok(c.supportingDocs.length >= 1);
    // expected answer is extractive ground truth: its leading sentence must
    // literally exist in a supporting doc (sentence joins lose the original
    // newline boundaries, so only the head is byte-comparable)
    const sources = corpus.filter((d) => c.supportingDocs.includes(d.title));
    assert.ok(
      sources.some((d) => d.text.includes(c.expectedAnswer.slice(0, 25))),
      `evidence "${c.expectedAnswer.slice(0, 50)}" must come from a supporting doc`,
    );
    // and the asked-about identifier must appear in the evidence
    const identifier = /What does (\w+) do/.exec(c.input)![1];
    assert.ok(c.expectedAnswer.includes(identifier), `${c.id}: evidence must mention ${identifier}`);
  }
  // distractor cases annotate real lures
  for (const c of ds.cases.filter((x) => x.metadata.queryType === 'distractor')) {
    assert.ok(c.metadata.tags?.some((t) => t.startsWith('lure:')), `${c.id} must tag its lure files`);
  }
  // determinism: same seed → identical dataset
  assert.deepEqual(buildRepoBenchmark(corpus, { seed: 7, totalCases: 20 }), ds);
});

test('annotator: rejects corpora too small to annotate', () => {
  const corpus = loadRepoCorpus(repoRoot, { maxFiles: 2 });
  assert.throws(() => buildRepoBenchmark(corpus, { totalCases: 20 }), /corpus too small/);
});

test('end-to-end: fixture repo benchmark passes through the live engine', async () => {
  const corpus = loadRepoCorpus(repoRoot);
  const engine = await MemoryEngine.open({ dbPath: join(dir, 'repo.db'), graph: 'repo-bench', minReaders: 2 });
  try {
    for (const doc of corpus) await engine.ingestDocument(doc);
    const ds = buildRepoBenchmark(corpus, { seed: 7, totalCases: 20, name: 'fixture-repo-v1' });
    const report = await new BenchmarkRunner({ retrieve: benchmarkRetriever(engine, { limit: 8 }) }).run(ds);
    assert.ok(
      report.passed,
      report.cases
        .filter((c) => !c.passed)
        .map((c) => `${c.id}: ${c.metrics.filter((m) => !m.passed).map((m) => `${m.name} ${m.score}`).join(',')}`)
        .join('; '),
    );
    assert.equal(report.totals.failed, 0);
  } finally {
    await engine.close();
  }
});
