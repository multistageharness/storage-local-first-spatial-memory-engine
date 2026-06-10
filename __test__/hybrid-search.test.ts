/**
 * IDEA.v2 §5.2 — hybrid retrieval: word-index sanitizer, dual-trigger
 * lock-step on BOTH FTS tables, trigram ∪ word RRF fusion ordering,
 * hybrid ≥ trigram-only recall property, HashingEmbedder determinism +
 * vector-lane fusion no-degradation.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryEngine } from '../src/engine.js';
import { sanitizeWordFtsQuery } from '../src/search/query.js';
import { HashingEmbedder, dot } from '../src/search/embedder.js';
import { rrfFuse } from '../src/search/rrf.js';
import { diffUpdate } from '../src/sync/crdt.js';

// ---- sanitizer (pure) ---------------------------------------------------

test('word sanitizer: no 3-char drop rule — short words survive', () => {
  assert.equal(sanitizeWordFtsQuery('it is ok'), '"it" "is" "ok"');
});

test('word sanitizer: terms ≥ 4 chars gain a prefix star', () => {
  assert.equal(sanitizeWordFtsQuery('paginate now'), '"paginate" * "now"');
});

test('word sanitizer: punctuation-edged identifiers prefix-expand on their token', () => {
  assert.equal(sanitizeWordFtsQuery('login()'), '"login" *');
  assert.equal(sanitizeWordFtsQuery('snake_case $v'), '"snake_case" * "$v"');
});

test('word sanitizer: nothing survivable → null', () => {
  assert.equal(sanitizeWordFtsQuery('   '), null);
  assert.equal(sanitizeWordFtsQuery('()'), null);
});

// ---- engine fixtures ----------------------------------------------------

const dir = mkdtempSync(join(tmpdir(), 'sme-hybrid-'));

const engine = await MemoryEngine.open({
  dbPath: join(dir, 'hybrid.db'),
  graph: 'hybrid-graph',
  minReaders: 1,
});

const vecEngine = await MemoryEngine.open({
  dbPath: join(dir, 'hybrid-vec.db'),
  graph: 'hybrid-vec-graph',
  minReaders: 1,
  vectors: 'local',
});

after(async () => {
  await engine.close();
  await vecEngine.close();
  rmSync(dir, { recursive: true, force: true });
});

const DOCS = [
  { title: 'totals.ts', text: 'export function calculateTotalPrice(cart: Cart): number { return cart.items.reduce(sumPrice, 0); }' },
  { title: 'pagination.md', text: 'Pagination strategy: cursor based pagination beats offset pagination for large result sets.' },
  { title: 'auth.md', text: 'Authentication uses short lived tokens; session renewal happens transparently on expiry.' },
  { title: 'deploy.md', text: 'Deployment pipeline ships artifacts to staging before production rollout begins.' },
];

for (const d of DOCS) {
  await engine.ingestDocument(d);
  await vecEngine.ingestDocument(d);
}

// ---- dual-index lock-step ------------------------------------------------

test('dual triggers: insert/update/delete keep BOTH fts tables in lock-step', async () => {
  const res = await engine.ingestDocument({ title: 'temp.md', text: 'Temporary doc with lockstepMarker_77 inside.' });
  let stats = await engine.stats();
  assert.equal(stats.ftsRows, stats.nodes);
  assert.equal(stats.ftsWordRows, stats.nodes);

  // update path: saveAtomic → UPDATE → nodes_au trigger on both tables
  const nodeId = res.nodeIds[0];
  const base = await engine.crdt.load(nodeId);
  await engine.crdt.saveAtomic(nodeId, diffUpdate(base, { body: 'Replaced body with lockstepMarker_88 now.' }));
  assert.ok((await engine.search('lockstepMarker_88')).length > 0, 'trigram sees update');
  assert.ok((await engine.wordSearch('lockstepMarker_88')).length > 0, 'word index sees update');
  assert.equal((await engine.wordSearch('lockstepMarker_77')).length, 0, 'word index dropped old text');

  // delete path: nodes_ad trigger on both tables
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (engine as any).broker.write('deleteNode', { id: nodeId });
  assert.equal((await engine.search('lockstepMarker_88')).length, 0);
  assert.equal((await engine.wordSearch('lockstepMarker_88')).length, 0);
  stats = await engine.stats();
  assert.equal(stats.ftsRows, stats.nodes);
  assert.equal(stats.ftsWordRows, stats.nodes);
});

// ---- lanes + fusion -------------------------------------------------------

test('word lane: whole-word + prefix matching where trigram alone is rigid', async () => {
  // "paginat" (7 chars, prefix of pagination) — word lane prefix-expands
  const wordHits = await engine.wordSearch('paginat');
  assert.ok(wordHits.length > 0, 'prefix star matched pagination');
  assert.equal(wordHits[0].title, 'pagination.md');
});

test('trigram lane: substring/camelCase matching survives untouched', async () => {
  const hits = await engine.search('TotalPrice');
  assert.ok(hits.length > 0);
  assert.equal(hits[0].title, 'totals.ts');
});

test('hybridSearch: fuses lanes, reports lane provenance', async () => {
  const hits = await engine.hybridSearch('pagination strategy');
  assert.ok(hits.length > 0);
  assert.equal(hits[0].title, 'pagination.md');
  assert.ok(hits[0].rrfScore > 0);
  assert.ok(hits[0].sources.includes('trigram') || hits[0].sources.includes('word'));
  // a hit found by both lanes carries both provenances
  const both = hits.find((h) => h.sources.length >= 2);
  assert.ok(both, 'at least one hit fused from two lanes');
});

test('rrfFuse: hand-computed ordering — item in both lists outranks single-list items', () => {
  const a = [{ id: 'x' }, { id: 'y' }];
  const b = [{ id: 'z' }, { id: 'x' }];
  const fused = rrfFuse([a, b], (i) => i.id);
  // x: 1/61 + 1/62 > z: 1/61 > y: 1/62
  assert.deepEqual(fused.map((f) => f.item.id), ['x', 'z', 'y']);
  assert.deepEqual(fused[0].sources, [0, 1]);
});

test('rrfFuse: deterministic tie-break (sources desc, best rank asc, key asc)', () => {
  const fused = rrfFuse([[{ id: 'b' }], [{ id: 'a' }]], (i) => i.id);
  // identical rrf scores and source counts → alphabetical by key
  assert.deepEqual(fused.map((f) => f.item.id), ['a', 'b']);
});

test('property: hybrid recall ≥ trigram-only recall on the fixture corpus', async () => {
  const queries: { q: string; expectTitle: string }[] = [
    { q: 'calculateTotalPrice', expectTitle: 'totals.ts' },
    { q: 'pagination strategy', expectTitle: 'pagination.md' },
    { q: 'session renewal expiry', expectTitle: 'auth.md' },
    { q: 'staging production rollout', expectTitle: 'deploy.md' },
  ];
  let trigramRecall = 0;
  let hybridRecall = 0;
  for (const { q, expectTitle } of queries) {
    const tri = await engine.search(q, { limit: 10 });
    const hyb = await engine.hybridSearch(q, { limit: 10 });
    if (tri.some((h) => h.title === expectTitle)) trigramRecall++;
    if (hyb.some((h) => h.title === expectTitle)) hybridRecall++;
  }
  assert.ok(
    hybridRecall >= trigramRecall,
    `hybrid (${hybridRecall}) must never degrade trigram recall (${trigramRecall})`,
  );
});

// ---- vector lane -----------------------------------------------------------

test('HashingEmbedder: deterministic, normalized, similarity-ordered', () => {
  const e = new HashingEmbedder();
  const a1 = e.embed('cursor based pagination beats offset');
  const a2 = e.embed('cursor based pagination beats offset');
  assert.deepEqual([...a1], [...a2], 'same text ⇒ identical embedding');
  assert.ok(Math.abs(dot(a1, a1) - 1) < 1e-5, 'L2-normalized');
  const near = e.embed('cursor based pagination beats offset pagination');
  const far = e.embed('completely unrelated zebra xylophone quartz');
  assert.ok(dot(a1, near) > dot(a1, far), 'related text scores higher');
});

test('vector lane: embeddings stored at ingest, hybrid fuses three lanes', async () => {
  const stats = await vecEngine.stats();
  assert.equal(stats.vecRows, stats.nodes, 'one embedding per atom');
  const hits = await vecEngine.hybridSearch('pagination strategy');
  assert.ok(hits.length > 0);
  const vectorContributed = hits.some((h) => h.sources.includes('vector'));
  assert.ok(vectorContributed, 'vector lane contributes to fusion');
});

test('property: vector-lane fusion does not degrade exact-match recall', async () => {
  const queries: { q: string; expectTitle: string }[] = [
    { q: 'calculateTotalPrice', expectTitle: 'totals.ts' },
    { q: 'pagination strategy', expectTitle: 'pagination.md' },
    { q: 'session renewal expiry', expectTitle: 'auth.md' },
  ];
  for (const { q, expectTitle } of queries) {
    const tri = await vecEngine.search(q, { limit: 10 });
    const hyb = await vecEngine.hybridSearch(q, { limit: 10 });
    const triHit = tri.some((h) => h.title === expectTitle);
    const hybHit = hyb.some((h) => h.title === expectTitle);
    assert.ok(!triHit || hybHit, `"${q}": trigram found it, hybrid+vector must too`);
  }
});
