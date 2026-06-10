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

export interface PerfReport {
  generatedAt: string;
  cores: number;
  metrics: Record<string, PerfMetric>;
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
 */
export function compareToBaseline(
  current: Record<string, PerfMetric>,
  baseline: Record<string, PerfMetric>,
  tolerance = 0.25,
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
        deltas.push({ metric: name, field, baseline: b, current: c, deltaPct, withinBand: c <= b * (1 + tolerance) });
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
    return `${flag} ${d.metric}.${d.field.padEnd(5)} base=${d.baseline.toFixed(1).padStart(10)}  cur=${d.current
      .toFixed(1)
      .padStart(10)}  Δ ${sign}${d.deltaPct.toFixed(1)}% (worse-direction)`;
  });
  return rows.join('\n');
}
