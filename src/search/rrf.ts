/**
 * Reciprocal Rank Fusion — the one fusion primitive used at every level
 * of the system (IDEA.v2 §5.2, §6.3, §7):
 *
 *   - per-term fusion inside a shard (demo001's retriever, DEMO001 §8.5)
 *   - trigram ∪ word ∪ vector lane fusion inside hybridSearch
 *   - cross-shard fusion in FederatedSearch
 *
 * RRF is rank-based by construction, which is exactly why it is the only
 * legal cross-shard fusion: BM25 scores are incomparable across shards
 * (per-shard corpus statistics), so raw score summation is forbidden
 * (IDEA.v2 §12 pitfall "Never sum BM25 across shards").
 */

export const RRF_K = 60;

export interface FusedHit<T> {
  item: T;
  /** Σ over lists containing the item of 1 / (k + rank), rank 1-based. */
  rrfScore: number;
  /** indexes of the contributing input lists, in input order */
  sources: number[];
}

/**
 * Fuse N ranked lists. `key` identifies the same logical item across
 * lists; the first list containing an item supplies its representative.
 * Ties break by (a) number of contributing sources desc, (b) best single
 * rank asc, (c) key string asc — total-order deterministic.
 */
export function rrfFuse<T>(
  lists: T[][],
  key: (item: T) => string,
  k: number = RRF_K,
): FusedHit<T>[] {
  const acc = new Map<string, { item: T; rrfScore: number; sources: number[]; bestRank: number }>();
  lists.forEach((list, listIdx) => {
    list.forEach((item, i) => {
      const rank = i + 1;
      const id = key(item);
      const cur = acc.get(id);
      if (cur) {
        cur.rrfScore += 1 / (k + rank);
        cur.sources.push(listIdx);
        cur.bestRank = Math.min(cur.bestRank, rank);
      } else {
        acc.set(id, { item, rrfScore: 1 / (k + rank), sources: [listIdx], bestRank: rank });
      }
    });
  });
  return [...acc.entries()]
    .sort(([ka, a], [kb, b]) => {
      if (b.rrfScore !== a.rrfScore) return b.rrfScore - a.rrfScore;
      if (b.sources.length !== a.sources.length) return b.sources.length - a.sources.length;
      if (a.bestRank !== b.bestRank) return a.bestRank - b.bestRank;
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    })
    .map(([, v]) => ({ item: v.item, rrfScore: v.rrfScore, sources: v.sources }));
}
