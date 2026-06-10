/**
 * Judge abstraction — the "LLM-as-a-judge" seam of the eval harness.
 *
 * The guide's bias catalogue (verbosity, position, self-preference,
 * authority, criteria drift) is mitigated structurally:
 *
 *   - Judge is an interface, so the judge model family can always be chosen
 *     independently of the generator under test (self-preference bias).
 *   - JudgeJury polls an odd committee and takes a strict majority vote,
 *     reducing the noise/instability of any single judge (jury consensus).
 *   - The default LexicalJudge is deterministic and local-first: verdicts
 *     are support *fractions*, never raw match counts, so longer answers
 *     gain nothing by padding (verbosity bias) and scoring cannot drift
 *     between runs (criteria drift).
 *
 * All verdicts are binary (the guide's simplified YES/NO judging — cheap,
 * fast, and CI-friendly) and async so remote judges can slot in.
 */
import { cosine, termVector, tokenize } from './metrics.js';

export interface Judge {
  readonly name: string;
  /** Break text into atomic, individually verifiable statements. */
  decomposeStatements(text: string): Promise<string[]>;
  /** YES/NO — is the statement supported by the context payload? */
  isAttributable(statement: string, contexts: string[]): Promise<boolean>;
  /** YES/NO — does the chunk carry evidence toward the expected output? */
  isRelevant(chunk: string, input: string, expectedOutput?: string): Promise<boolean>;
  /** RAGAS reverse-engineering: derive up to n questions solely from the answer. */
  reverseEngineerQuestions(answer: string, n: number): Promise<string[]>;
}

export interface LexicalJudgeOptions {
  /** fraction of a statement's content tokens that must appear in context */
  attributionThreshold?: number;
  /** cosine floor for chunk-vs-expected-output relevance */
  relevanceThreshold?: number;
}

/**
 * Deterministic, zero-network judge over local term vectors. Keeps the
 * harness runnable offline (local-first, like the engine itself) and gives
 * CI a stable baseline; an LLM judge can replace it without touching the
 * metric math.
 */
export class LexicalJudge implements Judge {
  readonly name: string;
  private readonly attributionThreshold: number;
  private readonly relevanceThreshold: number;

  constructor(opts: LexicalJudgeOptions = {}) {
    this.attributionThreshold = opts.attributionThreshold ?? 0.7;
    this.relevanceThreshold = opts.relevanceThreshold ?? 0.2;
    this.name = `lexical(attr=${this.attributionThreshold},rel=${this.relevanceThreshold})`;
  }

  async decomposeStatements(text: string): Promise<string[]> {
    return text
      .split(/(?<=[.!?;])\s+|\n+/)
      .map((s) => s.trim())
      .filter((s) => tokenize(s).length >= 2);
  }

  async isAttributable(statement: string, contexts: string[]): Promise<boolean> {
    const tokens = tokenize(statement);
    if (tokens.length === 0) return false;
    // union of context tokens — a statement may stitch adjacent facts
    const support = new Set<string>();
    for (const ctx of contexts) for (const tok of tokenize(ctx)) support.add(tok);
    const present = tokens.filter((t) => support.has(t)).length;
    return present / tokens.length >= this.attributionThreshold;
  }

  async isRelevant(chunk: string, input: string, expectedOutput?: string): Promise<boolean> {
    // a chunk is relevant when it carries evidence for the expected output
    // (or, reference-free, for the input itself)
    const target = expectedOutput ?? input;
    const sim = cosine(termVector(chunk), termVector(target));
    if (sim >= this.relevanceThreshold) return true;
    // identifier-grade evidence: any expected statement fully inside the chunk
    const statements = await this.decomposeStatements(target);
    for (const s of statements) {
      if (await this.isAttributable(s, [chunk])) return true;
    }
    return false;
  }

  async reverseEngineerQuestions(answer: string, n: number): Promise<string[]> {
    const statements = await this.decomposeStatements(answer);
    // salient-term question per statement ("What <content terms>?") — the
    // interrogative itself is a stopword, so only the statement's terms count
    return statements.slice(0, n).map((s) => `What ${tokenize(s).join(' ')}?`);
  }
}

/**
 * Judge jury — aggregated consensus flow for mission-critical thresholds.
 * Polls every juror and takes a strict majority on each binary verdict;
 * for question generation it defers to the first juror (generation is not
 * a vote). An odd jury size avoids ties; even sizes break toward NO, the
 * conservative verdict.
 */
export class JudgeJury implements Judge {
  readonly name: string;

  constructor(private readonly jurors: Judge[]) {
    if (jurors.length === 0) throw new Error('JudgeJury requires at least one juror');
    this.name = `jury(${jurors.map((j) => j.name).join(', ')})`;
  }

  private async majority(votes: Promise<boolean>[]): Promise<boolean> {
    const tally = await Promise.all(votes);
    return tally.filter(Boolean).length * 2 > tally.length;
  }

  async decomposeStatements(text: string): Promise<string[]> {
    return this.jurors[0].decomposeStatements(text);
  }

  async isAttributable(statement: string, contexts: string[]): Promise<boolean> {
    return this.majority(this.jurors.map((j) => j.isAttributable(statement, contexts)));
  }

  async isRelevant(chunk: string, input: string, expectedOutput?: string): Promise<boolean> {
    return this.majority(this.jurors.map((j) => j.isRelevant(chunk, input, expectedOutput)));
  }

  async reverseEngineerQuestions(answer: string, n: number): Promise<string[]> {
    return this.jurors[0].reverseEngineerQuestions(answer, n);
  }
}
