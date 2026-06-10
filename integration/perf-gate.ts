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
 * Per-runner baselines (.plans/perf-gates/01): the bands assume the gated
 * run shares hardware with the baseline. The gate derives a runner class
 * from the env fingerprint (`<platform>-<arch>-<cores>c`, e.g.
 * `linux-x64-4c`) and prefers a class-specific baseline
 * `perf-baseline.<class>.json` next to --baseline when present, falling
 * back to the default. `--update-baseline` writes the class-specific file
 * (never clobbers the committed default). Pin a runner with
 * `make perf-rebaseline` ON that runner; override the class with
 * `--runner-class <name>` or `PERF_RUNNER_CLASS`.
 *
 * Usage: node dist/integration/perf-gate.js
 *          [--baseline __test__/benchmark/perf-baseline.json]
 *          [--report reports/perf-report.json]
 *          [--update-baseline]      (writes the run as the class baseline)
 *          [--runner-class <name>]  (override the derived hardware class)
 *          [--print-runner-class]   (print the derived class and exit)
 *          [--tolerance 0.25]       (relative band, fraction)
 *          [--latency-floor 0.5]    (absolute ms floor for latency fields;
 *                                    also PERF_LATENCY_FLOOR — a latency
 *                                    metric fails only if it breaches BOTH
 *                                    the band AND this absolute movement,
 *                                    so sub-ms timer jitter can't trip it)
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { FederatedEngine } from '../dist/src/federated-engine.js';
import { MemoryEngine } from '../dist/src/engine.js';
import {
  captureEnv,
  classBaselinePath,
  compareToBaseline,
  deriveRunnerClass,
  hardwareMismatch,
  measureLatency,
  measureThroughput,
  renderDeltaTable,
  renderEnvComparison,
  renderEnvLine,
  type PerfEnv,
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
// Absolute noise floor (ms) for latency fields: a latency metric fails only
// when it breaches BOTH the relative band AND this absolute movement, so
// sub-millisecond timer jitter (e.g. 0.3→0.4ms p99 = +26%) can't trip the gate.
const LATENCY_FLOOR_MS = Number(arg('latency-floor', process.env.PERF_LATENCY_FLOOR ?? '0.5'));

/**
 * Short, stable hardware-class key for baseline selection. Precedence:
 * explicit `--runner-class` / `PERF_RUNNER_CLASS`, else derived as
 * `<platform>-<arch>-<cores>c`. Core count is part of the key because
 * parallel ingest and worker-pool churn scale with it — two boxes with
 * the same CPU but different core counts are not interchangeable
 * baselines. The full cpuModel stays in the report's env block for the
 * failure diff; it is intentionally kept out of the key (cloud SKU model
 * strings are noisy).
 */
function runnerClass(env: PerfEnv): string {
  const explicit = arg('runner-class', process.env.PERF_RUNNER_CLASS ?? '');
  return explicit || deriveRunnerClass(env);
}

async function main(): Promise<void> {
  const env = captureEnv();
  const cls = runnerClass(env);
  const classPath = classBaselinePath(BASELINE_PATH, cls);

  if (process.argv.includes('--print-runner-class')) {
    console.log(cls);
    return;
  }

  // Read against the class-specific baseline when one exists, else the
  // committed default. Always WRITE (on --update-baseline / first
  // establish) to the class path so re-baselining a runner never clobbers
  // the committed default.
  const readBaselinePath = existsSync(classPath) ? classPath : BASELINE_PATH;

  console.log(`\n=== perf-gate — seeded suite vs baselines (±${TOLERANCE * 100}%, ${LATENCY_FLOOR_MS}ms latency noise floor) ===`);
  console.log(`perf-gate: env ${renderEnvLine(env)}`);
  console.log(
    `perf-gate: runner-class=${cls} baseline=${readBaselinePath}` +
      `${readBaselinePath === classPath ? '' : ' (default fallback — run `make perf-rebaseline` on this runner to pin its class)'}\n`,
  );
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
    cores: env.cores,
    env,
    metrics,
  };
  mkdirSync(dirname(REPORT), { recursive: true });
  writeFileSync(REPORT, JSON.stringify(report, null, 2));

  if (UPDATE || !existsSync(readBaselinePath)) {
    // Establish/refresh the CLASS baseline for this runner — never the
    // committed default, so pinning a cloud runner is non-destructive.
    mkdirSync(dirname(classPath), { recursive: true });
    writeFileSync(classPath, JSON.stringify(report, null, 2));
    console.log(`\nbaseline ${UPDATE ? 'updated' : 'created'} for runner-class ${cls}: ${classPath}`);
    console.log(`PASS: perf baseline established (no comparison run).\n`);
    return;
  }

  const baseline = JSON.parse(readFileSync(readBaselinePath, 'utf8')) as PerfReport;
  console.log(
    `perf-gate: baseline generatedAt=${baseline.generatedAt} ` +
      `${baseline.env ? renderEnvLine(baseline.env) : `cores=${baseline.cores} (pre-env baseline — hardware unknown)`}`,
  );
  const cmp = compareToBaseline(metrics, baseline.metrics, TOLERANCE, LATENCY_FLOOR_MS);
  console.log(`\n${renderDeltaTable(cmp)}\n`);

  // On any failure, surface the baseline-vs-current environment so the log
  // alone shows whether this is a code regression or a different runner —
  // the perf bands assume identical hardware, and this gate is meant to run
  // unchanged across local + cloud CI.
  if (cmp.missing.length > 0 || cmp.failures.length > 0) {
    console.error(`\n${renderEnvComparison(baseline.env, env)}`);
    if (hardwareMismatch(baseline.env, env)) {
      const detail = baseline.env
        ? `baseline ran on ${baseline.env.cores}×"${baseline.env.cpuModel}", this run on ${env.cores}×"${env.cpuModel}"`
        : `the baseline predates env capture, so its hardware is unknown`;
      const pinned = readBaselinePath === classPath;
      console.error(
        `\nNOTE: hardware mismatch detected (${detail}).\n` +
          `      The ±${TOLERANCE * 100}% bands assume identical hardware, so a failure here may be a\n` +
          `      cloud-runner / CPU difference rather than a code regression — worker-pool cold-open\n` +
          `      (pool.lruChurnOpen) and parallel ingest are the most hardware-sensitive metrics.\n` +
          (pinned
            ? `      This runner-class (${cls}) IS pinned (${classPath}); a mismatch here means the\n` +
              `      baseline file was captured on different hardware than it claims — re-pin with\n` +
              `      \`make perf-rebaseline\` on this runner.`
            : `      Runner-class ${cls} is NOT pinned — comparing against the default fallback.\n` +
              `      Pin it by running \`make perf-rebaseline\` ON this runner (writes ${classPath}),\n` +
              `      then commit or CI-cache that file.`),
      );
    }
  }

  if (cmp.missing.length > 0) {
    console.error(`FAIL: metrics missing from this run: ${cmp.missing.join(', ')}`);
    process.exit(1);
  }
  if (cmp.failures.length > 0) {
    console.error(
      `FAIL: ${cmp.failures.length} metric(s) outside the ±${TOLERANCE * 100}% band: ` +
        `${cmp.failures.map((f) => `${f.metric}.${f.field}`).join(', ')}`,
    );
    process.exit(1);
  }
  console.log(`PASS: all ${cmp.deltas.length} perf checks within ±${TOLERANCE * 100}% of baseline.\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
