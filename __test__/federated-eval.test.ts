/**
 * IDEA.v2 §10.2/§10.3 — federated eval stack over a LIVE 8-shard org:
 * shardRoutingRecall pass/degradation, three-component failure
 * attribution, federated threshold calibration, federated golden run,
 * dynamic-execution proof at org level, router-broken negative control.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FederatedEngine } from '../src/federated-engine.js';
import { buildSyntheticOrg } from './benchmark/org-dataset.js';
import {
  DEFAULT_FEDERATED_THRESHOLDS,
  FederatedEvalHarness,
  shardRoutingRecall,
  shardRoutingPrecisionProxy,
  synthesizeFederatedGoldens,
  type FederatedGolden,
} from './eval/federated.js';
import { JudgeJury, LexicalJudge } from './eval/judge.js';

// ---- pure metric behavior ---------------------------------------------------

test('shardRoutingRecall: pass, degradation, and empty-expectation cases', () => {
  const full = shardRoutingRecall(['s1', 's2'], ['s1', 's2', 's3']);
  assert.equal(full.score, 1);
  assert.equal(full.passed, true);
  assert.equal(full.component, 'router');

  const half = shardRoutingRecall(['s1', 's2'], ['s1']);
  assert.equal(half.score, 0.5);
  assert.equal(half.passed, false);
  assert.ok(half.reason.includes('s2'));

  assert.equal(shardRoutingRecall([], ['anything']).score, 1, 'no expectation → vacuous pass');
});

test('shardRoutingPrecisionProxy: probed/maxShards telemetry', () => {
  assert.equal(shardRoutingPrecisionProxy(4, 32), 0.125);
  assert.equal(shardRoutingPrecisionProxy(0, 0), 0);
});

test('federated thresholds: calibrated precision relaxation is recorded', () => {
  assert.equal(DEFAULT_FEDERATED_THRESHOLDS.contextualPrecision, 0.45);
  assert.equal(DEFAULT_FEDERATED_THRESHOLDS.shardRoutingRecall, 0.95);
});

// ---- live 8-shard org ----------------------------------------------------------

const dir = mkdtempSync(join(tmpdir(), 'sme-fedeval-'));
const synth = buildSyntheticOrg({ seed: 11, shards: 8, docsPerShard: 10 });
const org = await FederatedEngine.open({ rootDir: dir, maxConcurrentShardIngests: 4 });
for (const s of synth.shards) {
  await org.ensureShard({ shardKey: s.shardKey, kind: 'synthetic', displayName: s.displayName, clusters: s.clusters });
  await org.ingest(s.shardKey, [s.docs]);
}
org.catalog.refreshAllRoutingTerms();

after(async () => {
  await org.close();
  rmSync(dir, { recursive: true, force: true });
});

test('synthesizeFederatedGoldens: per-shard synthesis + cross-shard evolution, seeded', () => {
  const corpora = synth.shards.map((s) => ({
    shardKey: s.shardKey,
    docs: s.docs.map((d) => ({ title: d.title, text: d.text, originFile: d.originFile })),
  }));
  const a = synthesizeFederatedGoldens(corpora, { seed: 5, maxGoldens: 16 });
  const b = synthesizeFederatedGoldens(corpora, { seed: 5, maxGoldens: 16 });
  assert.deepEqual(a, b, 'same seed ⇒ identical goldens');
  assert.ok(a.length > 0);
  assert.ok(a.every((g) => g.expectedShards.length >= 1));
  const cross = a.filter((g) => g.evolutions.includes('cross-shard-multi-context'));
  assert.ok(cross.length >= 1, 'cross-shard evolution produced');
  assert.ok(cross.every((g) => g.expectedShards.length === 2));
});

test('federated golden run over the live org passes; jury seam swaps in', async () => {
  const corpora = synth.shards.map((s) => ({
    shardKey: s.shardKey,
    docs: s.docs.map((d) => ({ title: d.title, text: d.text, originFile: d.originFile })),
  }));
  const goldens = synthesizeFederatedGoldens(corpora, { seed: 5, maxGoldens: 10 });
  const harness = new FederatedEvalHarness({ org });
  const report = await harness.run(goldens);
  assert.equal(report.passed, true, JSON.stringify(report.componentFailures) + JSON.stringify(report.metricMeans));
  assert.ok(report.metricMeans.shardRoutingRecall >= 0.95);
  assert.deepEqual(report.componentFailures, { router: 0, retriever: 0, generator: 0 });

  // JudgeJury through the same seam (DEMO001 §8.2)
  const jury = new FederatedEvalHarness({
    org,
    judge: new JudgeJury([new LexicalJudge(), new LexicalJudge({ attributionThreshold: 0.6 })]),
  });
  const juryReport = await jury.run(goldens.slice(0, 3));
  assert.ok(juryReport.judge.toLowerCase().includes('jury'));
});

test('dynamic execution at org level: mutating one shard’s index changes the eval result', async () => {
  const shard = synth.shards[0];
  const doc = shard.docs[0];
  const golden: FederatedGolden = {
    input: `What does ${doc.needle} do in ${doc.title}?`,
    expectedOutput: `export function ${doc.needle}(items: LineItem[]): number {`,
    sourceContexts: [],
    evolutions: [],
    quality: { selfContainment: 1, clarity: 1 },
    expectedShards: [shard.shardKey],
  };
  const harness = new FederatedEvalHarness({ org });
  const before = await harness.runGolden(golden);
  assert.equal(before.metrics.find((m) => m.name === 'contextualRecall')!.passed, true);

  // mutate the live index: the needle's document is gutted
  await org.withEngine(shard.shardKey, (e) =>
    e.replaceDocument({ sourceKey: doc.sourceKey, title: doc.title, text: 'gutted document, needle removed.' }),
  );
  const after_ = await harness.runGolden(golden);
  assert.equal(
    after_.metrics.find((m) => m.name === 'contextualRecall')!.passed,
    false,
    'index mutation must surface in the dynamically-executed eval',
  );
  assert.ok(after_.failedComponents.includes('retriever'));

  // restore for later tests
  await org.withEngine(shard.shardKey, (e) =>
    e.replaceDocument({ sourceKey: doc.sourceKey, title: doc.title, text: doc.text }),
  );
});

test('negative control: scrambled routing terms fail the router metric with correct attribution', async () => {
  // last-sorting shard: the zero-signal recency fallback (top-4, key
  // tie-break) can never include it, so the control isolates the router
  const shard = synth.shards[synth.shards.length - 1];
  const doc = shard.docs[1];
  const golden: FederatedGolden = {
    input: `What does ${doc.needle} do?`,
    expectedOutput: `export function ${doc.needle}(items: LineItem[]): number {`,
    sourceContexts: [],
    evolutions: [],
    quality: { selfContainment: 1, clarity: 1 },
    expectedShards: [shard.shardKey],
  };
  // sabotage: every shard's routing signature becomes garbage. The
  // EXPECTED shard is scrambled first so the zero-signal recency
  // fallback (which favors recently-touched shards) cannot accidentally
  // include it — the control must isolate the router, not luck.
  const saved = new Map(org.catalog.listShards().map((s) => [s.shardKey, s.routingTerms]));
  org.catalog.setRoutingTerms(shard.shardKey, ['zzzgarbage0']);
  for (const key of saved.keys()) {
    if (key !== shard.shardKey) org.catalog.setRoutingTerms(key, ['zzzgarbage1', 'zzzgarbage2']);
  }
  try {
    const harness = new FederatedEvalHarness({ org });
    const result = await harness.runGolden(golden);
    const routing = result.metrics.find((m) => m.name === 'shardRoutingRecall')!;
    assert.equal(routing.passed, false, 'router metric must fail under scrambled signatures');
    assert.ok(result.failedComponents.includes('router'), 'failure attributed to the router');
    // every failing metric still names its own component — no cross-blame
    for (const m of result.metrics.filter((m) => !m.passed)) {
      assert.ok(['router', 'retriever', 'generator'].includes(m.component));
    }
  } finally {
    for (const [key, terms] of saved) org.catalog.setRoutingTerms(key, terms);
  }
});
