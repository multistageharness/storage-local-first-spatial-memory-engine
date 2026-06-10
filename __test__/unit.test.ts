/**
 * Unit tests for the pure modules: chunker, router, query builder, CRDT helpers.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkText } from '../src/spatial/chunker.js';
import { ClusterRouter, GENERAL_CLUSTER } from '../src/spatial/router.js';
import { sanitizeFtsQuery, buildSearchSql } from '../src/search/query.js';
import { createAtomBlob, diffUpdate, mergeBlobs, readAtomFields } from '../src/sync/crdt.js';

// ---- chunker (Task 2.2.1) ---------------------------------------------

test('chunker: 800-char chunks with 100-char overlap', () => {
  const text = 'x'.repeat(2000);
  const chunks = chunkText(text);
  assert.equal(chunks[0].text.length, 800);
  assert.equal(chunks[0].start, 0);
  assert.equal(chunks[1].start, 700); // 800 - 100 overlap
  assert.equal(chunks[2].start, 1400);
  const last = chunks[chunks.length - 1];
  assert.equal(last.end, 2000);
});

test('chunker: text shorter than one chunk → single verbatim chunk', () => {
  const chunks = chunkText('hello world');
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].text, 'hello world');
});

test('chunker: empty text → no chunks', () => {
  assert.deepEqual(chunkText(''), []);
});

test('chunker: overlap preserves boundary-straddling identifiers', () => {
  const id = 'calculateTotalPrice';
  const text = 'a'.repeat(800 - 10) + id + 'b'.repeat(500);
  const chunks = chunkText(text);
  assert.ok(chunks.some((c) => c.text.includes(id)), 'identifier must survive in some chunk');
});

// ---- router (Feature 2.1) ---------------------------------------------

const CLUSTERS = [
  { name: 'auth', keywords: ['login', 'password', 'token', 'session'] },
  { name: 'billing', keywords: ['invoice', 'payment', 'stripe', 'charge'] },
];

test('router: keyword density routes deterministically', () => {
  const router = new ClusterRouter(CLUSTERS);
  const r = router.route('the login flow validates the password and issues a session token');
  assert.equal(r.cluster, 'auth');
  // determinism: identical input → identical output
  assert.deepEqual(router.route('the login flow validates the password and issues a session token'), r);
});

test('router: falls back to general when no threshold met (Task 2.1.2)', () => {
  const router = new ClusterRouter(CLUSTERS);
  const r = router.route('completely unrelated text about gardening and weather patterns today');
  assert.equal(r.cluster, GENERAL_CLUSTER);
});

test('router: no clusters defined → general', () => {
  const router = new ClusterRouter([]);
  assert.equal(router.route('anything at all').cluster, GENERAL_CLUSTER);
});

// ---- FTS5 query builder (Feature 3.2) ----------------------------------

test('sanitizeFtsQuery: quotes terms, drops sub-trigram terms', () => {
  assert.equal(sanitizeFtsQuery('calculateTotalPrice'), '"calculateTotalPrice"');
  assert.equal(sanitizeFtsQuery('foo ab bar'), '"foo" "bar"'); // 'ab' < 3 chars dropped
  assert.equal(sanitizeFtsQuery('ab x'), null);
  assert.equal(sanitizeFtsQuery('say "hi" loud'), '"say" """hi""" "loud"');
});

test('buildSearchSql: bm25 weighting and filters present', () => {
  const sql = buildSearchSql({ graphId: 1, clusterId: 2 });
  assert.match(sql, /bm25\(nodes_fts, @titleWeight, @bodyWeight\)/);
  assert.match(sql, /n\.graph_id = @graphId/);
  assert.match(sql, /n\.cluster_id = @clusterId/);
  assert.match(sql, /ORDER BY score ASC/);
});

// ---- CRDT helpers (Phase 4) --------------------------------------------

test('crdt: blob round-trip preserves verbatim fields', () => {
  const blob = createAtomBlob({ title: 'T', body: 'const x = 1;', originFile: 'a.ts' });
  const fields = readAtomFields(blob);
  assert.equal(fields.title, 'T');
  assert.equal(fields.body, 'const x = 1;');
  assert.equal(fields.originFile, 'a.ts');
});

test('crdt: merge is order-independent (conflict-free)', () => {
  const base = createAtomBlob({ title: 'T', body: 'v1' });
  const upA = diffUpdate(base, { title: 'T-renamed' });
  const upB = diffUpdate(base, { body: 'v2' });
  const ab = readAtomFields(mergeBlobs([base, upA, upB]));
  const ba = readAtomFields(mergeBlobs([base, upB, upA]));
  assert.deepEqual(ab, ba);
  assert.equal(ab.title, 'T-renamed');
  assert.equal(ab.body, 'v2');
});
