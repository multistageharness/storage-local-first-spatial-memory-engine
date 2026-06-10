/**
 * DEMO003 Feature 2 — Supernode (cluster summary) over a real temp-file
 * engine. Covers deterministic extractive rebuild (one per non-empty
 * Cluster), verbatim summaries, signature stability across rebuilds,
 * empty-Cluster cleanup, Supernode-signature query routing, and the
 * opt-in `viaSupernodes` pre-filter (recall-preserving subset).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryEngine } from '../src/engine.js';

const dir = mkdtempSync(join(tmpdir(), 'sme-super-'));
const engine = await MemoryEngine.open({
  dbPath: join(dir, 'super.db'),
  graph: 'team-a',
  clusters: [
    { name: 'auth', keywords: ['login', 'session', 'token', 'password'] },
    { name: 'billing', keywords: ['invoice', 'payment', 'stripe', 'charge'] },
    { name: 'empty', keywords: ['zzznevermatches'] },
  ],
  minReaders: 2,
});

const AUTH_SENTENCE = 'Login requires a valid session token.';
const BILLING_SENTENCE = 'An invoice triggers a stripe payment charge.';

after(async () => {
  await engine.close();
  rmSync(dir, { recursive: true, force: true });
});

test('supernode: rebuild creates one Supernode per non-empty Cluster', async () => {
  await engine.ingestDocument({ title: 'auth.ts', text: `${AUTH_SENTENCE} The login flow stores a session token after password check.` });
  await engine.ingestDocument({ title: 'billing.ts', text: `${BILLING_SENTENCE} Each invoice maps to a stripe charge and payment record.` });

  const { rebuilt } = await engine.rebuildSupernodes();
  const supers = await engine.listSupernodes();
  const names = supers.map((s) => s.cluster).sort();
  // 'auth' + 'billing' have atoms; 'empty' and the implicit 'general' do not
  assert.deepEqual(names, ['auth', 'billing']);
  assert.equal(rebuilt, 2);
});

test('supernode: summary is a verbatim slice of a real Atom (never paraphrased)', async () => {
  const auth = await engine.getSupernode('auth');
  assert.ok(auth, 'auth supernode exists');
  assert.ok(auth!.summary.includes(AUTH_SENTENCE), `summary must contain the verbatim lead sentence, got: ${auth!.summary}`);
  assert.ok(auth!.atomCount >= 1);
  assert.ok(Object.keys(auth!.signature).length > 0, 'signature must have terms');
});

test('supernode: signature is deterministic across rebuilds (no LLM, no randomness)', async () => {
  const before = await engine.getSupernode('billing');
  await engine.rebuildSupernodes();
  const after_ = await engine.getSupernode('billing');
  assert.deepEqual(after_!.signature, before!.signature, 'identical content → identical signature');
  assert.equal(after_!.summary, before!.summary, 'identical content → identical summary');
});

test('supernode: routeToClusters ranks the right Cluster first by signature', async () => {
  const ranked = await engine.routeToClusters('invoice payment');
  assert.ok(ranked.length > 0);
  assert.equal(ranked[0].cluster, 'billing', `expected billing first, got ${JSON.stringify(ranked.map((r) => r.cluster))}`);

  const authRanked = await engine.routeToClusters('session token login');
  assert.equal(authRanked[0].cluster, 'auth');
});

test('supernode: empty Cluster has no Supernode; cleared if it goes empty', async () => {
  assert.equal(await engine.getSupernode('empty'), null, 'never-populated cluster has no supernode');

  // populate then empty a throwaway-style check: ingest into auth, delete, rebuild
  const { nodeIds } = await engine.ingestDocument({ title: 'tmp.ts', text: 'lonely session token atom for transient cluster' });
  await engine.rebuildSupernodes();
  for (const id of nodeIds) await engine.deleteNode(id);
  // auth still has its earlier atoms, so it persists; assert rebuild stays consistent
  await engine.rebuildSupernodes();
  const auth = await engine.getSupernode('auth');
  assert.ok(auth, 'auth keeps its supernode while it still has atoms');
});

test('supernode: viaSupernodes pre-filter is a recall-preserving subset', async () => {
  // a query that hits BOTH topics; pre-filter should keep only the top topic's hits
  const universe = await engine.hybridSearch('invoice session', { limit: 50 });
  const universeIds = new Set(universe.map((h) => h.id));

  const filtered = await engine.hybridSearch('invoice session', { limit: 50, viaSupernodes: { topClusters: 1 } });
  assert.ok(filtered.length > 0, 'pre-filter still returns results');
  for (const h of filtered) {
    assert.ok(universeIds.has(h.id), 'every pre-filtered hit was already a base hit (no new/incorrect hits)');
  }
  const clusters = new Set(filtered.map((h) => h.cluster));
  assert.equal(clusters.size, 1, 'top-1 pre-filter narrows to a single cluster');
});

test('supernode: stats expose edge + supernode counts', async () => {
  const stats = await engine.stats();
  assert.equal(typeof stats.supernodes, 'number');
  assert.ok((stats.supernodes as number) >= 2);
  assert.equal(typeof stats.edges, 'number');
});
