/**
 * IDEA.v2 §10.2/§10.3 — federated eval extensions.
 *
 *   - FederatedGolden: a demo001 golden + expectedShards[] for routing
 *     attribution;
 *   - synthesizeFederatedGoldens: demo001's four-stage evolution per
 *     shard, plus the cross-shard multi-context evolution (combine
 *     goldens from DIFFERENT shards — tests fusion, not just retrieval);
 *   - shardRoutingRecall: component-isolated 'router' metric (threshold
 *     0.95) + routing precision proxy (efficiency telemetry, reported
 *     not gated);
 *   - FederatedEvalHarness: dynamic execution against a live
 *     FederatedEngine with THREE-component failure attribution —
 *     router vs retriever vs generator (extends DEMO001 §8.6's two).
 */
import type { FederatedEngine } from '../../src/federated-engine.js';
import { synthesizeGoldens, type CorpusDoc, type Golden, type SynthesizerOptions } from './goldens.js';
import { extractiveGenerator, type GenerateFn } from './generator.js';
import { LexicalJudge, type Judge } from './judge.js';
import {
  answerRelevancy,
  contextualPrecision,
  contextualRecall,
  faithfulness,
  type MetricResult,
} from './metrics.js';
import { keywordTerms } from '../../src/search/terms.js';

export interface FederatedGolden extends Golden {
  /** shards whose atoms ground this golden — routing ground truth */
  expectedShards: string[];
}

export interface ShardCorpus {
  shardKey: string;
  docs: CorpusDoc[];
}

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

export interface FederatedSynthesizerOptions extends SynthesizerOptions {
  /** fraction of goldens evolved into cross-shard multi-context pairs */
  crossShardRate?: number;
}

/**
 * Per-shard four-stage synthesis (DEMO001 §8.3), then a cross-shard
 * multi-context evolution: pairs of goldens from different shards merge
 * into one golden whose expectedShards spans both.
 */
export function synthesizeFederatedGoldens(
  shards: ShardCorpus[],
  opts: FederatedSynthesizerOptions = {},
): FederatedGolden[] {
  const seed = opts.seed ?? 42;
  const rand = mulberry32(seed ^ 0x5eed);
  const maxGoldens = opts.maxGoldens ?? 24;
  const crossShardRate = opts.crossShardRate ?? 0.2;
  const perShard = Math.max(2, Math.ceil(maxGoldens / Math.max(1, shards.length)));

  const singles: FederatedGolden[] = [];
  for (const shard of shards) {
    const goldens = synthesizeGoldens(shard.docs, { ...opts, seed, maxGoldens: perShard });
    for (const g of goldens) singles.push({ ...g, expectedShards: [shard.shardKey] });
  }

  // cross-shard multi-context evolution (promoted from cross-doc)
  const out: FederatedGolden[] = [];
  const used = new Set<number>();
  const crossTarget = Math.floor(Math.min(maxGoldens, singles.length) * crossShardRate);
  let crossed = 0;
  while (crossed < crossTarget) {
    const i = Math.floor(rand() * singles.length);
    const j = Math.floor(rand() * singles.length);
    if (i === j || used.has(i) || used.has(j)) {
      if (used.size >= singles.length - 1) break;
      continue;
    }
    const a = singles[i];
    const b = singles[j];
    if (a.expectedShards[0] === b.expectedShards[0]) continue;
    used.add(i);
    used.add(j);
    out.push({
      input: `${a.input.replace(/\?\s*$/, '')}, and ${b.input.charAt(0).toLowerCase()}${b.input.slice(1)}`,
      expectedOutput: `${a.expectedOutput} ${b.expectedOutput}`.trim(),
      sourceContexts: [...a.sourceContexts, ...b.sourceContexts],
      evolutions: [...a.evolutions, 'cross-shard-multi-context'],
      quality: {
        selfContainment: Math.min(a.quality.selfContainment, b.quality.selfContainment),
        clarity: Math.min(a.quality.clarity, b.quality.clarity),
      },
      expectedShards: [...new Set([...a.expectedShards, ...b.expectedShards])],
    });
    crossed++;
  }
  for (let i = 0; i < singles.length && out.length < maxGoldens; i++) {
    if (!used.has(i)) out.push(singles[i]);
  }
  return out.slice(0, maxGoldens);
}

// ---- metrics (IDEA.v2 §10.3) ----------------------------------------------

function metric(
  name: string,
  component: MetricResult['component'],
  score: number,
  threshold: number,
  reason: string,
): MetricResult {
  const rounded = Math.round(score * 1000) / 1000;
  return { name, component, score: rounded, threshold, passed: rounded >= threshold, reason };
}

/** fraction of expectedShards present in the router's candidate set */
export function shardRoutingRecall(
  expectedShards: string[],
  candidates: string[],
  threshold = 0.95,
): MetricResult {
  const got = new Set(candidates);
  const found = expectedShards.filter((s) => got.has(s));
  const missing = expectedShards.filter((s) => !got.has(s));
  return metric(
    'shardRoutingRecall',
    'router',
    expectedShards.length === 0 ? 1 : found.length / expectedShards.length,
    threshold,
    missing.length === 0
      ? `all ${expectedShards.length} expected shard(s) in candidates`
      : `missing shard(s): ${missing.join(', ')}`,
  );
}

/** candidates probed / maxShards — efficiency telemetry, reported not gated */
export function shardRoutingPrecisionProxy(probed: number, maxShards: number): number {
  return maxShards === 0 ? 0 : Math.round((probed / maxShards) * 1000) / 1000;
}

export interface FederatedThresholds {
  shardRoutingRecall: number;
  contextualRecall: number;
  contextualPrecision: number;
  faithfulness: number;
  answerRelevancy: number;
}

/**
 * Calibrated federated thresholds (DEMO001 §8.6 convention): fusion
 * across shards admits slightly more context noise than single-graph
 * retrieval, so precision relaxes 0.5 → 0.45; answerRelevancy
 * recalibrates 0.15 → 0.10 on the federated score distribution —
 * fused cross-shard contexts dilute extractive answers (observed
 * passing band ≈ 0.12–0.30, evasive answers ≈ 0.0).
 */
export const DEFAULT_FEDERATED_THRESHOLDS: FederatedThresholds = {
  shardRoutingRecall: 0.95,
  contextualRecall: 0.7,
  contextualPrecision: 0.45,
  faithfulness: 0.5,
  answerRelevancy: 0.1,
};

// ---- harness ------------------------------------------------------------------

export type FederatedComponent = 'router' | 'retriever' | 'generator';

export interface FederatedCaseResult {
  input: string;
  expectedShards: string[];
  routedShards: string[];
  routingPrecisionProxy: number;
  actualOutput: string;
  retrievalContext: string[];
  metrics: MetricResult[];
  passed: boolean;
  failedComponents: FederatedComponent[];
}

export interface FederatedEvalReport {
  judge: string;
  thresholds: FederatedThresholds;
  cases: FederatedCaseResult[];
  totals: { cases: number; passed: number; failed: number };
  metricMeans: Record<string, number>;
  /** three-component failure attribution (IDEA.v2 §10.3) */
  componentFailures: Record<FederatedComponent, number>;
  passed: boolean;
}

export interface FederatedHarnessOptions {
  org: FederatedEngine;
  generate?: GenerateFn;
  judge?: Judge;
  thresholds?: Partial<FederatedThresholds>;
  maxShards?: number;
  retrieveLimit?: number;
}

export class FederatedEvalHarness {
  private readonly org: FederatedEngine;
  private readonly generate: GenerateFn;
  private readonly judge: Judge;
  private readonly thresholds: FederatedThresholds;
  private readonly maxShards: number;
  private readonly retrieveLimit: number;

  constructor(opts: FederatedHarnessOptions) {
    this.org = opts.org;
    this.generate = opts.generate ?? extractiveGenerator();
    this.judge = opts.judge ?? new LexicalJudge();
    this.thresholds = { ...DEFAULT_FEDERATED_THRESHOLDS, ...opts.thresholds };
    this.maxShards = opts.maxShards ?? 32;
    this.retrieveLimit = opts.retrieveLimit ?? 8;
  }

  async runGolden(golden: FederatedGolden): Promise<FederatedCaseResult> {
    // component 1 — router (scope resolution, measured in isolation)
    const routed = this.org.router.route(golden.input, { maxShards: this.maxShards });
    const routingMetric = shardRoutingRecall(
      golden.expectedShards,
      routed.shardKeys,
      this.thresholds.shardRoutingRecall,
    );

    // component 2 — federated retrieval (strict: recall gates must not
    // measure the straggler policy; per-term routing happens inside)
    const result = await this.org.search(golden.input, {
      limit: this.retrieveLimit,
      maxShards: this.maxShards,
      strict: true,
    });
    const retrievalContext = result.hits.map((h) => h.body);

    // component 3 — generation over the fused context
    const actualOutput = await this.generate(golden.input, retrievalContext);

    const metrics: MetricResult[] = [
      routingMetric,
      await contextualRecall(
        { expectedOutput: golden.expectedOutput, retrievalContext },
        this.judge,
        this.thresholds.contextualRecall,
      ),
      await contextualPrecision(
        { input: golden.input, expectedOutput: golden.expectedOutput, retrievalContext },
        this.judge,
        this.thresholds.contextualPrecision,
      ),
      await faithfulness({ actualOutput, retrievalContext }, this.judge, this.thresholds.faithfulness),
      await answerRelevancy({ input: golden.input, actualOutput }, this.judge, this.thresholds.answerRelevancy),
    ];

    const failed = metrics.filter((m) => !m.passed);
    return {
      input: golden.input,
      expectedShards: golden.expectedShards,
      routedShards: routed.shardKeys,
      routingPrecisionProxy: shardRoutingPrecisionProxy(result.probed.length, this.maxShards),
      actualOutput,
      retrievalContext,
      metrics,
      passed: failed.length === 0,
      failedComponents: [...new Set(failed.map((m) => m.component as FederatedComponent))],
    };
  }

  async run(goldens: FederatedGolden[]): Promise<FederatedEvalReport> {
    const cases: FederatedCaseResult[] = [];
    for (const g of goldens) cases.push(await this.runGolden(g));

    const sums: Record<string, { total: number; n: number }> = {};
    const componentFailures: Record<FederatedComponent, number> = { router: 0, retriever: 0, generator: 0 };
    for (const c of cases) {
      for (const m of c.metrics) {
        const slot = (sums[m.name] ??= { total: 0, n: 0 });
        slot.total += m.score;
        slot.n += 1;
        if (!m.passed) componentFailures[m.component as FederatedComponent] += 1;
      }
    }
    const metricMeans = Object.fromEntries(
      Object.entries(sums).map(([k, { total, n }]) => [k, Math.round((total / n) * 1000) / 1000]),
    );
    const passed = cases.filter((c) => c.passed).length;
    return {
      judge: this.judge.name,
      thresholds: this.thresholds,
      cases,
      totals: { cases: cases.length, passed, failed: cases.length - passed },
      metricMeans,
      componentFailures,
      passed: cases.length > 0 && passed === cases.length,
    };
  }
}

/**
 * Federated retriever seam for benchmark datasets: docIds are
 * `${shardKey}:${originFile}` (IDEA.v2 §10.4 — exact retrieval scoring
 * with shard attribution).
 */
export function federatedBenchmarkRetriever(
  org: FederatedEngine,
  opts: { limit?: number; maxShards?: number } = {},
) {
  return async (input: string): Promise<{ docId: string; body: string }[]> => {
    void keywordTerms(input); // term splitting happens inside hybridSearch
    const res = await org.search(input, {
      limit: opts.limit ?? 8,
      maxShards: opts.maxShards ?? 32,
      strict: true,
    });
    return res.hits.map((h) => ({ docId: `${h.shardKey}:${h.originFile ?? h.title}`, body: h.body }));
  };
}
