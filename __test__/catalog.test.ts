/**
 * IDEA.v2 §6.1/§6.4 — catalog: shard upsert/status transitions,
 * checkpoint persist/restore, routing_terms recompute + FTS mirror,
 * ingest_queue restart-safety + per-shard claim serialization,
 * replica state vectors.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Catalog, SPLIT_ATOM_THRESHOLD } from '../src/federation/catalog.js';

const dir = mkdtempSync(join(tmpdir(), 'sme-catalog-'));
const catalog = Catalog.open(join(dir, 'catalog.db'));

after(() => {
  catalog.close();
  rmSync(dir, { recursive: true, force: true });
});

test('ensureShard: insert + idempotent upsert preserves clusters', () => {
  const a = catalog.ensureShard({
    shardKey: 'gh:acme/payments',
    kind: 'repo',
    dbPath: join(dir, 'a.db'),
    displayName: 'acme/payments',
    clusters: [{ name: 'src', keywords: ['payment', 'invoice'] }],
  });
  assert.equal(a.shardKey, 'gh:acme/payments');
  assert.equal(a.status, 'ACTIVE');
  assert.equal(a.clusters.length, 1);

  // re-ensure without clusters must not clobber them
  const b = catalog.ensureShard({ shardKey: 'gh:acme/payments', kind: 'repo', dbPath: join(dir, 'a.db') });
  assert.equal(b.id, a.id);
  assert.equal(b.clusters.length, 1);
});

test('shard status transitions + listShards filter', () => {
  catalog.ensureShard({ shardKey: 'cf:ENG', kind: 'space', dbPath: join(dir, 'b.db') });
  catalog.setShardStatus('cf:ENG', 'INGESTING');
  assert.equal(catalog.getShard('cf:ENG')!.status, 'INGESTING');
  assert.ok(catalog.listShards({ status: 'INGESTING' }).some((s) => s.shardKey === 'cf:ENG'));
  catalog.setShardStatus('cf:ENG', 'ACTIVE');
});

test('updateShardStats: split signal past the atom threshold (advisory)', () => {
  catalog.ensureShard({ shardKey: 'syn:big', kind: 'synthetic', dbPath: join(dir, 'big.db') });
  const ok = catalog.updateShardStats('syn:big', { atomCount: 1000, docCount: 10, bytes: 1024 });
  assert.equal(ok.split, false);
  const split = catalog.updateShardStats('syn:big', {
    atomCount: SPLIT_ATOM_THRESHOLD + 1,
    docCount: 10,
    bytes: 1024,
  });
  assert.equal(split.split, true);
  assert.equal(catalog.getShard('syn:big')!.status, 'SPLIT');
});

test('routing terms: set + FTS mirror rank, recompute applies cross-shard IDF', () => {
  catalog.ensureShard({ shardKey: 'syn:r1', kind: 'synthetic', dbPath: join(dir, 'r1.db') });
  catalog.ensureShard({ shardKey: 'syn:r2', kind: 'synthetic', dbPath: join(dir, 'r2.db') });
  catalog.setRoutingTerms('syn:r1', ['kafka', 'consumer', 'offset']);
  catalog.setRoutingTerms('syn:r2', ['terraform', 'provider', 'offset']);

  const hits = catalog.searchShardTerms('kafka consumer');
  assert.ok(hits.length > 0);
  assert.equal(hits[0].shardKey, 'syn:r1');

  // 'offset' is in r2's recorded stats too → cross-shard df discounts it
  catalog.recordTermStats('syn:r2', new Map([['terraform', 5], ['offset', 5]]));
  const recomputed = catalog.recomputeRoutingTerms(
    'syn:r1',
    new Map([
      ['kafka', 10],
      ['offset', 10],
    ]),
    1,
  );
  assert.deepEqual(recomputed, ['kafka'], 'shared term loses to the distinctive term at equal tf');

  // refreshAllRoutingTerms settles every stats-bearing shard
  const refreshed = catalog.refreshAllRoutingTerms();
  assert.ok(refreshed >= 2);
});

test('checkpoints: persist + restore per (shard, connector)', () => {
  catalog.ensureShard({ shardKey: 'gh:acme/web', kind: 'repo', dbPath: join(dir, 'web.db') });
  assert.equal(catalog.getCheckpoint('gh:acme/web', 'git-org'), null);
  catalog.putCheckpoint('gh:acme/web', 'git-org', 'abc123');
  assert.equal(catalog.getCheckpoint('gh:acme/web', 'git-org'), 'abc123');
  catalog.putCheckpoint('gh:acme/web', 'git-org', 'def456'); // upsert
  assert.equal(catalog.getCheckpoint('gh:acme/web', 'git-org'), 'def456');
  // a different connector keeps its own cursor
  catalog.putCheckpoint('gh:acme/web', 'confluence', '{"watermark":"2026-01-01"}');
  assert.equal(catalog.getCheckpoint('gh:acme/web', 'git-org'), 'def456');
});

test('ingest_queue: dedup, per-shard claim serialization, completion', () => {
  catalog.ensureShard({ shardKey: 'syn:q1', kind: 'synthetic', dbPath: join(dir, 'q1.db') });
  catalog.ensureShard({ shardKey: 'syn:q2', kind: 'synthetic', dbPath: join(dir, 'q2.db') });

  const id1 = catalog.enqueue({ shardKey: 'syn:q1', task: 'full' });
  const dup = catalog.enqueue({ shardKey: 'syn:q1', task: 'full' });
  assert.equal(dup, id1, 'identical PENDING task dedupes');
  catalog.enqueue({ shardKey: 'syn:q1', task: 'delta' });
  catalog.enqueue({ shardKey: 'syn:q2', task: 'full', priority: 5 });

  // priority first
  const t1 = catalog.claimNext();
  assert.equal(t1!.shardKey, 'syn:q2');

  // q1/full claimed; q1/delta must NOT be claimable while q1 runs
  const t2 = catalog.claimNext();
  assert.equal(t2!.shardKey, 'syn:q1');
  assert.equal(t2!.task, 'full');
  const t3 = catalog.claimNext();
  assert.equal(t3, null, 'per-shard serialization: shard with RUNNING task is skipped');

  catalog.completeTask(t2!.id, true);
  const t4 = catalog.claimNext();
  assert.equal(t4!.shardKey, 'syn:q1');
  assert.equal(t4!.task, 'delta');
  catalog.completeTask(t4!.id, true);
  catalog.completeTask(t1!.id, false);
  assert.deepEqual(catalog.queueDepth(), { pending: 0, running: 0 });
});

test('ingest_queue: RUNNING tasks recover to PENDING on reopen (restart-safety)', () => {
  const dir2 = mkdtempSync(join(tmpdir(), 'sme-catalog-restart-'));
  const path = join(dir2, 'catalog.db');
  let cat = Catalog.open(path);
  cat.ensureShard({ shardKey: 'syn:crash', kind: 'synthetic', dbPath: join(dir2, 'c.db') });
  cat.enqueue({ shardKey: 'syn:crash', task: 'full' });
  const claimed = cat.claimNext();
  assert.ok(claimed);
  assert.equal(cat.queueDepth().running, 1);
  cat.close(); // simulated crash mid-task

  cat = Catalog.open(path);
  assert.deepEqual(cat.queueDepth(), { pending: 1, running: 0 });
  const reclaimed = cat.claimNext();
  assert.equal(reclaimed!.shardKey, 'syn:crash');
  cat.close();
  rmSync(dir2, { recursive: true, force: true });
});

test('replica vectors: ack upsert + list per graph', () => {
  catalog.ackReplicaVector('replica-a', 'syn:r1', new Uint8Array([1, 2, 3]));
  catalog.ackReplicaVector('replica-b', 'syn:r1', new Uint8Array([4, 5]));
  catalog.ackReplicaVector('replica-a', 'syn:r1', new Uint8Array([9, 9, 9])); // upsert
  const vectors = catalog.listReplicaVectors('syn:r1');
  assert.equal(vectors.length, 2);
  const a = vectors.find((v) => v.replicaId === 'replica-a')!;
  assert.deepEqual([...a.stateVector], [9, 9, 9]);
});
