/**
 * IDEA.v2 §5.1 — documents table + replaceDocument incremental-ingest
 * primitive: hash-skip no-op, changed-hash atomic atom swap (counts and
 * BOTH FTS indexes in lock-step), deleteDocument trigger hygiene.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryEngine, sha256Hex } from '../src/engine.js';

const dir = mkdtempSync(join(tmpdir(), 'sme-docs-'));
const engine = await MemoryEngine.open({
  dbPath: join(dir, 'docs.db'),
  graph: 'docs-graph',
  clusters: [{ name: 'api', keywords: ['endpoint', 'request', 'response'] }],
  minReaders: 1,
});

after(async () => {
  await engine.close();
  rmSync(dir, { recursive: true, force: true });
});

const V1_TEXT = 'The billing endpoint accepts a request with paymentToken pay_8842XQ and returns a response.';
const V2_TEXT = 'The billing endpoint accepts a request with paymentToken pay_9913ZR and returns a response.';

test('replaceDocument: first ingest creates document row + searchable atoms', async () => {
  const res = await engine.replaceDocument({
    sourceKey: 'docs/billing.md',
    title: 'billing.md',
    text: V1_TEXT,
  });
  assert.equal(res.skipped, false);
  assert.ok(res.documentId > 0);
  assert.ok(res.nodeIds.length > 0);
  assert.equal(res.chunks, res.nodeIds.length);

  const doc = await engine.getDocument('docs/billing.md');
  assert.ok(doc);
  assert.equal(doc.contentHash, sha256Hex(V1_TEXT));
  assert.equal(doc.atomCount, res.nodeIds.length);

  const hits = await engine.search('pay_8842XQ');
  assert.ok(hits.length > 0, 'verbatim token findable after first ingest');
});

test('replaceDocument: unchanged content_hash → {skipped:true}, nothing touched', async () => {
  const before = await engine.stats();
  const res = await engine.replaceDocument({
    sourceKey: 'docs/billing.md',
    title: 'billing.md',
    text: V1_TEXT,
  });
  assert.equal(res.skipped, true);
  assert.equal(res.nodeIds.length, 0);
  const after_ = await engine.stats();
  assert.equal(after_.nodes, before.nodes);
  assert.equal(after_.outboxTotal, before.outboxTotal);
});

test('replaceDocument: changed hash swaps atoms atomically, both FTS in lock-step', async () => {
  const before = await engine.getDocument('docs/billing.md');
  assert.ok(before);

  const res = await engine.replaceDocument({
    sourceKey: 'docs/billing.md',
    title: 'billing.md',
    text: V2_TEXT,
    sourceVersion: 'v2',
  });
  assert.equal(res.skipped, false);
  assert.equal(res.documentId, before.id, 'same document identity row');

  // old content unfindable, new content findable — in BOTH lanes
  assert.equal((await engine.search('pay_8842XQ')).length, 0, 'trigram: old content gone');
  assert.ok((await engine.search('pay_9913ZR')).length > 0, 'trigram: new content present');
  assert.equal((await engine.wordSearch('pay_8842XQ')).length, 0, 'word: old content gone');
  assert.ok((await engine.wordSearch('pay_9913ZR')).length > 0, 'word: new content present');

  const doc = await engine.getDocument('docs/billing.md');
  assert.ok(doc);
  assert.equal(doc.contentHash, sha256Hex(V2_TEXT));
  assert.equal(doc.sourceVersion, 'v2');

  // FTS row counts match node count exactly (lock-step on both indexes)
  const stats = await engine.stats();
  assert.equal(stats.ftsRows, stats.nodes);
  assert.equal(stats.ftsWordRows, stats.nodes);
});

test('deleteDocument: removes atoms, document row, and both FTS entries', async () => {
  await engine.replaceDocument({
    sourceKey: 'docs/tmp.md',
    title: 'tmp.md',
    text: 'Ephemeral page mentioning ephemeralToken_55XY for deletion hygiene.',
  });
  assert.ok((await engine.search('ephemeralToken_55XY')).length > 0);

  const res = await engine.deleteDocument('docs/tmp.md');
  assert.equal(res.deleted, true);
  assert.ok(res.atoms > 0);

  assert.equal((await engine.search('ephemeralToken_55XY')).length, 0);
  assert.equal((await engine.wordSearch('ephemeralToken_55XY')).length, 0);
  assert.equal(await engine.getDocument('docs/tmp.md'), null);

  const stats = await engine.stats();
  assert.equal(stats.ftsRows, stats.nodes);
  assert.equal(stats.ftsWordRows, stats.nodes);

  // second delete is a no-op, not an error
  const again = await engine.deleteDocument('docs/tmp.md');
  assert.equal(again.deleted, false);
  assert.equal(again.atoms, 0);
});

test('replaceDocument: multi-chunk document swaps as a unit', async () => {
  const bigV1 = Array.from({ length: 12 }, (_, i) => `Chunky paragraph ${i} markerAlphaV1_${i}.`).join(
    ' '.repeat(200),
  );
  const bigV2 = Array.from({ length: 12 }, (_, i) => `Chunky paragraph ${i} markerBetaV2_${i}.`).join(
    ' '.repeat(200),
  );
  const first = await engine.replaceDocument({ sourceKey: 'docs/big.md', title: 'big.md', text: bigV1 });
  assert.ok(first.nodeIds.length > 1, 'fixture spans multiple chunks');

  const second = await engine.replaceDocument({ sourceKey: 'docs/big.md', title: 'big.md', text: bigV2 });
  assert.equal(second.skipped, false);

  const doc = await engine.getDocument('docs/big.md');
  assert.ok(doc);
  assert.equal(doc.atomCount, second.nodeIds.length);
  assert.equal((await engine.search('markerAlphaV1_3')).length, 0, 'every old atom gone');
  assert.ok((await engine.search('markerBetaV2_3')).length > 0, 'new atoms present');
});

test('fts integrity check passes over both indexes after churn', async () => {
  // checkFtsIntegrity throws on a corrupted external-content index
  await assert.doesNotReject(async () => {
    // route through the broker via a raw write op
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (engine as any).broker.write('checkFtsIntegrity', {});
  });
});
