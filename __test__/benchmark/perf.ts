/**
 * IDEA.v2 §10.5 — deterministic performance benchmark harness.
 *
 * Seeded corpora, warmup rounds, steady-state sampling; emits
 * p50/p95/p99 + throughput JSON and compares against checked-in
 * baselines with ±tolerance bands (one-sided: a latency metric fails
 * only when slower, a throughput metric only when lower — being faster
 * is not a regression). This makes DEMO001 §1 "measured results, to
 * beat or match" executable and CI-gated.
 */
import { availableParallelism, arch as osArch, cpus, hostname, platform as osPlatform, totalmem } from 'node:os';

export interface LatencyMetric {
  kind: 'latency';
  unit: 'ms';
  p50: number;
  p95: number;
  p99: number;
  samples: number;
}

export interface ThroughputMetric {
  kind: 'throughput';
  unit: string; // 'atoms/s' | 'q/s' | 'merges/s' | ...
  value: number;
}

export type PerfMetric = LatencyMetric | ThroughputMetric;

/**
 * Hardware/runtime fingerprint of the host that produced a report. The
 * ±tolerance bands are only meaningful when baseline and current share
 * the same fingerprint, so a failing gate can prove — rather than leave
 * the reader to guess — whether a regression is in the code or just a
 * different runner. `env` is optional: baselines captured before env
 * capture was added carry only the legacy top-level `cores`.
 */
export interface PerfEnv {
  host: string;
  platform: string;
  arch: string;
  cpuModel: string;
  cores: number;
  memGB: number;
  nodeVersion: string;
  ci: boolean;
}

export interface PerfReport {
  generatedAt: string;
  /** legacy: superseded by env.cores; kept so pre-env baselines still parse */
  cores: number;
  env?: PerfEnv;
  metrics: Record<string, PerfMetric>;
}

/** Fingerprint the current host for the report's `env` block. */
export function captureEnv(): PerfEnv {
  const cpu = cpus();
  return {
    host: hostname(),
    platform: osPlatform(),
    arch: osArch(),
    cpuModel: cpu[0]?.model ?? 'unknown',
    cores: availableParallelism(),
    memGB: Math.round((totalmem() / 1e9) * 10) / 10,
    nodeVersion: process.version,
    ci: Boolean(
      process.env.CI ||
        process.env.GITHUB_ACTIONS ||
        process.env.GITLAB_CI ||
        process.env.BUILDKITE ||
        process.env.CIRCLECI,
    ),
  };
}

/**
 * True when the bands cannot be trusted because baseline and current ran
 * on different hardware (or the baseline predates env capture, so its
 * hardware is unknown). CPU model and core count are the two dimensions
 * that move the seeded perf suite the most — worker-pool cold-open and
 * parallel ingest are bound by them.
 */
export function hardwareMismatch(baseline: PerfEnv | undefined, current: PerfEnv): boolean {
  if (!baseline) return true;
  return baseline.cpuModel !== current.cpuModel || baseline.cores !== current.cores;
}

/**
 * Derived hardware-class key for per-runner baseline selection
 * (.plans/perf-gates/01). `<platform>-<arch>-<cores>c`, e.g.
 * `linux-x64-4c`. Core count is part of the key because parallel ingest
 * and worker-pool churn scale with it; cpuModel is deliberately excluded
 * (cloud SKU model strings are noisy). An explicit override is the
 * caller's concern — this is the pure default derivation.
 */
export function deriveRunnerClass(env: PerfEnv): string {
  return `${env.platform}-${env.arch}-${env.cores}c`;
}

/** Class-specific baseline path: perf-baseline.json -> perf-baseline.<class>.json */
export function classBaselinePath(base: string, cls: string): string {
  return base.replace(/\.json$/, `.${cls}.json`);
}

/** One-line env summary for the run header. */
export function renderEnvLine(env: PerfEnv): string {
  return `host=${env.host} ${env.platform}/${env.arch} cores=${env.cores} cpu="${env.cpuModel}" mem=${env.memGB}GB node=${env.nodeVersion} ci=${env.ci}`;
}

/**
 * Side-by-side baseline-vs-current env table, marking each row that
 * differs with `≠`. Printed on failure so the cause (code vs runner) is
 * visible in the log without re-running anything.
 */
export function renderEnvComparison(baseline: PerfEnv | undefined, current: PerfEnv): string {
  const row = (label: string, b: unknown, c: unknown): string => {
    const bs = b === undefined ? 'n/a' : String(b);
    const cs = String(c);
    const flag = bs === cs ? ' ' : '≠';
    return `  ${flag} ${label.padEnd(9)} baseline=${bs.padStart(24)}   current=${cs.padStart(24)}`;
  };
  const b = baseline;
  return [
    'environment (baseline vs this run):',
    row('host', b?.host, current.host),
    row('cpu', b?.cpuModel, current.cpuModel),
    row('cores', b?.cores, current.cores),
    row('mem(GB)', b?.memGB, current.memGB),
    row('platform', b ? `${b.platform}/${b.arch}` : undefined, `${current.platform}/${current.arch}`),
    row('node', b?.nodeVersion, current.nodeVersion),
    row('ci', b?.ci, current.ci),
  ].join('\n');
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

export interface MeasureOptions {
  warmup?: number;
  samples?: number;
  /** concurrent invocations per sampling round (storm shape) */
  concurrency?: number;
}

/** sample fn() latencies after warmup; returns a latency metric */
export async function measureLatency(
  fn: () => Promise<unknown>,
  opts: MeasureOptions = {},
): Promise<LatencyMetric> {
  const warmup = opts.warmup ?? 5;
  const samples = opts.samples ?? 50;
  const concurrency = opts.concurrency ?? 1;
  for (let i = 0; i < warmup; i++) await fn();

  const latencies: number[] = [];
  let issued = 0;
  const worker = async () => {
    while (issued < samples) {
      issued++;
      const t0 = performance.now();
      await fn();
      latencies.push(performance.now() - t0);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, samples) }, worker));
  latencies.sort((a, b) => a - b);
  return {
    kind: 'latency',
    unit: 'ms',
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99),
    samples: latencies.length,
  };
}

/** time one batch operation; returns units/second */
export async function measureThroughput(
  unit: string,
  fn: () => Promise<number>,
): Promise<ThroughputMetric> {
  const t0 = performance.now();
  const units = await fn();
  const seconds = (performance.now() - t0) / 1000;
  return { kind: 'throughput', unit, value: seconds > 0 ? units / seconds : units };
}

// ---- baseline comparison ---------------------------------------------------

export interface BaselineDelta {
  metric: string;
  field: string;
  baseline: number;
  current: number;
  /** +12.3 means 12.3% worse-direction movement */
  deltaPct: number;
  withinBand: boolean;
  /**
   * True when the relative band WAS exceeded but the absolute worse-direction
   * movement stayed within the latency noise floor, so the metric passes on
   * floor grounds. Lets the delta table explain why a big-looking percentage
   * (e.g. +26% on a 0.3ms→0.4ms p99) did not fail the gate.
   */
  noiseFloored?: boolean;
}

export interface BaselineComparison {
  deltas: BaselineDelta[];
  failures: BaselineDelta[];
  /** metrics present in the baseline but missing from the run (failures) */
  missing: string[];
  /** metrics in the run with no baseline yet (informational) */
  unbaselined: string[];
}

/**
 * One-sided tolerance comparison. Latency fields (p50/p95/p99) regress
 * upward; throughput regresses downward. `tolerance` 0.25 = ±25% band.
 *
 * `latencyFloorMs` is an absolute noise floor for latency fields: at
 * sub-millisecond magnitudes the percentage band is dominated by timer
 * and scheduling jitter (a 0.3ms→0.4ms p99 reads +26% but is ~0.1ms of
 * noise), so a latency field counts as out-of-band only when it exceeds
 * BOTH the relative tolerance AND this absolute movement. The floor scales
 * nothing: on a multi-millisecond metric it is negligible, so real
 * regressions there are still caught by the relative band. Throughput is
 * unaffected (its values are far from any timer floor).
 */
export function compareToBaseline(
  current: Record<string, PerfMetric>,
  baseline: Record<string, PerfMetric>,
  tolerance = 0.25,
  latencyFloorMs = 0.5,
): BaselineComparison {
  const deltas: BaselineDelta[] = [];
  const missing: string[] = [];
  const unbaselined = Object.keys(current).filter((k) => !(k in baseline));

  for (const [name, base] of Object.entries(baseline)) {
    const cur = current[name];
    if (!cur || cur.kind !== base.kind) {
      missing.push(name);
      continue;
    }
    if (base.kind === 'latency' && cur.kind === 'latency') {
      for (const field of ['p50', 'p95', 'p99'] as const) {
        const b = base[field];
        const c = cur[field];
        if (b <= 0) continue;
        const deltaPct = ((c - b) / b) * 100; // positive = slower = worse
        const withinRel = c <= b * (1 + tolerance);
        const withinFloor = c - b <= latencyFloorMs; // absolute worse-direction movement
        deltas.push({
          metric: name,
          field,
          baseline: b,
          current: c,
          deltaPct,
          withinBand: withinRel || withinFloor,
          noiseFloored: !withinRel && withinFloor,
        });
      }
    } else if (base.kind === 'throughput' && cur.kind === 'throughput') {
      const deltaPct = ((base.value - cur.value) / base.value) * 100; // positive = lower = worse
      deltas.push({
        metric: name,
        field: 'value',
        baseline: base.value,
        current: cur.value,
        deltaPct,
        withinBand: cur.value >= base.value * (1 - tolerance),
      });
    }
  }
  return { deltas, failures: deltas.filter((d) => !d.withinBand), missing, unbaselined };
}

export function renderDeltaTable(cmp: BaselineComparison): string {
  const rows = cmp.deltas.map((d) => {
    const flag = d.withinBand ? ' ' : '✗';
    const sign = d.deltaPct >= 0 ? '+' : '';
    // deltaPct is signed in the worse direction: positive = regressed.
    // Only annotate the rows that matter so the log isn't a wall of
    // "(worse-direction)" on metrics that actually held or improved.
    const note = !d.withinBand
      ? '  <-- OUT OF BAND (worse-direction)'
      : d.noiseFloored
        ? `  (within noise floor; +${d.deltaPct.toFixed(1)}% but ${(d.current - d.baseline).toFixed(2)}ms abs)`
        : d.deltaPct < 0
          ? '  (better)'
          : '';
    return `${flag} ${d.metric}.${d.field.padEnd(5)} base=${d.baseline.toFixed(1).padStart(10)}  cur=${d.current
      .toFixed(1)
      .padStart(10)}  Δ ${sign}${d.deltaPct.toFixed(1)}%${note}`;
  });
  return rows.join('\n');
}
