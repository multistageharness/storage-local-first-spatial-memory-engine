/**
 * IDEA.v2 §6.3 — FederatedSearch: cross-shard RRF vs a hand-computed
 * fixture, rank-not-score fusion, quorum/straggler policy with an
 * injected slow shard, strict mode, {shardKey, nodeId} identity.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { FederatedSearch, type ShardProbe } from '../src/federation/search.js';
import type { ShardRouter } from '../src/federation/router.js';
import type { HybridSearchHit } from '../src/workers/protocol.js';

function stubRouter(shardKeys: string[]): ShardRouter {
  return {
    route: (query: string) => ({ shardKeys, pinned: false, query }),
  } as unknown as ShardRouter;
}

function hit(id: number, title: string, score = -1): HybridSearchHit {
  return {
    id,
    graphId: 1,
    clusterId: 1,
    cluster: 'general',
    title,
    originFile: null,
    chunkIndex: 0,
    score,
    snippet: '',
    body: `${title} body`,
    rrfScore: 0.05,
    sources: ['trigram'],
  };
}

test('cross-shard fusion matches the hand-computed RRF fixture', async () => {
  // shardA: [n1, n2]   shardB: [n3, n1']  — n1 and n1' are different
  // atoms (different shards), so no cross-shard dedup happens here.
  // Expected (k=60): every rank-1 hit ties at 1/61, rank-2 at 1/62;
  // ties break deterministically by key.
  const probe: ShardProbe = async (shardKey) =>
    shardKey === 'a' ? [hit(1, 'a-first'), hit(2, 'a-second')] : [hit(3, 'b-first'), hit(4, 'b-second')];
  const fs = new FederatedSearch(stubRouter(['a', 'b']), probe);
  const res = await fs.search('q', { strict: true });

  assert.deepEqual(res.probed, ['a', 'b']);
  assert.deepEqual(res.fusedFrom.sort(), ['a', 'b']);
  const keys = res.hits.map((h) => `${h.shardKey}:${h.nodeId}`);
  // rank-1 hits (1/61) before rank-2 hits (1/62); ties alpha by key
  assert.deepEqual(keys, ['a:1', 'b:3', 'a:2', 'b:4']);
  assert.ok(Math.abs(res.hits[0].rrfScore - 1 / 61) < 1e-9);
  assert.ok(Math.abs(res.hits[2].rrfScore - 1 / 62) < 1e-9);
});

test('fusion is rank-based — skewed BM25 magnitudes cannot buy rank', async () => {
  // shard 'noisy' reports absurdly "better" (more negative) bm25 scores;
  // fusion must ignore magnitudes entirely.
  const probe: ShardProbe = async (shardKey) =>
    shardKey === 'noisy'
      ? [hit(10, 'noisy-1', -9999), hit(11, 'noisy-2', -9998)]
      : [hit(20, 'calm-1', -0.1), hit(21, 'calm-2', -0.05)];
  const fs = new FederatedSearch(stubRouter(['calm', 'noisy']), probe);
  const res = await fs.search('q', { strict: true });
  const rank1 = res.hits.slice(0, 2).map((h) => h.shardKey).sort();
  assert.deepEqual(rank1, ['calm', 'noisy'], 'both shards’ rank-1 hits share the top — magnitude is ignored');
  assert.equal(res.hits[0].rrfScore, res.hits[1].rrfScore);
});

test('quorum fuses without the straggler; straggler is reported, not awaited', async () => {
  const probe: ShardProbe = async (shardKey) => {
    if (shardKey === 'slow') {
      await delay(400);
      return [hit(99, 'slow-late')];
    }
    return [hit(Number(shardKey.slice(1)), `${shardKey}-hit`)];
  };
  const fs = new FederatedSearch(stubRouter(['s1', 's2', 's3', 's4', 'slow']), probe);
  const started = Date.now();
  // probeWave ≥ candidate count → single wave, isolating the quorum policy
  const res = await fs.search('q', { timeoutMs: 60, probeWave: 8 });
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 350, `quorum fusion must not wait for the straggler (took ${elapsed}ms)`);
  assert.deepEqual(res.stragglers, ['slow']);
  assert.equal(res.fusedFrom.length, 4);
  assert.ok(!res.hits.some((h) => h.shardKey === 'slow'));
});

test('strict mode awaits every probed shard (gates measure retrieval, not policy)', async () => {
  const probe: ShardProbe = async (shardKey) => {
    if (shardKey === 'slow') {
      await delay(150);
      return [hit(99, 'slow-late')];
    }
    return [hit(1, `${shardKey}-hit`)];
  };
  const fs = new FederatedSearch(stubRouter(['s1', 'slow']), probe);
  const res = await fs.search('q', { strict: true, timeoutMs: 10 });
  assert.deepEqual(res.stragglers, []);
  assert.ok(res.hits.some((h) => h.shardKey === 'slow'), 'slow shard included under strict');
});

test('failed shard is excluded and logged; identity stays {shardKey, nodeId}', async () => {
  const logs: string[] = [];
  const probe: ShardProbe = async (shardKey) => {
    if (shardKey === 'broken') throw new Error('io exploded');
    return [hit(7, 'ok-hit')];
  };
  const fs = new FederatedSearch(stubRouter(['ok', 'broken']), probe, (m) => logs.push(m));
  const res = await fs.search('q', { strict: true });
  assert.deepEqual(res.fusedFrom, ['ok']);
  assert.ok(logs.some((l) => l.includes('broken') && l.includes('io exploded')));
  assert.equal(res.hits[0].shardKey, 'ok');
  assert.equal(res.hits[0].nodeId, 7);
  assert.equal(res.hits[0].shardRank, 1);
});

test('limit + perShardLimit are honored', async () => {
  const probe: ShardProbe = async (_k, _q, o) => {
    assert.equal(o.limit, 3, 'perShardLimit propagated to probes');
    return [hit(1, 'h1'), hit(2, 'h2'), hit(3, 'h3')];
  };
  const fs = new FederatedSearch(stubRouter(['a', 'b', 'c']), probe);
  const res = await fs.search('q', { strict: true, limit: 4, perShardLimit: 3 });
  assert.equal(res.hits.length, 4);
});

test('probe waves: deeper waves are skipped once an earlier wave has hits (quorum mode)', async () => {
  const probedShards: string[] = [];
  const probe: ShardProbe = async (shardKey) => {
    probedShards.push(shardKey);
    return shardKey === 's2' ? [hit(1, 'found')] : [];
  };
  const fs = new FederatedSearch(stubRouter(['s1', 's2', 's3', 's4', 's5', 's6']), probe);
  const res = await fs.search('q', { probeWave: 2, timeoutMs: 5000 });
  // wave 1 = s1,s2 → hit in s2 → s3..s6 never probed
  assert.deepEqual(probedShards.sort(), ['s1', 's2']);
  assert.deepEqual(res.probed.sort(), ['s1', 's2']);
  assert.equal(res.hits[0].shardKey, 's2');
});

test('probe waves: strict mode probes EVERY candidate (no early exit)', async () => {
  const probedShards: string[] = [];
  const probe: ShardProbe = async (shardKey) => {
    probedShards.push(shardKey);
    return shardKey === 's1' ? [hit(1, 'early-hit')] : shardKey === 's6' ? [hit(2, 'deep-hit')] : [];
  };
  const fs = new FederatedSearch(stubRouter(['s1', 's2', 's3', 's4', 's5', 's6']), probe);
  const res = await fs.search('q', { strict: true, probeWave: 2 });
  assert.equal(probedShards.length, 6, 'strict probes the full candidate set');
  assert.ok(res.hits.some((h) => h.shardKey === 's6'), 'a deep match is never hidden from a recall gate');
});

test('probe waves: hitless waves keep deepening to the candidate floor', async () => {
  const probedShards: string[] = [];
  const probe: ShardProbe = async (shardKey) => {
    probedShards.push(shardKey);
    return [];
  };
  const fs = new FederatedSearch(stubRouter(['s1', 's2', 's3', 's4', 's5']), probe);
  const res = await fs.search('q', { strict: true, probeWave: 2 });
  assert.equal(probedShards.length, 5, 'all candidates probed when nothing hits');
  assert.equal(res.hits.length, 0);
});
