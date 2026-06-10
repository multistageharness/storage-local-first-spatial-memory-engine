/**
 * RAG evaluation metrics — component-isolated scoring per the
 * ".feature/RAG Evaluation Harness Setup Guide":
 *
 *   Retriever:  Contextual Recall    (are all required facts present?)
 *               Contextual Precision (are the relevant chunks ranked on top?)
 *   Generator:  Faithfulness         (is every claim rooted in the context?)
 *               Answer Relevancy     (does the answer address the question?)
 *
 * All four metrics delegate qualitative verdicts (statement decomposition,
 * attribution, relevance) to a pluggable Judge so the same math can run
 * against the deterministic local judge, a remote LLM judge, or a jury.
 */
import type { Judge } from './judge.js';

// ---- local term-vector embedding -----------------------------------------

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'do', 'does', 'for', 'from',
  'has', 'have', 'how', 'in', 'is', 'it', 'its', 'of', 'on', 'or', 'that',
  'the', 'this', 'to', 'was', 'what', 'when', 'where', 'which', 'who', 'why',
  'will', 'with',
]);

/** Lower-cased content tokens; camelCase / snake_case identifiers are split. */
export function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/** Sparse term-frequency vector — the local, deterministic "embedding". */
export function termVector(text: string): Map<string, number> {
  const vec = new Map<string, number>();
  for (const tok of tokenize(text)) vec.set(tok, (vec.get(tok) ?? 0) + 1);
  return vec;
}

/**
 * Term-presence (binary) vector — used where repeated tokens must not
 * dominate the norm (code bodies repeat identifiers heavily, which would
 * drown the question terms under raw term frequency).
 */
export function presenceVector(text: string): Map<string, number> {
  const vec = new Map<string, number>();
  for (const tok of tokenize(text)) vec.set(tok, 1);
  return vec;
}

export function cosine(a: Map<string, number>, b: Map<string, number>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const [tok, fa] of a) {
    normA += fa * fa;
    const fb = b.get(tok);
    if (fb) dot += fa * fb;
  }
  for (const fb of b.values()) normB += fb * fb;
  return dot === 0 ? 0 : dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ---- metric plumbing ------------------------------------------------------

export interface MetricResult {
  /** metric identifier, e.g. "contextualPrecision" */
  name: string;
  /**
   * component the metric isolates — pinpoints the failing subsystem.
   * v2 adds 'router' (IDEA.v2 §10.3): federated failure attribution is
   * three-way — router vs retriever vs generator.
   */
  component: 'router' | 'retriever' | 'generator';
  /** score in [0, 1] */
  score: number;
  threshold: number;
  passed: boolean;
  reason: string;
}

function result(
  name: string,
  component: 'retriever' | 'generator',
  score: number,
  threshold: number,
  reason: string,
): MetricResult {
  const rounded = Math.round(score * 1000) / 1000;
  return { name, component, score: rounded, threshold, passed: rounded >= threshold, reason };
}

// ---- retriever metrics ----------------------------------------------------

/**
 * Contextual Recall — fraction of expected-output statements attributable to
 * the retrieved context. Low recall = the knowledge is missing from the
 * fetched top-K payload, so no generator could answer completely.
 */
export async function contextualRecall(
  args: { expectedOutput: string; retrievalContext: string[] },
  judge: Judge,
  threshold: number,
): Promise<MetricResult> {
  const statements = await judge.decomposeStatements(args.expectedOutput);
  if (statements.length === 0) {
    return result('contextualRecall', 'retriever', 0, threshold, 'expected output decomposed to zero statements');
  }
  let attributable = 0;
  const missing: string[] = [];
  for (const s of statements) {
    if (await judge.isAttributable(s, args.retrievalContext)) attributable += 1;
    else missing.push(s);
  }
  const score = attributable / statements.length;
  const reason =
    missing.length === 0
      ? `all ${statements.length} expected statement(s) found in retrieved context`
      : `${missing.length}/${statements.length} expected statement(s) missing from context, e.g. "${missing[0].slice(0, 80)}"`;
  return result('contextualRecall', 'retriever', score, threshold, reason);
}

/**
 * Contextual Precision — rank-weighted precision over the retrieved chunks
 * (the DeepEval formulation): for each relevant chunk at rank k, credit the
 * precision-at-k, then normalize by the number of relevant chunks. Relevant
 * chunks buried beneath noise score low even when recall is perfect, because
 * context overload is a leading cause of downstream hallucination.
 */
export async function contextualPrecision(
  args: { input: string; expectedOutput: string; retrievalContext: string[] },
  judge: Judge,
  threshold: number,
): Promise<MetricResult> {
  if (args.retrievalContext.length === 0) {
    return result('contextualPrecision', 'retriever', 0, threshold, 'no context retrieved');
  }
  const relevant: boolean[] = [];
  for (const chunk of args.retrievalContext) {
    relevant.push(await judge.isRelevant(chunk, args.input, args.expectedOutput));
  }
  const totalRelevant = relevant.filter(Boolean).length;
  if (totalRelevant === 0) {
    return result('contextualPrecision', 'retriever', 0, threshold, 'no relevant chunk in retrieved context');
  }
  let seen = 0;
  let sum = 0;
  for (let k = 0; k < relevant.length; k++) {
    if (relevant[k]) {
      seen += 1;
      sum += seen / (k + 1); // precision@k, credited only at relevant ranks
    }
  }
  const score = sum / totalRelevant;
  const firstNoise = relevant.indexOf(false);
  const reason =
    score === 1
      ? `all ${totalRelevant} relevant chunk(s) ranked on top`
      : `${totalRelevant}/${relevant.length} chunks relevant; first noise at rank ${firstNoise + 1}`;
  return result('contextualPrecision', 'retriever', score, threshold, reason);
}

// ---- generator metrics ----------------------------------------------------

/**
 * Faithfulness — fraction of actual-output claims strictly rooted in the
 * retrieved context. External knowledge is penalized even when factually
 * correct: the engine must answer from its authoritative local corpus, not
 * parametric memory.
 */
export async function faithfulness(
  args: { actualOutput: string; retrievalContext: string[] },
  judge: Judge,
  threshold: number,
): Promise<MetricResult> {
  const claims = await judge.decomposeStatements(args.actualOutput);
  if (claims.length === 0) {
    return result('faithfulness', 'generator', 0, threshold, 'actual output decomposed to zero claims');
  }
  let grounded = 0;
  const hallucinated: string[] = [];
  for (const c of claims) {
    if (await judge.isAttributable(c, args.retrievalContext)) grounded += 1;
    else hallucinated.push(c);
  }
  const score = grounded / claims.length;
  const reason =
    hallucinated.length === 0
      ? `all ${claims.length} claim(s) grounded in retrieved context`
      : `${hallucinated.length}/${claims.length} claim(s) not grounded, e.g. "${hallucinated[0].slice(0, 80)}"`;
  return result('faithfulness', 'generator', score, threshold, reason);
}

/**
 * Answer Relevancy — the RAGAS reverse-engineering technique: the judge
 * generates N artificial questions solely from the actual output, and the
 * score is the mean cosine similarity between each artificial question and
 * the original input. Direct, complete answers reverse-engineer back to the
 * original question; evasive or padded answers drift away. Factuality is
 * deliberately NOT considered here — that is Faithfulness's job.
 */
export async function answerRelevancy(
  args: { input: string; actualOutput: string },
  judge: Judge,
  threshold: number,
  n = 3,
): Promise<MetricResult> {
  const artificial = await judge.reverseEngineerQuestions(args.actualOutput, n);
  if (artificial.length === 0) {
    return result('answerRelevancy', 'generator', 0, threshold, 'no artificial questions derivable from output');
  }
  // presence vectors: repeated identifiers in code answers must not drown
  // the question terms under raw term frequency
  const original = presenceVector(args.input);
  const sims = artificial.map((q) => cosine(presenceVector(q), original));
  const score = sims.reduce((a, b) => a + b, 0) / sims.length;
  const reason = `mean cosine over ${artificial.length} reverse-engineered question(s): ${score.toFixed(3)}`;
  return result('answerRelevancy', 'generator', score, threshold, reason);
}
