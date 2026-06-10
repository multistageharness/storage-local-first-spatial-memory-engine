/**
 * RagEvalHarness — the automated CI testing harness from the guide.
 *
 * Foundational rule (guide §"The Necessity of Dynamic Pipeline Execution"):
 * goldens hold STATIC inputs + expected outputs only; the actual output and
 * the retrieval context are produced DYNAMICALLY at the moment of test
 * execution, so any regression in chunking, indexing, ranking weights, or
 * generation is caught the instant it lands.
 *
 * Each golden is scored on the four component-isolated metrics against
 * numeric thresholds. A failing metric fails the case; a failing case fails
 * the run; a failing run is a deployment gate (non-zero exit upstream).
 * The report attributes failures to the retriever or the generator so the
 * failing subsystem is pinpointed, never guessed.
 */
import type { Golden } from './goldens.js';
import type { Judge } from './judge.js';
import { LexicalJudge } from './judge.js';
import type { GenerateFn } from './generator.js';
import { extractiveGenerator } from './generator.js';
import {
  answerRelevancy,
  contextualPrecision,
  contextualRecall,
  faithfulness,
  type MetricResult,
} from './metrics.js';

export type RetrieveFn = (input: string) => string[] | Promise<string[]>;

export interface Thresholds {
  contextualRecall: number;
  contextualPrecision: number;
  faithfulness: number;
  answerRelevancy: number;
}

/**
 * Guide-aligned defaults; the 0.5 faithfulness gate mirrors the worked
 * example. The answerRelevancy floor is calibrated to the lexical judge's
 * presence-vector cosine, where direct extractive answers land near ~0.3
 * and evasive answers at ~0.0.
 */
export const DEFAULT_THRESHOLDS: Thresholds = {
  contextualRecall: 0.7,
  contextualPrecision: 0.5,
  faithfulness: 0.5,
  answerRelevancy: 0.15,
};

export interface HarnessOptions {
  /** dynamic retrieval against the live application (NEVER pre-computed) */
  retrieve: RetrieveFn;
  /** dynamic generation over the freshly fetched context */
  generate?: GenerateFn;
  judge?: Judge;
  thresholds?: Partial<Thresholds>;
}

export interface CaseResult {
  input: string;
  expectedOutput: string;
  actualOutput: string;
  retrievalContext: string[];
  metrics: MetricResult[];
  passed: boolean;
  /** which subsystem(s) any failing metrics isolate to */
  failedComponents: ('retriever' | 'generator')[];
}

export interface EvalReport {
  judge: string;
  thresholds: Thresholds;
  cases: CaseResult[];
  totals: { cases: number; passed: number; failed: number };
  /** mean score per metric across all cases */
  metricMeans: Record<string, number>;
  /** failure counts attributed per component — the diagnosis */
  componentFailures: { retriever: number; generator: number };
  passed: boolean;
}

export class RagEvalHarness {
  private readonly retrieve: RetrieveFn;
  private readonly generate: GenerateFn;
  private readonly judge: Judge;
  private readonly thresholds: Thresholds;

  constructor(opts: HarnessOptions) {
    this.retrieve = opts.retrieve;
    this.generate = opts.generate ?? extractiveGenerator();
    this.judge = opts.judge ?? new LexicalJudge();
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...opts.thresholds };
  }

  /** Execute one golden dynamically and score all four metrics. */
  async runGolden(golden: Golden): Promise<CaseResult> {
    // dynamic execution — live retrieval, then live generation
    const retrievalContext = await this.retrieve(golden.input);
    const actualOutput = await this.generate(golden.input, retrievalContext);

    const metrics = await Promise.all([
      contextualRecall(
        { expectedOutput: golden.expectedOutput, retrievalContext },
        this.judge,
        this.thresholds.contextualRecall,
      ),
      contextualPrecision(
        { input: golden.input, expectedOutput: golden.expectedOutput, retrievalContext },
        this.judge,
        this.thresholds.contextualPrecision,
      ),
      faithfulness({ actualOutput, retrievalContext }, this.judge, this.thresholds.faithfulness),
      answerRelevancy({ input: golden.input, actualOutput }, this.judge, this.thresholds.answerRelevancy),
    ]);

    const failed = metrics.filter((m) => !m.passed);
    return {
      input: golden.input,
      expectedOutput: golden.expectedOutput,
      actualOutput,
      retrievalContext,
      metrics,
      passed: failed.length === 0,
      // this harness only runs retriever/generator metrics (the router
      // component belongs to the federated harness)
      failedComponents: [...new Set(failed.map((m) => m.component))] as ('retriever' | 'generator')[],
    };
  }

  /** Run the full golden set and aggregate into a gate report. */
  async run(goldens: Golden[]): Promise<EvalReport> {
    const cases: CaseResult[] = [];
    for (const golden of goldens) cases.push(await this.runGolden(golden));

    const metricMeans: Record<string, number> = {};
    const sums: Record<string, { total: number; n: number }> = {};
    const componentFailures = { retriever: 0, generator: 0 };
    for (const c of cases) {
      for (const m of c.metrics) {
        const slot = (sums[m.name] ??= { total: 0, n: 0 });
        slot.total += m.score;
        slot.n += 1;
        if (!m.passed) componentFailures[m.component as 'retriever' | 'generator'] += 1;
      }
    }
    for (const [name, { total, n }] of Object.entries(sums)) {
      metricMeans[name] = Math.round((total / n) * 1000) / 1000;
    }

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
 * Boolean-assertion helper for node:test — the "assert_test" of the guide's
 * Pytest harness. Throws with the failing metrics' reasons so the test
 * runner reports exactly which gate broke and which component is at fault.
 */
export function assertCase(result: CaseResult): void {
  if (result.passed) return;
  const failures = result.metrics
    .filter((m) => !m.passed)
    .map((m) => `${m.name} [${m.component}] ${m.score} < ${m.threshold}: ${m.reason}`)
    .join('; ');
  throw new Error(`eval gate failed for "${result.input}" — ${failures}`);
}
