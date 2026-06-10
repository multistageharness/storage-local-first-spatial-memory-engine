/**
 * Reference generators for the eval harness.
 *
 * The engine under test is a retrieval layer; a real deployment pairs it
 * with an LLM generator. For deterministic, offline evaluation the harness
 * ships an extractive generator that composes answers strictly from the
 * retrieved context — the generation contract a faithful LLM must satisfy.
 * Two wrappers cover the benchmark's behavioral gates:
 *
 *   - abstainingGenerator — refuses when retrieval confidence is too low,
 *     the correct behavior for "no-answer" benchmark cases (a RAG system
 *     must decline rather than hallucinate);
 *   - hallucinatingGenerator — a negative control that injects parametric
 *     "knowledge"; a correct Faithfulness gate MUST fail it.
 */
import { cosine, termVector, tokenize } from './metrics.js';

export type GenerateFn = (input: string, retrievalContext: string[]) => string | Promise<string>;

interface ScoredSentence {
  sentence: string;
  sim: number;
  order: number;
}

/**
 * Context sentences scored by TF-IDF-weighted cosine similarity to the
 * question, best first. The IDF is computed locally over the retrieved
 * context's own sentences: boilerplate tokens that saturate code corpora
 * (import paths, `module`, `exports`, …) appear in many sentences and get
 * down-weighted, while distinctive tokens — identifiers the question
 * actually asks about — dominate the match.
 */
export function scoreSentences(input: string, retrievalContext: string[]): ScoredSentence[] {
  const raw: { sentence: string; vec: Map<string, number>; order: number }[] = [];
  let order = 0;
  for (const chunk of retrievalContext) {
    for (const sentence of chunk.split(/(?<=[.!?;])\s+|\n+/)) {
      const trimmed = sentence.trim();
      const vec = termVector(trimmed);
      if (tokenize(trimmed).length < 2) continue;
      raw.push({ sentence: trimmed, vec, order: order++ });
    }
  }
  // document frequency per token across the context's sentences
  const df = new Map<string, number>();
  for (const s of raw) for (const tok of s.vec.keys()) df.set(tok, (df.get(tok) ?? 0) + 1);
  const n = raw.length || 1;
  const idf = (tok: string): number => Math.log(1 + n / (1 + (df.get(tok) ?? 0)));
  const weigh = (vec: Map<string, number>): Map<string, number> => {
    const out = new Map<string, number>();
    for (const [tok, tf] of vec) out.set(tok, tf * idf(tok));
    return out;
  };
  const question = weigh(termVector(input));
  return raw
    .map((s) => ({ sentence: s.sentence, sim: cosine(weigh(s.vec), question), order: s.order }))
    .sort((a, b) => b.sim - a.sim || a.order - b.order);
}

/**
 * Extractive generator — selects the context sentences most similar to the
 * question and answers with them verbatim. Zero parametric knowledge, so
 * every claim is rooted in the payload (faithful by construction).
 */
export function extractiveGenerator(maxSentences = 3): GenerateFn {
  return (input, retrievalContext) => {
    const top = scoreSentences(input, retrievalContext)
      .filter((s) => s.sim > 0)
      .slice(0, maxSentences)
      .sort((a, b) => a.order - b.order); // restore narrative order
    return top.map((s) => s.sentence).join(' ');
  };
}

/** Canonical refusal emitted when the context cannot support an answer. */
export const REFUSAL_TEXT = 'NO_ANSWER: the knowledge base does not contain information to answer this question.';

export function isRefusal(output: string): boolean {
  return output.trim() === '' || output.trimStart().startsWith('NO_ANSWER');
}

/**
 * Abstaining generator — answers extractively only when the best context
 * sentence clears a retrieval-confidence floor; otherwise it refuses with
 * REFUSAL_TEXT. This is the behavior the benchmark's negative ("no-answer")
 * cases gate on: declining beats hallucinating. (Truly unanswerable
 * questions usually retrieve nothing at all — the floor is a second line
 * of defense against weakly-related context, so it sits low enough not to
 * refuse legitimate multi-topic questions whose token mass is spread out.)
 */
export function abstainingGenerator(minRelevance = 0.12, maxSentences = 3): GenerateFn {
  const base = extractiveGenerator(maxSentences);
  return async (input, retrievalContext) => {
    const best = scoreSentences(input, retrievalContext)[0];
    if (!best || best.sim < minRelevance) return REFUSAL_TEXT;
    return base(input, retrievalContext);
  };
}

/**
 * Negative control — injects parametric "knowledge" absent from the context.
 * A correct Faithfulness metric MUST fail this generator even though the
 * injected text sounds plausible (the authority-bias trap).
 */
export function hallucinatingGenerator(base: GenerateFn = extractiveGenerator()): GenerateFn {
  return async (input, retrievalContext) => {
    const grounded = await base(input, retrievalContext);
    return (
      `${grounded} Additionally, industry benchmarks universally confirm this design ` +
      `delivers a guaranteed 47% latency reduction across all production deployments.`
    );
  };
}
