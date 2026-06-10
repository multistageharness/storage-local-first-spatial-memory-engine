/**
 * perf-gate (IDEA.v2 §10.5 / §9.2) — runs the deterministic perf suite
 * and compares against checked-in baselines with ±25% tolerance bands.
 * Non-zero exit on any metric outside its band; prints the delta table.
 *
 * Suite: ingest throughput (single shard / 8 parallel shards /
 * incremental delta), query latency (in-shard trigram + hybrid,
 * federated fan-out at 1/50-way), outbox drain rate, ShardPool cold-open
 * latency + LRU churn.
 *
 * Usage: node dist/integration/perf-gate.js
 *          [--baseline __test__/benchmark/perf-baseline.json]
 *          [--report reports/perf-report.json]
 *          [--update-baseline]   (writes the run as the new baseline)
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname, join } from 'node:path';
import { FederatedEngine } from '../src/federated-engine.js';
import { MemoryEngine } from '../src/engine.js';
import {
  compareToBaseline,
  measureLatency,
  measureThroughput,
  renderDeltaTable,
  type PerfMetric,
  type PerfReport,
} from '../__test__/benchmark/perf.js';
import { buildSyntheticOrg, mulberry32 } from '../__test__/benchmark/org-dataset.js';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const BASELINE_PATH = arg('baseline', join(process.cwd(), '__test__', 'benchmark', 'perf-baseline.json'));
const REPORT = arg('report', join(process.cwd(), 'reports', 'perf-report.json'));
const UPDATE = process.argv.includes('--update-baseline');
const ROOT = arg('root', join(process.cwd(), '.data', 'perf'));
const TOLERANCE = Number(arg('tolerance', '0.25'));

async function main(): Promise<void> {
  console.log(`\n=== perf-gate — seeded suite vs baselines (±${TOLERANCE * 100}%) ===\n`);
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });

  const metrics: Record<string, PerfMetric> = {};
  const org = buildSyntheticOrg({ seed: 7, shards: 16, docsPerShard: 60 });

  // ---- ingest: single shard -------------------------------------------------
  {
    const engine = await FederatedEngine.open({ rootDir: join(ROOT, 'single') });
    await engine.ensureShard({ shardKey: org.shards[0].shardKey, kind: 'synthetic', clusters: org.shards[0].clusters });
    metrics['ingest.singleShard'] = await measureThroughput('atoms/s', async () => {
      const r = await engine.ingest(org.shards[0].shardKey, [org.shards[0].docs]);
      return r.atoms;
    });
    console.log(`[ingest.singleShard] ${metrics['ingest.singleShard'].kind === 'throughput' ? (metrics['ingest.singleShard'] as { value: number }).value.toFixed(0) : ''} atoms/s`);

    // ---- incremental: 1-doc delta on the ingested shard ----------------------
    const spec = org.shards[0];
    const changed = { ...spec.docs[0], text: spec.docs[0].text + '\n// touched for delta perf', contentHash: undefined };
    metrics['ingest.oneDocDelta'] = await measureLatency(
      async () => {
        // alternate content back and forth so each call really re-indexes
        changed.text = changed.text.endsWith('A') ? changed.text.slice(0, -1) + 'B' : changed.text + 'A';
        await engine.withEngine(spec.shardKey, (e) => e.replaceDocument(changed));
      },
      { warmup: 2, samples: 20 },
    );
    await engine.close();
  }

  // ---- ingest: 8 parallel shards ----------------------------------------------
  {
    const engine = await FederatedEngine.open({ rootDir: join(ROOT, 'par8'), maxConcurrentShardIngests: 8 });
    const eight = org.shards.slice(0, 8);
    for (const s of eight) await engine.ensureShard({ shardKey: s.shardKey, kind: 'synthetic', clusters: s.clusters });
    metrics['ingest.parallel8'] = await measureThroughput('atoms/s', async () => {
      const reports = await Promise.all(eight.map((s) => engine.ingest(s.shardKey, [s.docs])));
      return reports.reduce((a, r) => a + r.atoms, 0);
    });
    await engine.close();
  }

  // ---- query latency over a warm 16-shard org ---------------------------------
  {
    const engine = await FederatedEngine.open({
      rootDir: join(ROOT, 'query'),
      maxOpenShards: 24,
      maxReaders: 4,
      maxTotalWorkers: 144,
    });
    for (const s of org.shards) await engine.ensureShard({ shardKey: s.shardKey, kind: 'synthetic', clusters: s.clusters });
    for (const s of org.shards) await engine.ingest(s.shardKey, [s.docs]);
    engine.catalog.refreshAllRoutingTerms();

    const rnd = mulberry32(0xfeed);
    const pickNeedle = () => {
      const s = org.shards[Math.floor(rnd() * org.shards.length)];
      return { shard: s.shardKey, q: s.docs[Math.floor(rnd() * s.docs.length)].needleQuery };
    };
    const shard0 = await engine.engine(org.shards[0].shardKey);

    metrics['query.trigram.1way'] = await measureLatency(
      async () => shard0.search(pickNeedle().q, { limit: 10 }),
      { samples: 100 },
    );
    metrics['query.hybrid.1way'] = await measureLatency(
      async () => shard0.hybridSearch(pickNeedle().q, { limit: 10 }),
      { samples: 100 },
    );
    metrics['query.federated.1way'] = await measureLatency(
      async () => engine.search(pickNeedle().q, { limit: 10 }),
      { samples: 100 },
    );
    metrics['query.federated.50way'] = await measureLatency(
      async () => engine.search(pickNeedle().q, { limit: 10 }),
      { samples: 300, concurrency: 50 },
    );
    console.log(`[query] federated 50-way p95: ${(metrics['query.federated.50way'] as { p95: number }).p95.toFixed(1)} ms`);

    // ---- sync: outbox drain rate ----------------------------------------------
    metrics['sync.outboxDrain'] = await measureThroughput('merges/s', async () => {
      let merged = 0;
      for (;;) {
        const r = await engine.syncNow();
        merged += r.merged;
        if (r.shards === 0) break;
      }
      return merged;
    });
    await engine.close();
  }

  // ---- ShardPool: cold open + LRU churn ----------------------------------------
  {
    const engine = await FederatedEngine.open({ rootDir: join(ROOT, 'pool'), maxOpenShards: 8 });
    for (const s of org.shards) await engine.ensureShard({ shardKey: s.shardKey, kind: 'synthetic', clusters: s.clusters });
    for (const s of org.shards.slice(0, 12)) await engine.ingest(s.shardKey, [s.docs.slice(0, 10)]);
    // round-robin probing 12 shards through an 8-slot LRU = guaranteed churn
    let i = 0;
    metrics['pool.lruChurnOpen'] = await measureLatency(
      async () => {
        const s = org.shards[i++ % 12];
        await engine.withEngine(s.shardKey, async (e) => e.stats());
      },
      { warmup: 8, samples: 40 },
    );
    await engine.close();
  }

  const report: PerfReport = {
    generatedAt: new Date().toISOString(),
    cores: availableParallelism(),
    metrics,
  };
  mkdirSync(dirname(REPORT), { recursive: true });
  writeFileSync(REPORT, JSON.stringify(report, null, 2));

  if (UPDATE || !existsSync(BASELINE_PATH)) {
    mkdirSync(dirname(BASELINE_PATH), { recursive: true });
    writeFileSync(BASELINE_PATH, JSON.stringify(report, null, 2));
    console.log(`\nbaseline ${UPDATE ? 'updated' : 'created'}: ${BASELINE_PATH}`);
    console.log(`PASS: perf baseline established (no comparison run).\n`);
    return;
  }

  const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as PerfReport;
  const cmp = compareToBaseline(metrics, baseline.metrics, TOLERANCE);
  console.log(`\n${renderDeltaTable(cmp)}\n`);
  if (cmp.missing.length > 0) {
    console.error(`FAIL: metrics missing from this run: ${cmp.missing.join(', ')}`);
    process.exit(1);
  }
  if (cmp.failures.length > 0) {
    console.error(`FAIL: ${cmp.failures.length} metric(s) outside the ±${TOLERANCE * 100}% band.`);
    process.exit(1);
  }
  console.log(`PASS: all ${cmp.deltas.length} perf checks within ±${TOLERANCE * 100}% of baseline.\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
