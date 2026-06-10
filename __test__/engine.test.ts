/**
 * Integration tests — full engine over a real temp-file database:
 * worker pool, pragmas, FTS5 trigger lifecycle, BM25 weighting,
 * CRDT saveAtomic dual-write, remote-update merge, sync rounds.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryEngine } from '../src/engine.js';
import { diffUpdate } from '../src/sync/crdt.js';
import type { SearchHit } from '../src/workers/protocol.js';

const dir = mkdtempSync(join(tmpdir(), 'sme-test-'));
const engine = await MemoryEngine.open({
  dbPath: join(dir, 'test.db'),
  graph: 'test-graph',
  clusters: [
    { name: 'auth', keywords: ['login', 'password', 'token', 'session'] },
    { name: 'billing', keywords: ['invoice', 'payment', 'stripe', 'charge'] },
  ],
  minReaders: 2,
});

after(async () => {
  await engine.close();
  rmSync(dir, { recursive: true, force: true });
});

test('pragmas: WAL journal mode active', async () => {
  const stats = await engine.stats();
  assert.equal(stats.journalMode, 'wal');
});

test('ingest: chunks routed by keyword density, FTS rows in lock-step', async () => {
  const res = await engine.ingestDocument({
    title: 'auth-service.ts',
    text: 'export function login(password: string) { const session = createToken(password); return session; }',
    originFile: 'src/auth-service.ts',
  });
  assert.equal(res.chunks, 1);
  assert.ok(res.clusters['auth'] === 1, `expected auth cluster, got ${JSON.stringify(res.clusters)}`);

  const stats = await engine.stats();
  assert.equal(stats.nodes, stats.ftsRows, 'FTS5 external-content index must match nodes 1:1');
});

test('search: camelCase substring match via trigram ("Token" in "createToken")', async () => {
  const hits = await engine.search('Token');
  assert.ok(hits.length > 0, 'trigram substring search must hit');
  assert.ok(hits[0].body.includes('createToken'));
});

test('search: title double-weighting ranks title hits first (Task 3.2.3)', async () => {
  await engine.ingestDocument({ title: 'paymentGateway.ts', text: 'function processInvoice(charge) { return stripe.create(charge); }' });
  await engine.ingestDocument({ title: 'unrelated.ts', text: 'paymentGateway is referenced here in the body only, deep in prose.' });
  const hits = await engine.search('paymentGateway', { limit: 5 });
  assert.ok(hits.length >= 2);
  assert.equal(hits[0].title, 'paymentGateway.ts', 'title match must outrank body match');
});

test('search: cluster scoping filters results', async () => {
  const all = await engine.search('payment');
  const billingOnly = await engine.search('payment', { cluster: 'billing' });
  assert.ok(billingOnly.length <= all.length);
  assert.ok(billingOnly.every((h: SearchHit) => h.cluster === 'billing'));
});

test('crdt: saveAtomic dual-write updates node + outbox atomically, FTS follows', async () => {
  const { nodeIds } = await engine.ingestDocument({ title: 'mutable.ts', text: 'const original = "needleAlpha";' });
  const nodeId = nodeIds[0];

  const base = await engine.crdt.load(nodeId);
  assert.ok(base instanceof Uint8Array);

  const update = diffUpdate(base, { body: 'const renamed = "needleBravo";' });
  const { version } = await engine.crdt.saveAtomic(nodeId, update);
  assert.equal(version, 2);

  // FTS5 AFTER UPDATE trigger must re-index: old term gone, new term findable
  const oldHits = await engine.search('needleAlpha');
  const newHits = await engine.search('needleBravo');
  assert.ok(!oldHits.some((h: SearchHit) => h.id === nodeId), 'stale term must be de-indexed');
  assert.ok(newHits.some((h: SearchHit) => h.id === nodeId), 'new term must be indexed');
});

test('sync: dirty outbox merges to SYNCED via background worker round', async () => {
  const before = await engine.stats();
  assert.ok((before.outboxDirty as number) > 0, 'ingests above must have left DIRTY events');

  const { merged } = await engine.syncNow();
  assert.ok(merged > 0);

  const after_ = await engine.stats();
  assert.equal(after_.outboxDirty, 0, 'all outbox events consumed');
});

test('sync: remote update merges conflict-free (no Last-Write-Wins)', async () => {
  const { nodeIds } = await engine.ingestDocument({ title: 'conflict.ts', text: 'const shared = "base";' });
  const nodeId = nodeIds[0];
  await engine.syncNow();

  const base = await engine.crdt.load(nodeId);
  // local edit: change body
  await engine.crdt.saveAtomic(nodeId, diffUpdate(base, { body: 'const shared = "localEdit";' }));
  // concurrent remote edit from the SAME base: change title
  await engine.applyRemoteUpdate(nodeId, diffUpdate(base, { title: 'conflict-renamed.ts' }));

  const node1 = (await engine.getNode(nodeId)) as { syncStatus: string };
  assert.equal(node1.syncStatus, 'CONFLICT');

  await engine.syncNow();
  const node2 = (await engine.getNode(nodeId)) as { syncStatus: string; title: string; body: string };
  assert.equal(node2.syncStatus, 'SYNCED');
  // both sides of the concurrent edit survive the mathematical merge
  assert.equal(node2.title, 'conflict-renamed.ts');
  assert.equal(node2.body, 'const shared = "localEdit";');
});

test('concurrency: parallel reads while writing do not error or block each other', async () => {
  const writes = Array.from({ length: 20 }, (_, i) =>
    engine.ingestDocument({ title: `doc-${i}.ts`, text: `function loadFixture${i}() { return ${i}; }` }),
  );
  const reads = Array.from({ length: 50 }, () => engine.search('loadFixture'));
  const [w, r] = await Promise.all([Promise.all(writes), Promise.all(reads)]);
  assert.equal(w.length, 20);
  assert.equal(r.length, 50);
});
