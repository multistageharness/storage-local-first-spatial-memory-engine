/**
 * Retrieval adapter — bridges natural-language golden inputs to the
 * engine's exact-match lexical search.
 *
 * The FTS5 query layer ANDs every term (see search/query.ts), so a full
 * question like "What does verifySignatureV3 do in auth-module.ts?" can
 * never match a document verbatim. A real RAG deployment puts a query-
 * construction step in front of the retriever; this adapter is that step
 * for the eval harness, kept deterministic and local-first:
 *
 *   1. extract salient keyword terms from the question (stopwords and
 *      sub-trigram fragments dropped, identifiers kept verbatim);
 *   2. run one engine search per term;
 *   3. fuse the per-term rankings with Reciprocal Rank Fusion, so chunks
 *      matching several question terms rise to the top.
 *
 * Because the adapter sits inside the dynamically-executed pipeline, its
 * regressions are caught by the same Contextual Recall/Precision gates as
 * the index itself.
 */
import type { SearchHit } from '../../src/workers/protocol.js';
import type { RetrieveFn } from './harness.js';
// v2: term extraction promoted into the kernel (src/search/terms.ts) so the
// federated per-term × per-shard pipeline can use it; re-exported here so
// the demo001 eval surface is unchanged.
import { keywordTerms } from '../../src/search/terms.js';

export { keywordTerms };

export interface EngineLike {
  search(query: string, opts?: { limit?: number }): Promise<SearchHit[]>;
}

export interface EngineRetrieverOptions {
  /** chunks returned to the generator (the harness's top-K) */
  limit?: number;
  /** hits fetched per extracted term before fusion */
  perTermLimit?: number;
}

/** Reciprocal Rank Fusion constant — standard k=60. */
const RRF_K = 60;

/** Hit-level fusion: per-term FTS5 searches merged by RRF, best first. */
export async function fuseSearchHits(
  engine: EngineLike,
  input: string,
  opts: EngineRetrieverOptions = {},
): Promise<SearchHit[]> {
  const limit = opts.limit ?? 5;
  const perTermLimit = opts.perTermLimit ?? limit;
  const terms = keywordTerms(input);
  if (terms.length === 0) return [];
  const fused = new Map<number, { score: number; hit: SearchHit }>();
  for (const term of terms) {
    const hits = await engine.search(term, { limit: perTermLimit });
    hits.forEach((hit, rank) => {
      const entry = fused.get(hit.id) ?? { score: 0, hit };
      entry.score += 1 / (RRF_K + rank + 1);
      fused.set(hit.id, entry);
    });
  }
  return [...fused.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((e) => e.hit);
}

export function engineRetriever(engine: EngineLike, opts: EngineRetrieverOptions = {}): RetrieveFn {
  return async (input: string) => (await fuseSearchHits(engine, input, opts)).map((h) => h.body);
}

/** A retrieved chunk annotated with its source document id (the doc title). */
export interface RetrievedChunk {
  docId: string;
  body: string;
}

export type BenchmarkRetrieveFn = (input: string) => Promise<RetrievedChunk[]> | RetrievedChunk[];

/**
 * Benchmark variant — keeps the source document id with every chunk so the
 * runner can score retrieval against a case's annotated supporting docs
 * (exact ground truth, no judge needed).
 */
export function benchmarkRetriever(engine: EngineLike, opts: EngineRetrieverOptions = {}): BenchmarkRetrieveFn {
  return async (input: string) =>
    (await fuseSearchHits(engine, input, opts)).map((h) => ({ docId: h.title, body: h.body }));
}
