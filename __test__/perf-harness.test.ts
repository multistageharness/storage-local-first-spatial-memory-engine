/**
 * IDEA.v2 §10.5 — perf harness internals: percentile math vs a known
 * distribution, baseline comparison logic, tolerance-band edge cases.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classBaselinePath,
  compareToBaseline,
  deriveRunnerClass,
  measureLatency,
  percentile,
  renderDeltaTable,
  type PerfEnv,
  type PerfMetric,
} from './benchmark/perf.js';

test('percentile: known distribution', () => {
  const sorted = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
  assert.equal(percentile(sorted, 50), 50);
  assert.equal(percentile(sorted, 95), 95);
  assert.equal(percentile(sorted, 99), 99);
  assert.equal(percentile(sorted, 100), 100);
  assert.equal(percentile([], 50), 0);
  assert.equal(percentile([7], 95), 7);
});

test('measureLatency: sample count honored, monotone percentiles', async () => {
  const m = await measureLatency(async () => new Promise((r) => setTimeout(r, 1)), {
    warmup: 1,
    samples: 12,
  });
  assert.equal(m.samples, 12);
  assert.ok(m.p50 <= m.p95);
  assert.ok(m.p95 <= m.p99);
  assert.ok(m.p50 >= 0.5, 'sleep(1ms) cannot complete instantly');
});

const lat = (p50: number, p95: number, p99: number): PerfMetric => ({
  kind: 'latency',
  unit: 'ms',
  p50,
  p95,
  p99,
  samples: 10,
});
const thr = (value: number): PerfMetric => ({ kind: 'throughput', unit: 'x/s', value });

test('baseline: latency regression beyond band fails, improvement never does', () => {
  const baseline = { q: lat(10, 20, 30) };
  // exactly at the +25% edge → within band
  const atEdge = compareToBaseline({ q: lat(12.5, 25, 37.5) }, baseline, 0.25);
  assert.equal(atEdge.failures.length, 0);
  // beyond the edge on one field → that field fails
  const over = compareToBaseline({ q: lat(12.6, 20, 30) }, baseline, 0.25);
  assert.equal(over.failures.length, 1);
  assert.equal(over.failures[0].field, 'p50');
  // 10× faster → zero failures (one-sided band)
  const faster = compareToBaseline({ q: lat(1, 2, 3) }, baseline, 0.25);
  assert.equal(faster.failures.length, 0);
});

test('baseline: sub-ms latency jitter within the noise floor passes despite a big %', () => {
  const baseline = { q: lat(0.1, 0.3, 0.3) };
  // 0.3 -> 0.4 p99 is +33% (beyond the 25% band) but only 0.1ms absolute,
  // which is under the default 0.5ms floor → no failure, flagged noiseFloored.
  const cmp = compareToBaseline({ q: lat(0.1, 0.3, 0.4) }, baseline, 0.25, 0.5);
  assert.equal(cmp.failures.length, 0, 'sub-ms jitter must not fail the gate');
  const p99 = cmp.deltas.find((d) => d.field === 'p99')!;
  assert.ok(p99.deltaPct > 25, 'relative band IS exceeded');
  assert.equal(p99.noiseFloored, true, 'but it passes on the absolute floor');
  // the delta table explains why the big % did not fail
  assert.ok(renderDeltaTable(cmp).includes('within noise floor'));
});

test('baseline: a real regression above the floor still fails', () => {
  const baseline = { q: lat(2, 4, 8) };
  // p99 8 -> 10 is +25%? exactly at edge; push past: 8 -> 11 = +37.5%, +3ms abs
  const cmp = compareToBaseline({ q: lat(2, 4, 11) }, baseline, 0.25, 0.5);
  assert.equal(cmp.failures.length, 1);
  assert.equal(cmp.failures[0].field, 'p99');
  assert.notEqual(cmp.failures[0].noiseFloored, true);
});

test('baseline: throughput regression is the inverse direction', () => {
  const baseline = { ingest: thr(1000) };
  assert.equal(compareToBaseline({ ingest: thr(750) }, baseline, 0.25).failures.length, 0, 'at edge');
  assert.equal(compareToBaseline({ ingest: thr(749) }, baseline, 0.25).failures.length, 1, 'below edge');
  assert.equal(compareToBaseline({ ingest: thr(5000) }, baseline, 0.25).failures.length, 0, 'faster is fine');
});

test('baseline: missing and unbaselined metrics are surfaced', () => {
  const cmp = compareToBaseline({ newMetric: thr(5) }, { oldMetric: thr(5) }, 0.25);
  assert.deepEqual(cmp.missing, ['oldMetric']);
  assert.deepEqual(cmp.unbaselined, ['newMetric']);
});

test('baseline: kind mismatch counts as missing', () => {
  const cmp = compareToBaseline({ m: thr(5) }, { m: lat(1, 2, 3) }, 0.25);
  assert.deepEqual(cmp.missing, ['m']);
});

test('delta table renders worse-direction percentages', () => {
  const cmp = compareToBaseline({ q: lat(20, 20, 30) }, { q: lat(10, 20, 30) }, 0.25);
  const table = renderDeltaTable(cmp);
  assert.ok(table.includes('+100.0%'), 'doubling latency reads +100%');
  assert.ok(table.includes('✗'), 'violations are flagged');
});

const ENV = (over: Partial<PerfEnv> = {}): PerfEnv => ({
  host: 'h',
  platform: 'linux',
  arch: 'x64',
  cpuModel: 'Intel Xeon Platinum 8370C',
  cores: 4,
  memGB: 16,
  nodeVersion: 'v22.0.0',
  ci: true,
  ...over,
});

test('deriveRunnerClass: platform-arch-cores key', () => {
  assert.equal(deriveRunnerClass(ENV()), 'linux-x64-4c');
  assert.equal(deriveRunnerClass(ENV({ platform: 'darwin', arch: 'arm64', cores: 10 })), 'darwin-arm64-10c');
  // core count is part of the key — same CPU, different cores => different class
  assert.notEqual(deriveRunnerClass(ENV({ cores: 8 })), deriveRunnerClass(ENV({ cores: 4 })));
  // cpuModel is intentionally NOT part of the key (cloud SKU strings are noisy)
  assert.equal(deriveRunnerClass(ENV({ cpuModel: 'totally different cpu' })), deriveRunnerClass(ENV()));
});

test('classBaselinePath: inserts class before .json', () => {
  assert.equal(
    classBaselinePath('/a/b/perf-baseline.json', 'linux-x64-4c'),
    '/a/b/perf-baseline.linux-x64-4c.json',
  );
  // only the trailing .json is replaced
  assert.equal(classBaselinePath('x.json.json', 'c'), 'x.json.c.json');
});
