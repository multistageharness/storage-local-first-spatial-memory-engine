/**
 * IDEA.v2 §5.3 — CRDT GC: compactAtom collapses history while
 * preserving materialized fields and bumping the epoch; stale-epoch
 * remote updates degrade to CONFLICT + remote.stale (never silent
 * merge); newer-epoch snapshots are adopted as the new baseline;
 * StabilityTracker frontier math; compactStable only collapses below
 * the all-replica frontier; post-GC replicas converge byte-identically.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Y from 'yjs';
import { MemoryEngine } from '../src/engine.js';
import { Catalog } from '../src/federation/catalog.js';
import { StabilityTracker } from '../src/federation/stability.js';

const dir = mkdtempSync(join(tmpdir(), 'sme-gc-'));
const engine = await MemoryEngine.open({
  dbPath: join(dir, 'gc.db'),
  graph: 'gc-graph',
  minReaders: 1,
});
const catalog = Catalog.open(join(dir, 'catalog.db'));

after(async () => {
  await engine.close();
  catalog.close();
  rmSync(dir, { recursive: true, force: true });
});

async function nodeWithHistory(rounds: number): Promise<number> {
  const { nodeIds } = await engine.ingestDocument({ title: 'gc.md', text: 'Initial body for GC testing.' });
  const nodeId = nodeIds[0];
  for (let i = 0; i < rounds; i++) {
    await engine.crdt.updateFields(nodeId, { body: `Edited body round ${i} — ${'x'.repeat(120)}` });
  }
  return nodeId;
}

test('compactAtom: collapses blob, preserves materialized fields, bumps epoch', async () => {
  const nodeId = await nodeWithHistory(30);
  const before = (await engine.getNode(nodeId)) as { body: string; epoch: number };
  const blobBefore = (await engine.crdt.load(nodeId))!;

  const result = await engine.compactAtom(nodeId);
  assert.equal(result.epoch, before.epoch + 1);
  assert.equal(result.bytesBefore, blobBefore.byteLength);
  assert.ok(result.bytesAfter < result.bytesBefore, `collapsed ${result.bytesBefore} → ${result.bytesAfter}`);

  const after_ = (await engine.getNode(nodeId)) as { body: string; epoch: number };
  assert.equal(after_.body, before.body, 'materialized fields preserved');
  assert.equal(after_.epoch, before.epoch + 1);

  // the fresh baseline still materializes identically from the blob
  const blobAfter = (await engine.crdt.load(nodeId))!;
  const doc = new Y.Doc();
  Y.applyUpdate(doc, blobAfter);
  assert.equal(doc.getMap('atom').get('body'), before.body);
});

test('compactAtoms: batched sweep honors maxBlobBytes + limit', async () => {
  const big1 = await nodeWithHistory(25);
  const big2 = await nodeWithHistory(25);
  const small = await nodeWithHistory(0);
  const threshold = 2_000;

  const { compacted } = await engine.compactAtoms({ maxBlobBytes: threshold, limit: 10 });
  const ids = compacted.map((c) => c.nodeId);
  assert.ok(ids.includes(big1) && ids.includes(big2), 'oversized blobs compacted');
  assert.ok(!ids.includes(small), 'small blob untouched');
  for (const c of compacted) assert.ok(c.bytesAfter < c.bytesBefore);
});

test('stale-epoch remote update → CONFLICT + remote.stale, never merged', async () => {
  const nodeId = await nodeWithHistory(3);
  await engine.compactAtom(nodeId); // local epoch now ≥ 1
  const localBody = ((await engine.getNode(nodeId)) as { body: string }).body;

  // a peer that never saw the compaction sends a pre-compaction edit
  const staleUpdate = (() => {
    const doc = new Y.Doc();
    doc.getMap('atom').set('body', 'STALE pre-compaction edit that must not merge');
    return Y.encodeStateAsUpdate(doc);
  })();
  const res = await engine.applyRemoteUpdate(nodeId, staleUpdate, 0);
  assert.equal(res.outcome, 'stale');

  const node = (await engine.getNode(nodeId)) as { body: string; syncStatus: string };
  assert.equal(node.syncStatus, 'CONFLICT', 'flagged for application review');
  assert.equal(node.body, localBody, 'local content untouched');

  // even after sync rounds the stale payload must NOT merge in
  await engine.syncNow();
  const after_ = (await engine.getNode(nodeId)) as { body: string };
  assert.ok(!after_.body.includes('STALE'), 'sync worker never merges remote.stale payloads');
});

test('newer-epoch snapshot is adopted as the new baseline (byte-identical convergence)', async () => {
  const nodeId = await nodeWithHistory(5);
  // simulate a peer that compacted ahead: fresh baseline doc, higher epoch
  const peerDoc = new Y.Doc();
  peerDoc.transact(() => {
    const m = peerDoc.getMap('atom');
    m.set('title', 'gc.md');
    m.set('body', 'Peer-compacted baseline body.');
  });
  const snapshot = Y.encodeStateAsUpdate(peerDoc);

  const res = await engine.applyRemoteUpdate(nodeId, snapshot, 99);
  assert.equal(res.outcome, 'adopted');
  const node = (await engine.getNode(nodeId)) as { body: string; epoch: number; syncStatus: string };
  assert.equal(node.body, 'Peer-compacted baseline body.');
  assert.equal(node.epoch, 99);
  const blob = (await engine.crdt.load(nodeId))!;
  assert.deepEqual([...blob], [...snapshot], 'post-GC replicas hold byte-identical blobs');
});

test('StabilityTracker: frontier = per-client minimum across all replicas', () => {
  const tracker = new StabilityTracker(catalog);
  const sv = (entries: [number, number][]) => {
    // encode a state vector via a map
    const m = new Map(entries);
    return Y.encodeStateVector(docWithVector(m));
  };
  // replica A saw client1@5, client2@9; replica B saw client1@3 only
  tracker.ack('replica-a', 'g1', sv([[1, 5], [2, 9]]));
  tracker.ack('replica-b', 'g1', sv([[1, 3]]));

  const frontier = tracker.stableFrontier('g1')!;
  assert.equal(frontier.get(1), 3, 'client1 clamped to the slowest replica');
  assert.equal(frontier.get(2) ?? 0, 0, 'client2 unseen by replica-b → unstable');

  assert.equal(StabilityTracker.isStable(new Map([[1, 3]]), frontier), true);
  assert.equal(StabilityTracker.isStable(new Map([[1, 4]]), frontier), false);
  assert.equal(StabilityTracker.isStable(new Map([[2, 1]]), frontier), false);
  assert.equal(tracker.stableFrontier('no-such-graph'), null, 'no replicas → nothing stable');
});

test('compactStable: collapses only below the all-replica acked frontier', async () => {
  const tracker = new StabilityTracker(catalog);
  const stableNode = await nodeWithHistory(4);
  const unstableNode = await nodeWithHistory(4);

  const stableBlob = (await engine.crdt.load(stableNode))!;
  const unstableBlob = (await engine.crdt.load(unstableNode))!;

  // both replicas acked everything in stableNode's history…
  const fullSv = Y.encodeStateVectorFromUpdate(stableBlob);
  tracker.ack('r1', 'g2', fullSv);
  tracker.ack('r2', 'g2', fullSv);
  // …but unstableNode's edits come from clients no replica acked
  const unstableSv = Y.decodeStateVector(Y.encodeStateVectorFromUpdate(unstableBlob));
  const frontier = tracker.stableFrontier('g2')!;
  assert.equal(StabilityTracker.isStable(unstableSv, frontier), false, 'fixture sanity');

  const epochBefore = ((await engine.getNode(stableNode)) as { epoch: number }).epoch;
  const { compacted, skipped } = await tracker.compactStable(engine, 'g2', {
    nodeIds: [stableNode, unstableNode],
  });
  assert.deepEqual(compacted, [stableNode]);
  assert.deepEqual(skipped, [unstableNode]);
  assert.equal(((await engine.getNode(stableNode)) as { epoch: number }).epoch, epochBefore + 1);
});

function docWithVector(target: Map<number, number>): Y.Doc {
  // build a doc whose state vector dominates the requested clocks by
  // generating that many ops per client id
  const doc = new Y.Doc();
  for (const [client, clock] of target) {
    const d = new Y.Doc();
    d.clientID = client; // pin the client id for deterministic vectors
    const arr = d.getArray('a');
    for (let i = 0; i < clock; i++) arr.push([i]);
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(d));
  }
  return doc;
}
