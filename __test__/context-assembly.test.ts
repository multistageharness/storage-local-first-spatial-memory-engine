/**
 * IDEA.v2 Phase 9 step 3 — context assembly: dedupe, adjacent-chunk
 * merge (overlap-aware), provenance headers, token budget never
 * exceeded; plus the RRF associativity property (fused-of-fused ≈ flat
 * fusion on the union) that underpins the "fused twice" pipeline.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assembleContext } from '../src/federation/context.js';
import { rrfFuse } from '../src/search/rrf.js';
import type { FederatedHit } from '../src/federation/search.js';

function hit(over: Partial<FederatedHit>): FederatedHit {
  return {
    shardKey: 'gh:acme/payments',
    nodeId: 1,
    cluster: 'general',
    title: 'totals.ts',
    originFile: 'src/totals.ts',
    chunkIndex: 0,
    body: 'chunk body',
    snippet: '',
    rrfScore: 0.03,
    sources: ['trigram'],
    shardRank: 1,
    ...over,
  };
}

test('dedupe: identical (shardKey, originFile, chunkIndex) collapses', () => {
  const ctx = assembleContext([
    hit({ nodeId: 1, chunkIndex: 0 }),
    hit({ nodeId: 1, chunkIndex: 0 }),
    hit({ nodeId: 2, chunkIndex: 3, body: 'other chunk' }),
  ]);
  assert.equal(ctx.blocks.length, 2);
});

test('adjacent chunks of one document merge overlap-aware', () => {
  const a = 'A'.repeat(60) + 'OVERLAP_ZONE';
  const b = 'OVERLAP_ZONE' + 'B'.repeat(60);
  const ctx = assembleContext(
    [
      hit({ nodeId: 1, chunkIndex: 0, body: a }),
      hit({ nodeId: 2, chunkIndex: 1, body: b }),
      hit({ nodeId: 3, chunkIndex: 5, body: 'far away chunk' }),
    ],
    { overlap: 'OVERLAP_ZONE'.length },
  );
  // chunks 0+1 merged into one block, chunk 5 separate
  assert.equal(ctx.blocks.length, 2);
  const merged = ctx.blocks[0];
  assert.deepEqual(merged.chunkRange, [0, 1]);
  assert.equal(merged.body, a + 'B'.repeat(60), 'overlap dropped exactly once');
  assert.ok(merged.header.includes('chunks 0–1'));
});

test('provenance headers carry shard · file · chunk', () => {
  const ctx = assembleContext([hit({ chunkIndex: 3 })]);
  assert.equal(ctx.blocks[0].header, '### gh:acme/payments · src/totals.ts · chunk 3');
  assert.ok(ctx.text.startsWith('### gh:acme/payments'));
});

test('token budget is never exceeded; truncation is reported', () => {
  const hits = Array.from({ length: 30 }, (_, i) =>
    hit({ nodeId: i + 1, chunkIndex: i * 2, body: 'x'.repeat(400), originFile: `src/f${i}.ts` }),
  );
  const ctx = assembleContext(hits, { maxTokens: 300 });
  assert.ok(ctx.tokensUsed <= 300, `tokensUsed=${ctx.tokensUsed}`);
  assert.equal(ctx.truncated, true);
  assert.ok(ctx.blocks.length >= 1, 'budget admits at least the top block');
});

test('property: RRF fused-of-fused ≈ flat fusion on the union (top item stable)', () => {
  // three "term" lists across two "shards" — fuse per shard, then across
  const shardA = [
    ['x', 'y', 'z'],
    ['x', 'w'],
  ];
  const shardB = [
    ['q', 'x'],
    ['q', 'r'],
  ];
  const fusedA = rrfFuse(shardA, (s) => s).map((f) => f.item);
  const fusedB = rrfFuse(shardB, (s) => s).map((f) => f.item);
  const twice = rrfFuse([fusedA, fusedB], (s) => s).map((f) => f.item);
  const flat = rrfFuse([...shardA, ...shardB], (s) => s).map((f) => f.item);
  assert.equal(twice[0], flat[0], 'the dominant item survives both fusion shapes');
  // and the fused-of-fused ranking preserves the flat top-3 membership
  assert.deepEqual(new Set(twice.slice(0, 3)), new Set(flat.slice(0, 3)));
});
