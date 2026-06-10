/**
 * org-ingest gate (IDEA.v2 §9.2) — synthetic org full ingest through the
 * persistent queue with parallel shard workers and backpressure.
 *
 * Proves: zero lost writes (per-shard atom accounting vs generator
 * ground truth), both FTS indexes in lock-step on every shard,
 * org-wide throughput ≥ --min-throughput atoms/s, queue drains, all
 * checkpoints durable.
 *
 * Usage: node dist/integration/org-ingest.js
 *          [--shards 96] [--docs-per-shard 40] [--workers 8]
 *          [--min-throughput 1500] [--root .data/org-ingest] [--report path]
 * Exits non-zero on any violated invariant — a CI gate, not a demo.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { FederatedEngine } from '../src/federated-engine.js';
import { chunkText } from '../src/spatial/chunker.js';
import { buildSyntheticOrg } from '../__test__/benchmark/org-dataset.js';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const SHARDS = Number(arg('shards', '96'));
const DOCS_PER_SHARD = Number(arg('docs-per-shard', '40'));
const WORKERS = Number(arg('workers', '8'));
const MIN_THROUGHPUT = Number(arg('min-throughput', '1500'));
const ROOT = arg('root', join(process.cwd(), '.data', 'org-ingest'));
const REPORT = arg('report', join(process.cwd(), 'reports', 'org-ingest-report.json'));

const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 1 });

async function main(): Promise<void> {
  console.log(`\n=== org-ingest — ${SHARDS} shards × ${DOCS_PER_SHARD} docs, ${WORKERS} parallel ingests ===\n`);
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });

  const org = buildSyntheticOrg({ seed: 42, shards: SHARDS, docsPerShard: DOCS_PER_SHARD });
  const expectedAtoms = new Map<string, number>();
  for (const s of org.shards) {
    expectedAtoms.set(
      s.shardKey,
      s.docs.reduce((sum, d) => sum + chunkText(d.text).length, 0),
    );
  }
  const totalExpected = [...expectedAtoms.values()].reduce((a, b) => a + b, 0);
  console.log(`[gen] ground truth: ${fmt(totalExpected)} atoms across ${SHARDS} shards`);

  const engine = await FederatedEngine.open({
    rootDir: ROOT,
    maxOpenShards: 64,
    maxConcurrentShardIngests: WORKERS,
    highWaterMark: 256,
  });

  // register + enqueue every shard (restart-safe queue)
  const byKey = new Map(org.shards.map((s) => [s.shardKey, s]));
  for (const s of org.shards) {
    await engine.ensureShard({
      shardKey: s.shardKey,
      kind: 'synthetic',
      displayName: s.displayName,
      clusters: s.clusters,
    });
    engine.catalog.enqueue({ shardKey: s.shardKey, task: 'full' });
  }
  const depth = engine.catalog.queueDepth();
  console.log(`[queue] ${depth.pending} tasks enqueued`);

  // drain: synthetic connector — stream docs in batches of 50, then
  // checkpoint AFTER the ingest completes (checkpoint-after-commit)
  const t0 = performance.now();
  let ingestedAtoms = 0;
  const { completed, failed } = await engine.scheduler.drainQueue(async (task) => {
    const spec = byKey.get(task.shardKey)!;
    const batches = (async function* () {
      for (let i = 0; i < spec.docs.length; i += 50) yield spec.docs.slice(i, i + 50);
    })();
    const report = await engine.scheduler.ingestDocs(task.shardKey, batches);
    ingestedAtoms += report.atoms;
    engine.catalog.putCheckpoint(task.shardKey, 'synthetic', `full:${report.docs}`);
  });
  const ingestMs = performance.now() - t0;
  const throughput = ingestedAtoms / (ingestMs / 1000);
  console.log(
    `[ingest] ${fmt(ingestedAtoms)} atoms in ${fmt(ingestMs)} ms — ${fmt(throughput)} atoms/s ` +
      `(${completed} tasks ok, ${failed} failed)`,
  );

  // ---- invariants ----------------------------------------------------------
  const failures: string[] = [];
  if (failed > 0) failures.push(`${failed} queue tasks failed`);
  const after = engine.catalog.queueDepth();
  if (after.pending !== 0 || after.running !== 0) {
    failures.push(`queue not drained: ${JSON.stringify(after)}`);
  }

  console.log(`[verify] per-shard atom accounting + dual-FTS lock-step on every shard…`);
  let verifiedShards = 0;
  for (const s of org.shards) {
    const stats = await engine.withEngine(s.shardKey, (e) => e.stats());
    const expected = expectedAtoms.get(s.shardKey)!;
    if (stats.nodes !== expected) {
      failures.push(`${s.shardKey}: lost writes — nodes=${stats.nodes} expected=${expected}`);
    }
    if (stats.ftsRows !== stats.nodes || stats.ftsWordRows !== stats.nodes) {
      failures.push(
        `${s.shardKey}: FTS drift — nodes=${stats.nodes} fts=${stats.ftsRows} ftsWords=${stats.ftsWordRows}`,
      );
    }
    if (stats.documents !== DOCS_PER_SHARD) {
      failures.push(`${s.shardKey}: documents=${stats.documents} expected=${DOCS_PER_SHARD}`);
    }
    const checkpoint = engine.catalog.getCheckpoint(s.shardKey, 'synthetic');
    if (checkpoint !== `full:${DOCS_PER_SHARD}`) {
      failures.push(`${s.shardKey}: checkpoint missing/wrong: ${checkpoint}`);
    }
    verifiedShards++;
  }
  console.log(`[verify] ${verifiedShards}/${SHARDS} shards verified`);

  if (ingestedAtoms !== totalExpected) {
    failures.push(`org total mismatch: ingested=${ingestedAtoms} expected=${totalExpected}`);
  }
  if (throughput < MIN_THROUGHPUT) {
    failures.push(`throughput ${fmt(throughput)} atoms/s < gate ${MIN_THROUGHPUT}`);
  }

  // catalog rollup reflects reality
  const orgStats = await engine.stats();
  if (orgStats.totalAtoms !== totalExpected) {
    failures.push(`catalog rollup totalAtoms=${orgStats.totalAtoms} expected=${totalExpected}`);
  }
  console.log(
    `[catalog] rollup: ${fmt(orgStats.totalAtoms)} atoms, ${fmt(orgStats.totalDocs)} docs, ` +
      `pool open=${orgStats.pool.open} opens=${orgStats.pool.opens} evictions=${orgStats.pool.evictions}`,
  );

  mkdirSync(dirname(REPORT), { recursive: true });
  writeFileSync(
    REPORT,
    JSON.stringify(
      {
        shards: SHARDS,
        docsPerShard: DOCS_PER_SHARD,
        workers: WORKERS,
        atoms: ingestedAtoms,
        expectedAtoms: totalExpected,
        ingestMs: Math.round(ingestMs),
        atomsPerSec: Math.round(throughput),
        minThroughputGate: MIN_THROUGHPUT,
        pool: orgStats.pool,
        failures,
      },
      null,
      2,
    ),
  );
  await engine.close();

  if (failures.length > 0) {
    console.error(`\nFAIL: org-ingest violated ${failures.length} invariant(s):`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(
    `\nPASS: ${fmt(ingestedAtoms)} atoms across ${SHARDS} shards, zero lost writes, ` +
      `dual FTS lock-step, ${fmt(throughput)} atoms/s ≥ ${MIN_THROUGHPUT}, queue drained, checkpoints durable.\n`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
