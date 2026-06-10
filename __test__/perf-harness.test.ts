/**
 * IDEA.v2 §10.5 — perf harness internals: percentile math vs a known
 * distribution, baseline comparison logic, tolerance-band edge cases.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compareToBaseline,
  measureLatency,
  percentile,
  renderDeltaTable,
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
