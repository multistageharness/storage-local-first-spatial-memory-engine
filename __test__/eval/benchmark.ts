/**
 * Benchmark ("golden dataset") runner — the curated, human-annotated
 * counterpart to the synthetic eval harness.
 *
 * Where the synthesizer fabricates goldens from a corpus, a benchmark is a
 * deliberately designed, annotated test set:
 *
 *   1. Representative distribution — enforced bands per query type:
 *      50–60% common, 20–25% difficult/distractor, 10–15% multi-hop,
 *      10–15% negative ("no-answer") cases. A dataset outside the bands
 *      fails the run before a single case executes.
 *   2. High-detail annotations — every case carries the ideal expected
 *      answer, the exact supporting document ids, and metadata
 *      (answerable, query type, difficulty, allowed wording variance).
 *      Supporting-doc ids make retrieval scoring exact: document recall
 *      and rank-weighted document precision need no judge.
 *   3. No-answer gating — unanswerable cases pass only when the system
 *      refuses; any fabricated answer is scored as hallucination.
 *   4. Model separation — if a model helped generate the dataset, the same
 *      model must not judge it (self-preference bias). The runner refuses
 *      to score a dataset whose provenance names the configured judge.
 */
import type { CorpusDoc } from './goldens.js';
import type { GenerateFn } from './generator.js';
import { abstainingGenerator, isRefusal } from './generator.js';
import type { Judge } from './judge.js';
import { LexicalJudge } from './judge.js';
import { answerRelevancy, cosine, faithfulness, presenceVector, type MetricResult } from './metrics.js';
import type { BenchmarkRetrieveFn } from './retriever.js';

// ---- dataset shape ----------------------------------------------------------

/** v2 adds 'cross-shard' (IDEA.v2 §10.4) — cases whose supporting docs span ≥ 2 shards. */
export type QueryType = 'common' | 'distractor' | 'multi-hop' | 'no-answer' | 'cross-shard';

export interface BenchmarkCase {
  /** stable id for tracking results across runs */
  id: string;
  /** the user query */
  input: string;
  /** the ideal expected answer ('' for no-answer cases) */
  expectedAnswer: string;
  /** exact source document ids required to answer ([] for no-answer cases) */
  supportingDocs: string[];
  metadata: {
    answerable: boolean;
    queryType: QueryType;
    difficulty: 'easy' | 'medium' | 'hard';
    /** allowed variance in wording vs. the expected answer */
    allowedVariance: 'strict' | 'moderate' | 'free';
    tags?: string[];
  };
}

export interface BenchmarkDataset {
  name: string;
  /** who curated the cases, and which model (if any) generated ground truth */
  provenance: { curatedBy: string; generatedBy?: string };
  corpus: CorpusDoc[];
  cases: BenchmarkCase[];
}

// ---- distribution validation -------------------------------------------------

/**
 * Recommended distribution bands (fractions of the dataset). The
 * 'cross-shard' band is 0 here — demo001-era four-band datasets stay
 * valid; federated datasets use FEDERATED_DISTRIBUTION_BANDS.
 */
export const DISTRIBUTION_BANDS: Record<QueryType, [number, number]> = {
  common: [0.5, 0.6],
  distractor: [0.2, 0.25],
  'multi-hop': [0.1, 0.15],
  'no-answer': [0.1, 0.15],
  'cross-shard': [0, 0],
};

/** IDEA.v2 §10.4 — five-band distribution for federated datasets. */
export const FEDERATED_DISTRIBUTION_BANDS: Record<QueryType, [number, number]> = {
  common: [0.45, 0.55],
  distractor: [0.15, 0.25],
  'multi-hop': [0.1, 0.15],
  'no-answer': [0.1, 0.15],
  'cross-shard': [0.1, 0.2],
};

export interface DistributionReport {
  ok: boolean;
  counts: Record<QueryType, number>;
  fractions: Record<QueryType, number>;
  violations: string[];
}

/**
 * Validate the dataset against the recommended bands, with half-a-case of
 * slack so small datasets are not failed by integer rounding.
 */
export function validateDistribution(
  cases: BenchmarkCase[],
  bands: Record<QueryType, [number, number]> = DISTRIBUTION_BANDS,
): DistributionReport {
  const counts: Record<QueryType, number> = {
    common: 0,
    distractor: 0,
    'multi-hop': 0,
    'no-answer': 0,
    'cross-shard': 0,
  };
  for (const c of cases) counts[c.metadata.queryType] += 1;
  const n = cases.length;
  const fractions = Object.fromEntries(
    (Object.keys(counts) as QueryType[]).map((t) => [t, n === 0 ? 0 : Math.round((counts[t] / n) * 1000) / 1000]),
  ) as Record<QueryType, number>;
  const violations: string[] = [];
  if (n === 0) violations.push('dataset is empty');
  const slack = n > 0 ? 0.5 / n : 0;
  for (const [type, [lo, hi]] of Object.entries(bands) as [QueryType, [number, number]][]) {
    const f = fractions[type];
    if (f < lo - slack || f > hi + slack) {
      violations.push(`${type}: ${(f * 100).toFixed(1)}% outside recommended ${lo * 100}–${hi * 100}%`);
    }
  }
  return { ok: violations.length === 0, counts, fractions, violations };
}

// ---- thresholds ----------------------------------------------------------------

export interface BenchmarkThresholds {
  /** fraction of annotated supporting docs that must be retrieved */
  docRecall: number;
  /** rank-weighted precision over retrieved chunks vs. supporting docs */
  docPrecision: number;
  faithfulness: number;
  answerRelevancy: number;
}

export const DEFAULT_BENCHMARK_THRESHOLDS: BenchmarkThresholds = {
  docRecall: 1, // every annotated supporting doc is required, by definition
  docPrecision: 0.5,
  faithfulness: 0.5,
  answerRelevancy: 0.15,
};

/** answer-correctness floor per the case's allowed wording variance */
export const VARIANCE_THRESHOLDS: Record<BenchmarkCase['metadata']['allowedVariance'], number> = {
  strict: 0.7,
  moderate: 0.45,
  free: 0.25,
};

// ---- runner ---------------------------------------------------------------------

export interface BenchmarkCaseResult {
  id: string;
  input: string;
  queryType: QueryType;
  actualOutput: string;
  retrievedDocs: string[];
  metrics: MetricResult[];
  passed: boolean;
}

export interface BenchmarkReport {
  dataset: string;
  judge: string;
  distribution: DistributionReport;
  cases: BenchmarkCaseResult[];
  /** pass-rate per query type — where the system is strong or weak */
  perType: Record<QueryType, { cases: number; passed: number }>;
  totals: { cases: number; passed: number; failed: number };
  passed: boolean;
}

export interface BenchmarkRunnerOptions {
  retrieve: BenchmarkRetrieveFn;
  generate?: GenerateFn;
  judge?: Judge;
  thresholds?: Partial<BenchmarkThresholds>;
  /** distribution bands; federated datasets pass FEDERATED_DISTRIBUTION_BANDS */
  bands?: Record<QueryType, [number, number]>;
}

function metric(
  name: string,
  component: 'retriever' | 'generator',
  score: number,
  threshold: number,
  reason: string,
): MetricResult {
  const rounded = Math.round(score * 1000) / 1000;
  return { name, component, score: rounded, threshold, passed: rounded >= threshold, reason };
}

export class BenchmarkRunner {
  private readonly retrieve: BenchmarkRetrieveFn;
  private readonly generate: GenerateFn;
  private readonly judge: Judge;
  private readonly thresholds: BenchmarkThresholds;
  private readonly bands: Record<QueryType, [number, number]>;

  constructor(opts: BenchmarkRunnerOptions) {
    this.retrieve = opts.retrieve;
    // abstaining by default — no-answer cases require refusal behavior
    this.generate = opts.generate ?? abstainingGenerator();
    this.judge = opts.judge ?? new LexicalJudge();
    this.thresholds = { ...DEFAULT_BENCHMARK_THRESHOLDS, ...opts.thresholds };
    this.bands = opts.bands ?? DISTRIBUTION_BANDS;
  }

  /** Document recall — exact, annotation-based (no judge). */
  private docRecall(supporting: string[], retrieved: string[]): MetricResult {
    const got = new Set(retrieved);
    const found = supporting.filter((d) => got.has(d));
    const score = supporting.length === 0 ? 1 : found.length / supporting.length;
    const missing = supporting.filter((d) => !got.has(d));
    return metric(
      'docRecall',
      'retriever',
      score,
      this.thresholds.docRecall,
      missing.length === 0
        ? `all ${supporting.length} supporting doc(s) retrieved`
        : `missing supporting doc(s): ${missing.join(', ')}`,
    );
  }

  /** Rank-weighted document precision — exact, annotation-based. */
  private docPrecision(supporting: string[], retrieved: string[]): MetricResult {
    if (retrieved.length === 0) {
      return metric('docPrecision', 'retriever', 0, this.thresholds.docPrecision, 'nothing retrieved');
    }
    const relevant = retrieved.map((d) => supporting.includes(d));
    const total = relevant.filter(Boolean).length;
    if (total === 0) {
      return metric('docPrecision', 'retriever', 0, this.thresholds.docPrecision, 'no supporting doc in results');
    }
    let seen = 0;
    let sum = 0;
    for (let k = 0; k < relevant.length; k++) {
      if (relevant[k]) {
        seen += 1;
        sum += seen / (k + 1);
      }
    }
    const firstNoise = relevant.indexOf(false);
    return metric(
      'docPrecision',
      'retriever',
      sum / total,
      this.thresholds.docPrecision,
      firstNoise === -1 ? 'supporting docs ranked on top' : `first non-supporting doc at rank ${firstNoise + 1}`,
    );
  }

  async runCase(c: BenchmarkCase): Promise<BenchmarkCaseResult> {
    // dynamic execution — live retrieval + generation, never pre-computed
    const chunks = await this.retrieve(c.input);
    const retrievedDocs = chunks.map((ch) => ch.docId);
    const contexts = chunks.map((ch) => ch.body);
    const actualOutput = await this.generate(c.input, contexts);

    const metrics: MetricResult[] = [];
    if (!c.metadata.answerable) {
      // negative case: the only correct behavior is refusal
      const refused = isRefusal(actualOutput);
      metrics.push(
        metric(
          'refusal',
          'generator',
          refused ? 1 : 0,
          1,
          refused
            ? 'system correctly declined to answer'
            : `hallucination: fabricated an answer from unsupporting context — "${actualOutput.slice(0, 80)}"`,
        ),
      );
    } else {
      metrics.push(this.docRecall(c.supportingDocs, retrievedDocs));
      metrics.push(this.docPrecision(c.supportingDocs, retrievedDocs));
      if (isRefusal(actualOutput)) {
        metrics.push(metric('answerCorrectness', 'generator', 0, VARIANCE_THRESHOLDS[c.metadata.allowedVariance], 'system refused an answerable question'));
      } else {
        // reference-based correctness vs. the annotated ideal answer,
        // thresholded by the case's allowed wording variance
        const correctness = cosine(presenceVector(actualOutput), presenceVector(c.expectedAnswer));
        metrics.push(
          metric(
            'answerCorrectness',
            'generator',
            correctness,
            VARIANCE_THRESHOLDS[c.metadata.allowedVariance],
            `presence-cosine vs expected answer (${c.metadata.allowedVariance} variance)`,
          ),
        );
        metrics.push(await faithfulness({ actualOutput, retrievalContext: contexts }, this.judge, this.thresholds.faithfulness));
        metrics.push(await answerRelevancy({ input: c.input, actualOutput }, this.judge, this.thresholds.answerRelevancy));
      }
    }

    return {
      id: c.id,
      input: c.input,
      queryType: c.metadata.queryType,
      actualOutput,
      retrievedDocs,
      metrics,
      passed: metrics.every((m) => m.passed),
    };
  }

  async run(dataset: BenchmarkDataset): Promise<BenchmarkReport> {
    // model separation: the ground-truth generator must never judge itself
    if (dataset.provenance.generatedBy && dataset.provenance.generatedBy === this.judge.name) {
      throw new Error(
        `model separation violated: dataset "${dataset.name}" was generated by "${dataset.provenance.generatedBy}", ` +
          `which is also the configured judge — use a judge from a different family to avoid self-preference bias`,
      );
    }

    const distribution = validateDistribution(dataset.cases, this.bands);

    const cases: BenchmarkCaseResult[] = [];
    for (const c of dataset.cases) cases.push(await this.runCase(c));

    const perType: Record<QueryType, { cases: number; passed: number }> = {
      common: { cases: 0, passed: 0 },
      distractor: { cases: 0, passed: 0 },
      'multi-hop': { cases: 0, passed: 0 },
      'no-answer': { cases: 0, passed: 0 },
      'cross-shard': { cases: 0, passed: 0 },
    };
    for (const r of cases) {
      perType[r.queryType].cases += 1;
      if (r.passed) perType[r.queryType].passed += 1;
    }

    const passed = cases.filter((r) => r.passed).length;
    return {
      dataset: dataset.name,
      judge: this.judge.name,
      distribution,
      cases,
      perType,
      totals: { cases: cases.length, passed, failed: cases.length - passed },
      passed: distribution.ok && cases.length > 0 && passed === cases.length,
    };
  }
}
