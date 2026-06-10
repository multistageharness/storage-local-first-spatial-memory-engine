/**
 * rag-at-org-scale — the headline gate (IDEA.v2 §9.2).
 *
 * Synthetic org → parallel shard ingest → query storm (70% in-shard
 * needles with no graph hint, 20% cross-shard, 10% no-answer) at
 * --concurrency parallel searches → federated retrieval + context
 * assembly → rolling outbox drain.
 *
 * Gates: in-graph recall@10 ≥ 0.98, federated cross-shard recall@20
 * ≥ 0.90, router candidate-recall ≥ 0.99 (maxShards=32), no-answer
 * abstention = 1.0, pinned in-shard p50 ≤ 80 ms, federated p95 ≤ 500 ms.
 * Recall is measured with strict:true — quorum mode would measure the
 * straggler policy, not retrieval (IDEA.v2 §12).
 *
 * Usage: node dist/integration/rag-at-org-scale.js
 *          [--shards 96] [--docs-per-shard 40] [--queries 600]
 *          [--concurrency 200] [--root path] [--report path]
 * Scale-up profiles: --shards 500 (CI scale), --shards 2000 --docs-per-shard 400 (big).
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { FederatedEngine } from '../dist/src/federated-engine.js';
import { assembleContext } from '../dist/src/federation/context.js';
import {
  buildSyntheticOrg,
  synthesizeOrgQueries,
  type OrgQuery,
} from '../__test__/benchmark/org-dataset.js';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const SHARDS = Number(arg('shards', '96'));
const DOCS_PER_SHARD = Number(arg('docs-per-shard', '40'));
const QUERIES = Number(arg('queries', '600'));
const CONCURRENCY = Number(arg('concurrency', '200'));
const ROOT = arg('root', join(process.cwd(), '.data', 'org-scale'));
const REPORT = arg('report', join(process.cwd(), 'reports', 'rag-at-org-scale-report.json'));
/**
 * --recall-only: gate retrieval-quality metrics only; latency is
 * measured and reported but not gated. Used by the big-org profile
 * (500+ shards): the shard working set exceeds any sane LRU ceiling on
 * one laptop, so probes pay engine cold-opens — the known v2 latency
 * bottleneck (recorded in the retrospective; mitigation = lighter
 * engine opens / shared reader pools, a v2.1 item).
 */
const RECALL_ONLY = process.argv.includes('--recall-only');

const GATES = {
  needleRecall: 0.98,
  crossShardRecall: 0.9,
  routerRecall: 0.99,
  abstention: 1.0,
  pinnedP50Ms: 80,
  federatedP95Ms: 500,
};

const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 1 });

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

/** run `tasks` with a bounded worker pool */
async function storm<T>(tasks: (() => Promise<T>)[], concurrency: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= tasks.length) return;
      results[i] = await tasks[i]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
  return results;
}

async function main(): Promise<void> {
  console.log(
    `\n=== rag-at-org-scale — ${SHARDS} shards × ${DOCS_PER_SHARD} docs, ` +
      `${QUERIES} queries @ ${CONCURRENCY}-way ===\n`,
  );
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });

  const org = buildSyntheticOrg({ seed: 42, shards: SHARDS, docsPerShard: DOCS_PER_SHARD });
  const engine = await FederatedEngine.open({
    rootDir: ROOT,
    // storm profile: hold the working set warm (no LRU churn mid-query)
    // and give hot shards reader headroom — 1 reader/shard turns popular
    // shards into convoys under a 200-way storm
    maxOpenShards: Math.min(160, SHARDS + 16),
    maxTotalWorkers: 6 * Math.min(160, SHARDS + 16),
    maxReaders: 4,
    maxConcurrentShardIngests: 8,
  });

  // ---- ingest ---------------------------------------------------------------
  const t0 = performance.now();
  for (const s of org.shards) {
    await engine.ensureShard({
      shardKey: s.shardKey,
      kind: 'synthetic',
      displayName: s.displayName,
      clusters: s.clusters,
    });
  }
  const reports = await storm(
    org.shards.map((s) => () => engine.ingest(s.shardKey, [s.docs])),
    8,
  );
  // settle signatures against the final cross-shard df rollup
  engine.catalog.refreshAllRoutingTerms();
  const atoms = reports.reduce((a, r) => a + r.atoms, 0);
  const ingestMs = performance.now() - t0;
  console.log(`[ingest] ${fmt(atoms)} atoms in ${fmt(ingestMs)} ms (${fmt(atoms / (ingestMs / 1000))} atoms/s)`);

  const queries = synthesizeOrgQueries(org, QUERIES);
  const byType = (t: OrgQuery['type']) => queries.filter((q) => q.type === t);
  console.log(
    `[queries] needle=${byType('needle').length} cross-shard=${byType('cross-shard').length} ` +
      `no-answer=${byType('no-answer').length}`,
  );

  // ---- router candidate recall (component-isolated, before the storm) -------
  let routerHits = 0;
  const needleQueries = byType('needle');
  for (const q of needleQueries) {
    const routed = engine.router.route(q.query, { maxShards: 32 });
    if (q.expectedShards.every((s) => routed.shardKeys.includes(s))) routerHits++;
  }
  const routerRecall = needleQueries.length > 0 ? routerHits / needleQueries.length : 1;
  console.log(`[router] candidate recall@32: ${(routerRecall * 100).toFixed(2)}%`);

  // ---- federated query storm -------------------------------------------------
  // warmup: JIT + SQLite page cache + reader scale-up reach steady state
  // before any latency is recorded (same discipline as the perf harness)
  await storm(
    queries.slice(0, Math.min(100, queries.length)).map((q) => async () => {
      await engine.search(q.query, { limit: 10, maxShards: 32, strict: true });
    }),
    Math.min(CONCURRENCY, 100),
  );

  // recall storm — strict:true so the gate measures retrieval, not the
  // straggler policy (IDEA.v2 §12 "Quorum fusion needs a strict mode")
  let needleHits = 0;
  let crossHits = 0;
  let abstained = 0;
  const tq = performance.now();
  await storm(
    queries.map((q) => async () => {
      const limit = q.type === 'cross-shard' ? 20 : 10;
      const res = await engine.search(q.query, { limit, maxShards: 32, strict: true });
      if (q.type === 'needle') {
        const ok = q.expectedDocs.every((d) =>
          res.hits.some((h) => h.shardKey === d.shardKey && h.originFile === d.originFile),
        );
        if (ok) needleHits++;
      } else if (q.type === 'cross-shard') {
        const ok = q.expectedDocs.every((d) =>
          res.hits.some((h) => h.shardKey === d.shardKey && h.originFile === d.originFile),
        );
        if (ok) crossHits++;
      } else if (res.hits.length === 0) {
        abstained++; // fused-rank floor: nothing retrievable → abstain
      }
    }),
    CONCURRENCY,
  );
  const stormMs = performance.now() - tq;

  // latency storm — production quorum mode (timeoutMs=300, late shards
  // logged not awaited): the straggler policy is exactly what bounds the
  // production p95, so this is the path the latency gate measures
  const fedLatencies: number[] = [];
  await storm(
    queries.map((q) => async () => {
      const limit = q.type === 'cross-shard' ? 20 : 10;
      const qs = performance.now();
      await engine.search(q.query, { limit, maxShards: 32 });
      fedLatencies.push(performance.now() - qs);
    }),
    CONCURRENCY,
  );
  fedLatencies.sort((a, b) => a - b);

  const needleRecall = needleQueries.length > 0 ? needleHits / needleQueries.length : 1;
  const crossRecall = byType('cross-shard').length > 0 ? crossHits / byType('cross-shard').length : 1;
  const abstention = byType('no-answer').length > 0 ? abstained / byType('no-answer').length : 1;
  const fedP50 = percentile(fedLatencies, 50);
  const fedP95 = percentile(fedLatencies, 95);
  console.log(
    `[storm] ${QUERIES} federated searches in ${fmt(stormMs)} ms (${fmt(QUERIES / (stormMs / 1000))} q/s) — ` +
      `p50 ${fmt(fedP50)} ms, p95 ${fmt(fedP95)} ms`,
  );
  console.log(`[storm] needle recall@10: ${(needleRecall * 100).toFixed(2)}%`);
  console.log(`[storm] cross-shard recall@20: ${(crossRecall * 100).toFixed(2)}%`);
  console.log(`[storm] no-answer abstention: ${(abstention * 100).toFixed(1)}%`);

  // ---- pinned in-shard latency (Graph-firewall path) --------------------------
  const pinnedLatencies: number[] = [];
  await storm(
    needleQueries.slice(0, Math.min(200, needleQueries.length)).map((q) => async () => {
      const qs = performance.now();
      await engine.search(q.query, { limit: 10, shard: q.expectedShards[0], strict: true });
      pinnedLatencies.push(performance.now() - qs);
    }),
    50,
  );
  pinnedLatencies.sort((a, b) => a - b);
  const pinnedP50 = percentile(pinnedLatencies, 50);
  console.log(`[pinned] in-shard p50: ${fmt(pinnedP50)} ms (${pinnedLatencies.length} queries @ 50-way)`);

  // ---- context assembly --------------------------------------------------------
  const sample = needleQueries[0];
  const sampleRes = await engine.search(sample.query, { limit: 8, strict: true });
  const ctx = assembleContext(sampleRes.hits, { maxTokens: 1024 });
  if (ctx.blocks.length === 0 || ctx.tokensUsed > 1024) {
    throw new Error(`context assembly broken: blocks=${ctx.blocks.length} tokens=${ctx.tokensUsed}`);
  }
  console.log(
    `[rag] context for "${sample.query}": ${ctx.blocks.length} blocks, ~${ctx.tokensUsed} tokens` +
      `\n      ${ctx.blocks[0].header}`,
  );

  // ---- rolling outbox drain ------------------------------------------------------
  const ts = performance.now();
  let rounds = 0;
  let merged = 0;
  for (;;) {
    const r = await engine.syncNow();
    merged += r.merged;
    rounds++;
    if (r.shards === 0) break;
    if (rounds > 50) throw new Error('org outbox failed to drain');
  }
  console.log(`[sync] drained: ${fmt(merged)} merges over ${rounds} rounds in ${fmt(performance.now() - ts)} ms`);

  const orgStats = await engine.stats();
  console.log(
    `[org] ${orgStats.shards} shards, ${fmt(orgStats.totalAtoms)} atoms, pool opens=${orgStats.pool.opens} ` +
      `evictions=${orgStats.pool.evictions}`,
  );

  // ---- verdict --------------------------------------------------------------------
  const checks: [string, boolean, string][] = [
    ['needle recall@10', needleRecall >= GATES.needleRecall, `${(needleRecall * 100).toFixed(2)}% ≥ ${GATES.needleRecall * 100}%`],
    ['cross-shard recall@20', crossRecall >= GATES.crossShardRecall, `${(crossRecall * 100).toFixed(2)}% ≥ ${GATES.crossShardRecall * 100}%`],
    ['router candidate recall', routerRecall >= GATES.routerRecall, `${(routerRecall * 100).toFixed(2)}% ≥ ${GATES.routerRecall * 100}%`],
    ['no-answer abstention', abstention >= GATES.abstention, `${(abstention * 100).toFixed(1)}% = 100%`],
  ];
  if (!RECALL_ONLY) {
    checks.push(
      ['pinned in-shard p50', pinnedP50 <= GATES.pinnedP50Ms, `${fmt(pinnedP50)} ms ≤ ${GATES.pinnedP50Ms} ms`],
      ['federated p95', fedP95 <= GATES.federatedP95Ms, `${fmt(fedP95)} ms ≤ ${GATES.federatedP95Ms} ms`],
    );
  } else {
    console.log(
      `  · latency (reported, not gated under --recall-only): pinned p50 ${fmt(pinnedP50)} ms, federated p95 ${fmt(fedP95)} ms`,
    );
  }

  mkdirSync(dirname(REPORT), { recursive: true });
  writeFileSync(
    REPORT,
    JSON.stringify(
      {
        shards: SHARDS,
        docsPerShard: DOCS_PER_SHARD,
        atoms,
        queries: QUERIES,
        concurrency: CONCURRENCY,
        ingestMs: Math.round(ingestMs),
        metrics: {
          needleRecall,
          crossShardRecall: crossRecall,
          routerRecall,
          abstention,
          pinnedP50Ms: pinnedP50,
          federatedP50Ms: fedP50,
          federatedP95Ms: fedP95,
        },
        latencyHistogramMs: {
          p50: fedP50,
          p75: percentile(fedLatencies, 75),
          p90: percentile(fedLatencies, 90),
          p95: fedP95,
          p99: percentile(fedLatencies, 99),
          max: fedLatencies[fedLatencies.length - 1] ?? 0,
        },
        gates: GATES,
        verdicts: Object.fromEntries(checks.map(([name, ok]) => [name, ok ? 'PASS' : 'FAIL'])),
      },
      null,
      2,
    ),
  );
  await engine.close();

  const failed = checks.filter(([, ok]) => !ok);
  for (const [name, ok, detail] of checks) {
    console.log(`  ${ok ? '✓' : '✗'} ${name}: ${detail}`);
  }
  if (failed.length > 0) {
    console.error(`\nFAIL: ${failed.length}/${checks.length} gates violated.`);
    process.exit(1);
  }
  console.log(`\nPASS: all ${checks.length} org-scale gates met at ${SHARDS} shards / ${fmt(atoms)} atoms.\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
