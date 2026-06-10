/**
 * IDEA.v2 §10.1/§10.4 — synthetic-org generator determinism, five-band
 * distribution validation, cross-shard docRecall with shardKey:path ids,
 * near-collision lure retrieve-but-outrank, per-shard auto-annotation
 * merge, end-to-end benchmark through a live FederatedEngine.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FederatedEngine } from '../src/federated-engine.js';
import { buildSyntheticOrg } from './benchmark/org-dataset.js';
import {
  buildConfluenceFixtureDataset,
  buildOrgSyntheticDataset,
  buildRepoOrgDataset,
} from './benchmark/org-benchmark.js';
import { buildFixtureSite } from './fixtures/confluence-fixture-server.js';
import {
  BenchmarkRunner,
  FEDERATED_DISTRIBUTION_BANDS,
  validateDistribution,
} from './eval/benchmark.js';
import { federatedBenchmarkRetriever } from './eval/federated.js';
import type { CorpusDoc } from './eval/goldens.js';

// ---- generator determinism ---------------------------------------------------

test('synthetic org: same seed ⇒ identical org (two builds compared)', () => {
  const a = buildSyntheticOrg({ seed: 99, shards: 6, docsPerShard: 8 });
  const b = buildSyntheticOrg({ seed: 99, shards: 6, docsPerShard: 8 });
  assert.deepEqual(a, b);
  const c = buildSyntheticOrg({ seed: 100, shards: 6, docsPerShard: 8 });
  assert.notDeepEqual(a.shards[0].docs[0].needle, c.shards[0].docs[0].needle, 'different seed diverges');
});

// ---- distribution bands ---------------------------------------------------------

const synth = buildSyntheticOrg({ seed: 3, shards: 10, docsPerShard: 12 });
const orgDataset = buildOrgSyntheticDataset(synth, { seed: 3 });

test('org-synthetic-v2: five-band federated distribution validates', () => {
  const report = validateDistribution(orgDataset.cases, FEDERATED_DISTRIBUTION_BANDS);
  assert.ok(report.ok, report.violations.join('; '));
  assert.ok(report.counts['cross-shard'] >= 4, 'cross-shard band populated');
});

test('cross-shard cases span two shards in their supportingDocs', () => {
  for (const c of orgDataset.cases.filter((c) => c.metadata.queryType === 'cross-shard')) {
    const shards = new Set(c.supportingDocs.map((d) => d.split(':').slice(0, 2).join(':')));
    assert.equal(shards.size, 2, `${c.id}: ${c.supportingDocs.join(', ')}`);
  }
});

test('four-band demo001 datasets stay valid under the default bands', () => {
  const fourBand = orgDataset.cases.filter((c) => c.metadata.queryType !== 'cross-shard');
  // not asserting ok (fractions shifted) — asserting cross-shard band is
  // ignored by default bands so legacy datasets cannot fail on it
  const report = validateDistribution(fourBand);
  assert.ok(!report.violations.some((v) => v.startsWith('cross-shard')));
});

// ---- per-shard auto-annotation merge ----------------------------------------------

test('repo-org-v2: per-shard annotation merges with shard attribution', () => {
  const mkCorpus = (tag: string): CorpusDoc[] => {
    const docs: CorpusDoc[] = Array.from({ length: 8 }, (_, f) => ({
      title: `src/${tag}${f}.ts`,
      originFile: `src/${tag}${f}.ts`,
      text: [
        `export function ${tag}Handler${f}(req: Request) {`,
        `  return dispatch_${tag}_${f}(req);`,
        `}`,
        `export const ${tag}Config${f} = { retries: ${f} };`,
      ].join('\n'),
    }));
    // cross-referenced identifiers (the annotator's DISTRACTOR feedstock):
    // an index file referencing definitions from sibling files
    docs.push({
      title: `src/${tag}Index.ts`,
      originFile: `src/${tag}Index.ts`,
      text: [
        `import { ${tag}Handler0 } from './${tag}0.js';`,
        `import { ${tag}Handler1 } from './${tag}1.js';`,
        `export const routes = [${tag}Handler0, ${tag}Handler1];`,
        `export const wired = ${tag}Config2 != null;`,
      ].join('\n'),
    });
    return docs;
  };
  const ds = buildRepoOrgDataset(
    [
      { shardKey: 'gh:acme/alpha', corpus: mkCorpus('alpha') },
      { shardKey: 'gh:acme/beta', corpus: mkCorpus('beta') },
    ],
    { seed: 7, casesPerShard: 8 },
  );
  assert.ok(ds.cases.length > 0);
  for (const c of ds.cases) {
    for (const d of c.supportingDocs) {
      assert.match(d, /^gh:acme\/(alpha|beta):src\//, `shard-attributed doc id: ${d}`);
    }
  }
  // ids are namespaced per shard → no collisions after merge
  assert.equal(new Set(ds.cases.map((c) => c.id)).size, ds.cases.length);
});

test('confluence-fixture-v2: curated cases validate under default bands', () => {
  const ds = buildConfluenceFixtureDataset(buildFixtureSite());
  assert.equal(ds.cases.length, 20);
  const report = validateDistribution(ds.cases);
  assert.ok(report.ok, report.violations.join('; '));
});

// ---- end-to-end through a live FederatedEngine -------------------------------------

const dir = mkdtempSync(join(tmpdir(), 'sme-orgbench-'));
const org = await FederatedEngine.open({ rootDir: dir, maxConcurrentShardIngests: 4 });
for (const s of synth.shards) {
  await org.ensureShard({ shardKey: s.shardKey, kind: 'synthetic', displayName: s.displayName, clusters: s.clusters });
  await org.ingest(s.shardKey, [s.docs]);
}
org.catalog.refreshAllRoutingTerms();

after(async () => {
  await org.close();
  rmSync(dir, { recursive: true, force: true });
});

test('end-to-end: org-synthetic-v2 passes through the live federated engine', async () => {
  const runner = new BenchmarkRunner({
    retrieve: federatedBenchmarkRetriever(org),
    bands: FEDERATED_DISTRIBUTION_BANDS,
  });
  const report = await runner.run(orgDataset);
  const failing = report.cases.filter((c) => !c.passed);
  assert.equal(
    report.passed,
    true,
    failing.map((c) => `${c.id}: ${c.metrics.filter((m) => !m.passed).map((m) => `${m.name}=${m.score} (${m.reason})`).join('; ')}`).join('\n'),
  );
  assert.ok(report.perType['cross-shard'].cases > 0);
  assert.equal(report.perType['cross-shard'].passed, report.perType['cross-shard'].cases);
});

test('near-collision lures: retrieved-but-outranked — supporting doc holds rank 1', async () => {
  const retrieve = federatedBenchmarkRetriever(org, { limit: 10 });
  const distractors = orgDataset.cases.filter((c) => c.metadata.queryType === 'distractor').slice(0, 4);
  for (const c of distractors) {
    const got = await retrieve(c.input);
    assert.ok(got.length > 0, `${c.id} retrieved nothing`);
    assert.equal(got[0].docId, c.supportingDocs[0], `${c.id}: lure outranked the needle (${got[0].docId})`);
  }
});
