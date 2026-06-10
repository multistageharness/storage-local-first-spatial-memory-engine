/**
 * DEMO003 Feature 1 — Edge Type (typed relationships) over a real
 * temp-file engine. Covers add/list/delete, UNIQUE-upsert idempotency,
 * the intra-Graph firewall (cross-Graph edge rejected), node-delete
 * cascade (no dangling edges), neighbour direction/type filters, and the
 * opt-in edge-expansion retrieval lane.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryEngine } from '../src/engine.js';
import type { HybridSearchHit } from '../src/workers/protocol.js';

const dir = mkdtempSync(join(tmpdir(), 'sme-edges-'));
const dbPath = join(dir, 'edges.db');
const engine = await MemoryEngine.open({
  dbPath,
  graph: 'team-a',
  clusters: [{ name: 'auth', keywords: ['login', 'token', 'session'] }],
  minReaders: 2,
});

async function ingestOne(title: string, text: string): Promise<number> {
  const { nodeIds } = await engine.ingestDocument({ title, text });
  return nodeIds[0];
}

after(async () => {
  await engine.close();
  rmSync(dir, { recursive: true, force: true });
});

test('edges: add → neighbours (out) returns the typed, weighted target', async () => {
  const a = await ingestOne('a.ts', 'function login() { return session; }');
  const b = await ingestOne('b.ts', 'function refresh() { return token; }');
  const id = await engine.addEdge({ srcNodeId: a, dstNodeId: b, edgeType: 'references', weight: 2 });
  assert.ok(id > 0);

  const out = await engine.neighbors(a, { direction: 'out' });
  assert.equal(out.length, 1);
  assert.equal(out[0].nodeId, b);
  assert.equal(out[0].edgeType, 'references');
  assert.equal(out[0].weight, 2);
  assert.equal(out[0].direction, 'out');

  const inB = await engine.neighbors(b, { direction: 'in' });
  assert.equal(inB.length, 1);
  assert.equal(inB[0].nodeId, a);
  assert.equal(inB[0].direction, 'in');
});

test('edges: UNIQUE(src,dst,type) upsert is idempotent (refreshes weight)', async () => {
  const a = await ingestOne('c.ts', 'alpha');
  const b = await ingestOne('d.ts', 'bravo');
  const id1 = await engine.addEdge({ srcNodeId: a, dstNodeId: b, edgeType: 'mentions', weight: 1 });
  const id2 = await engine.addEdge({ srcNodeId: a, dstNodeId: b, edgeType: 'mentions', weight: 5 });
  assert.equal(id1, id2, 're-adding the same edge must not create a second row');
  const out = await engine.neighbors(a, { edgeType: 'mentions' });
  assert.equal(out.length, 1);
  assert.equal(out[0].weight, 5, 'weight must be refreshed in place');
});

test('edges: direction "both" and edgeType filter', async () => {
  const a = await ingestOne('e.ts', 'hub');
  const b = await ingestOne('f.ts', 'spoke1');
  const c = await ingestOne('g.ts', 'spoke2');
  await engine.addEdge({ srcNodeId: a, dstNodeId: b, edgeType: 'references' });
  await engine.addEdge({ srcNodeId: c, dstNodeId: a, edgeType: 'derived_from' });

  const both = await engine.neighbors(a, { direction: 'both' });
  assert.equal(both.length, 2);

  const onlyRef = await engine.neighbors(a, { direction: 'both', edgeType: 'references' });
  assert.equal(onlyRef.length, 1);
  assert.equal(onlyRef[0].nodeId, b);
});

test('edges: firewall — a cross-Graph edge is rejected, never stored', async () => {
  // a second Graph in the SAME shard file via a second engine
  const other = await MemoryEngine.open({ dbPath, graph: 'team-b', clusters: [], minReaders: 1 });
  try {
    const foreign = (await other.ingestDocument({ title: 'foreign.ts', text: 'secret' })).nodeIds[0];
    const local = await ingestOne('local.ts', 'local');
    await assert.rejects(
      () => engine.addEdge({ srcNodeId: local, dstNodeId: foreign, edgeType: 'references' }),
      /cross-Graph edge rejected|firewall/,
      'edge across the contextual firewall must throw',
    );
    const out = await engine.neighbors(local);
    assert.ok(!out.some((n) => n.nodeId === foreign), 'rejected edge must not be persisted');
  } finally {
    await other.close();
  }
});

test('edges: node delete cascades — no dangling edges', async () => {
  const a = await ingestOne('h.ts', 'keep');
  const b = await ingestOne('i.ts', 'drop');
  await engine.addEdge({ srcNodeId: a, dstNodeId: b, edgeType: 'references' });
  await engine.addEdge({ srcNodeId: b, dstNodeId: a, edgeType: 'mentions' });
  assert.equal((await engine.edgesOf(b)).length, 2);

  await engine.deleteNode(b);
  assert.equal((await engine.edgesOf(b)).length, 0, 'deleted node must drop its edges');
  assert.equal((await engine.edgesOf(a)).length, 0, 'edges pointing at the deleted node must be gone too');
});

test('edges: deleteEdge removes a single relationship', async () => {
  const a = await ingestOne('j.ts', 'x');
  const b = await ingestOne('k.ts', 'y');
  await engine.addEdge({ srcNodeId: a, dstNodeId: b, edgeType: 'references' });
  const { deleted } = await engine.deleteEdge(a, b, 'references');
  assert.equal(deleted, true);
  assert.equal((await engine.neighbors(a)).length, 0);
  const { deleted: again } = await engine.deleteEdge(a, b, 'references');
  assert.equal(again, false, 'deleting a missing edge reports false, does not throw');
});

test('edges: opt-in expansion surfaces a related Atom no lexical lane matched', async () => {
  // `hub` matches the query term; `related` deliberately does NOT.
  const hub = await ingestOne('hub.ts', 'function zephyrController() { init(); }');
  const related = await ingestOne('related.ts', 'helper that does plumbing with no shared words');
  await engine.addEdge({ srcNodeId: hub, dstNodeId: related, edgeType: 'references', weight: 1 });

  const plain: HybridSearchHit[] = await engine.hybridSearch('zephyrController', { limit: 10 });
  assert.ok(plain.some((h) => h.id === hub), 'hub must be found by the lexical lanes');
  assert.ok(!plain.some((h) => h.id === related), 'related has no matching term — absent by default');

  const expanded: HybridSearchHit[] = await engine.hybridSearch('zephyrController', {
    limit: 10,
    expand: { edgeType: 'references', direction: 'out' },
  });
  const relHit = expanded.find((h) => h.id === related);
  assert.ok(relHit, 'edge expansion must surface the related Atom');
  assert.deepEqual(relHit?.sources, ['edge'], 'expanded hit is tagged with edge provenance');
});

test('edges: expansion never drops or reorders the default-path winner', async () => {
  const hits = await engine.hybridSearch('zephyrController', { limit: 10 });
  const expanded = await engine.hybridSearch('zephyrController', {
    limit: 10,
    expand: { edgeType: 'references' },
  });
  assert.equal(expanded[0].id, hits[0].id, 'the top lexical hit stays on top — expansion only adds');
});
