/**
 * Salient-term extraction — the query-construction step in front of the
 * AND-semantics FTS index (DEMO001 §8.5 / §13 "Full NL questions can't
 * hit an AND-semantics FTS index").
 *
 * Promoted from the eval retriever into the kernel in v2: federated
 * retrieval is per-term × per-shard, fused twice (IDEA.v2 Phase 9), so
 * the engine itself needs the term splitter.
 */

const QUERY_STOPWORDS = new Set([
  'and', 'are', 'about', 'does', 'for', 'from', 'has', 'have', 'how', 'implemented',
  'into', 'that', 'the', 'this', 'was', 'what', 'when', 'where', 'which', 'who',
  'why', 'will', 'with',
]);

/** Salient query terms: punctuation-trimmed words, ≥3 chars (trigram floor). */
export function keywordTerms(input: string, max = 8): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const raw of input.split(/\s+/)) {
    const term = raw.replace(/^[^A-Za-z0-9_]+|[^A-Za-z0-9_.]+$/g, '');
    const key = term.toLowerCase();
    if (term.length < 3 || QUERY_STOPWORDS.has(key) || seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
    if (terms.length >= max) break;
  }
  return terms;
}
