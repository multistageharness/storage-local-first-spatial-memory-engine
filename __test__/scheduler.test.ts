/**
 * IDEA.v2 §6.4 — IngestScheduler over a live FederatedEngine:
 * per-shard serialization, backpressure at highWaterMark, queue
 * drain with restart-safe claims, split-signal reporting, plus the
 * FederatedEngine skeleton (ensureShard / engine / search / LRU pool).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FederatedEngine } from '../src/federated-engine.js';
import { buffered } from '../src/federation/scheduler.js';
import type { SourceDocumentInput } from '../src/engine.js';

const dir = mkdtempSync(join(tmpdir(), 'sme-sched-'));
const org = await FederatedEngine.open({
  rootDir: dir,
  maxOpenShards: 2, // tiny ceiling to exercise LRU eviction
  maxConcurrentShardIngests: 4,
  highWaterMark: 8,
});

after(async () => {
  await org.close();
  rmSync(dir, { recursive: true, force: true });
});

function docs(prefix: string, n: number): SourceDocumentInput[] {
  return Array.from({ length: n }, (_, i) => ({
    sourceKey: `${prefix}/doc-${i}.md`,
    title: `doc-${i}.md`,
    text: `${prefix} document ${i} marker ${prefix}Token${i} with searchable content.`,
  }));
}

test('ensureShard + ingest + per-shard engine + federated search round-trip', async () => {
  await org.ensureShard({ shardKey: 'syn:alpha', kind: 'synthetic', displayName: 'alpha' });
  await org.ensureShard({ shardKey: 'syn:beta', kind: 'synthetic', displayName: 'beta' });

  const repA = await org.ingest('syn:alpha', docs('alpha', 10));
  const repB = await org.ingest('syn:beta', docs('beta', 10));
  assert.equal(repA.docs, 10);
  assert.ok(repA.atoms >= 10);
  assert.equal(repA.skippedDocs, 0);
  assert.equal(repB.docs, 10);

  // re-ingest identical content → 100% hash-skip
  const again = await org.ingest('syn:alpha', docs('alpha', 10));
  assert.equal(again.skippedDocs, 10);
  assert.equal(again.atoms, 0);

  // pinned search via shard option
  const pinned = await org.search('alphaToken3', { shard: 'syn:alpha', strict: true });
  assert.ok(pinned.pinned);
  assert.ok(pinned.hits.length > 0);
  assert.equal(pinned.hits[0].shardKey, 'syn:alpha');

  // federated (no hint): routing signals direct to the right shard
  const fed = await org.search('betaToken7 document', { strict: true });
  assert.ok(fed.hits.some((h) => h.shardKey === 'syn:beta'));

  // full kernel API through engine()
  const engine = await org.engine('syn:alpha');
  const stats = await engine.stats();
  assert.equal(stats.documents, 10);
  org.releaseEngine('syn:alpha');
});

test('pool: LRU eviction under a 2-shard ceiling, evicted shards reopen transparently', async () => {
  await org.ensureShard({ shardKey: 'syn:gamma', kind: 'synthetic', displayName: 'gamma' });
  await org.ingest('syn:gamma', docs('gamma', 5));
  const stats = org.pool.stats();
  assert.ok(stats.open <= 2, `pool ceiling respected (open=${stats.open})`);
  assert.ok(stats.evictions > 0, 'evictions occurred under pressure');

  // all three shards still searchable (lazily reopened)
  for (const [key, marker] of [
    ['syn:alpha', 'alphaToken1'],
    ['syn:beta', 'betaToken1'],
    ['syn:gamma', 'gammaToken1'],
  ] as const) {
    const r = await org.search(marker, { shard: key, strict: true });
    assert.ok(r.hits.length > 0, `${key} reachable after eviction churn`);
  }
});

test('scheduler: per-shard serialization — concurrent ingests to one shard never interleave', async () => {
  await org.ensureShard({ shardKey: 'syn:serial', kind: 'synthetic', displayName: 'serial' });
  const events: string[] = [];
  const slowSource = (tag: string): AsyncIterable<SourceDocumentInput[]> => ({
    async *[Symbol.asyncIterator]() {
      events.push(`${tag}:start`);
      yield docs(`serial-${tag}`, 2);
      await new Promise((r) => setTimeout(r, 30));
      yield docs(`serial-${tag}-more`, 2);
      events.push(`${tag}:end`);
    },
  });
  await Promise.all([
    org.ingest('syn:serial', slowSource('one')),
    org.ingest('syn:serial', slowSource('two')),
  ]);
  const oneEnd = events.indexOf('one:end');
  const twoStart = events.indexOf('two:start');
  assert.ok(oneEnd !== -1 && twoStart !== -1);
  assert.ok(twoStart > oneEnd, `second ingest waited for the first (events: ${events.join(',')})`);
});

test('scheduler: backpressure pauses the source at highWaterMark', async () => {
  const HWM = 8;
  const BATCH = 4;
  let pulled = 0;
  let consumed = 0;
  let maxAhead = 0;
  const source: AsyncIterable<SourceDocumentInput[]> = {
    async *[Symbol.asyncIterator]() {
      for (let b = 0; b < 12; b++) {
        const batch = docs(`bp-${b}`, BATCH);
        pulled += batch.length;
        maxAhead = Math.max(maxAhead, pulled - consumed);
        yield batch;
      }
    },
  };
  // slow consumer over the exported prefetch wrapper — the producer must
  // stall once (pulled - consumed) reaches highWaterMark (+ one batch in
  // flight past the check)
  for await (const batch of buffered(source[Symbol.asyncIterator](), HWM)) {
    await new Promise((r) => setTimeout(r, 5));
    consumed += batch.length;
  }
  assert.equal(consumed, 48);
  assert.ok(
    maxAhead <= HWM + BATCH,
    `prefetch stayed within highWaterMark window (maxAhead=${maxAhead}, bound=${HWM + BATCH})`,
  );
  // and it actually prefetched ahead (overlap), not strict lock-step
  assert.ok(maxAhead > BATCH, `prefetch overlapped the consumer (maxAhead=${maxAhead})`);
});

test('scheduler: drainQueue executes queued tasks with bounded workers', async () => {
  for (const key of ['syn:qa', 'syn:qb', 'syn:qc']) {
    await org.ensureShard({ shardKey: key, kind: 'synthetic', displayName: key });
    org.catalog.enqueue({ shardKey: key, task: 'full' });
  }
  const ran: string[] = [];
  const { completed, failed } = await org.scheduler.drainQueue(async (task) => {
    ran.push(task.shardKey);
    await org.scheduler.ingestDocs(task.shardKey, docs(task.shardKey.replace(':', '-'), 3));
  });
  assert.equal(completed, 3);
  assert.equal(failed, 0);
  assert.deepEqual(ran.sort(), ['syn:qa', 'syn:qb', 'syn:qc']);
  assert.deepEqual(org.catalog.queueDepth(), { pending: 0, running: 0 });
});

test('scheduler: failing task is marked FAILED, queue keeps draining', async () => {
  await org.ensureShard({ shardKey: 'syn:bad', kind: 'synthetic', displayName: 'bad' });
  await org.ensureShard({ shardKey: 'syn:good', kind: 'synthetic', displayName: 'good' });
  org.catalog.enqueue({ shardKey: 'syn:bad', task: 'full' });
  org.catalog.enqueue({ shardKey: 'syn:good', task: 'full' });
  const { completed, failed } = await org.scheduler.drainQueue(async (task) => {
    if (task.shardKey === 'syn:bad') throw new Error('connector exploded');
    await org.scheduler.ingestDocs(task.shardKey, docs('good', 2));
  });
  assert.equal(completed, 1);
  assert.equal(failed, 1);
});

test('org stats rollup reflects catalog + pool + queue', async () => {
  const stats = await org.stats();
  assert.ok(stats.shards >= 8);
  assert.ok(stats.totalAtoms > 0);
  assert.ok(stats.totalDocs > 0);
  assert.ok(stats.pool.open <= stats.pool.maxOpenShards);
  assert.deepEqual(stats.queue, { pending: 0, running: 0 });
});
