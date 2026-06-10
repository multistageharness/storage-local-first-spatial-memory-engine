/**
 * IDEA.v2 §6.2 — ShardRouter: explicit hint short-circuit, RRF routing
 * on synthetic signatures, deterministic tie-break, maxShards cap,
 * needle-shard-in-candidates property over a 10-seed sweep.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Catalog } from '../src/federation/catalog.js';
import { ShardRouter, parseHint } from '../src/federation/router.js';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const dir = mkdtempSync(join(tmpdir(), 'sme-router-'));
const catalog = Catalog.open(join(dir, 'catalog.db'));
const router = new ShardRouter(catalog);

const VOCAB = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet'];

// 8 shards with distinct keyword signatures + 1 shared decoy term
for (let i = 0; i < 8; i++) {
  const key = `syn:shard-${i}`;
  catalog.ensureShard({ shardKey: key, kind: 'synthetic', dbPath: join(dir, `s${i}.db`) });
  catalog.setRoutingTerms(key, [`${VOCAB[i]}service`, `${VOCAB[i]}worker`, 'commonterm']);
}
catalog.ensureShard({ shardKey: 'gh:acme/payments', kind: 'repo', dbPath: join(dir, 'pay.db') });
catalog.ensureShard({ shardKey: 'cf:ENG', kind: 'space', dbPath: join(dir, 'eng.db') });

after(() => {
  catalog.close();
  rmSync(dir, { recursive: true, force: true });
});

test('parseHint: space:/repo:/shard: syntaxes map to shard keys', () => {
  assert.deepEqual(parseHint('space:ENG release process'), { hint: 'cf:ENG', rest: 'release process' });
  assert.deepEqual(parseHint('repo:acme/payments charge flow'), {
    hint: 'gh:acme/payments',
    rest: 'charge flow',
  });
  assert.equal(parseHint('shard:syn:shard-3 anything').hint, 'syn:shard-3');
  assert.equal(parseHint('no hints here').hint, null);
});

test('route: explicit hint short-circuits to exactly that shard', () => {
  const r = router.route('space:ENG how do we deploy', {});
  assert.deepEqual(r.shardKeys, ['cf:ENG']);
  assert.equal(r.pinned, true);
  assert.equal(r.query, 'how do we deploy', 'hint syntax stripped from the query');

  const viaOpt = router.route('how do we deploy', { graphHint: 'gh:acme/payments' });
  assert.deepEqual(viaOpt.shardKeys, ['gh:acme/payments']);
  assert.equal(viaOpt.pinned, true);
});

test('route: unknown hint falls back to scored routing', () => {
  const r = router.route('space:NOPE alphaservice request', {});
  assert.equal(r.pinned, false);
  assert.ok(r.shardKeys.length > 0);
  assert.equal(r.shardKeys[0], 'syn:shard-0', 'signature match still wins');
});

test('route: keyword-signature RRF puts the matching shard first', () => {
  const r = router.route('how does the bravoservice handle bravoworker retries', {});
  assert.equal(r.pinned, false);
  assert.equal(r.shardKeys[0], 'syn:shard-1');
});

test('route: maxShards caps the candidate set', () => {
  const r = router.route('commonterm everywhere', { maxShards: 3 });
  assert.equal(r.shardKeys.length, 3);
});

test('route: deterministic — identical query yields identical candidate order', () => {
  const q = 'commonterm deploy flow';
  const a = router.route(q, { maxShards: 8 });
  const b = router.route(q, { maxShards: 8 });
  assert.deepEqual(a.shardKeys, b.shardKeys);
});

test('property: needle shard appears in candidates across a 10-seed sweep', () => {
  for (let seed = 1; seed <= 10; seed++) {
    const rand = mulberry32(seed);
    const idx = Math.floor(rand() * 8);
    const needleTerm = `${VOCAB[idx]}service`;
    const noise = VOCAB[Math.floor(rand() * VOCAB.length)];
    const r = router.route(`where is the ${needleTerm} configured ${noise}`, { maxShards: 4 });
    assert.ok(
      r.shardKeys.includes(`syn:shard-${idx}`),
      `seed ${seed}: shard-${idx} must be in candidates for "${needleTerm}" (got ${r.shardKeys.join(',')})`,
    );
  }
});
