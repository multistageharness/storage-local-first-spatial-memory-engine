/**
 * IDEA.v2 §6.2 — ShardRouter: deterministic query → candidate-shard
 * scoring. This is demo001's ClusterRouter idea lifted one level: shards
 * are the clusters of the org graph.
 *
 * route(query):
 *   1. explicit hint (`space:ENG` / `repo:acme/payments` query syntax or
 *      a graphHint option) → exactly that shard — the Graph contextual
 *      firewall hint;
 *   2. else RRF over three ranked signals:
 *        (a) shard_terms FTS match rank (catalog mirror),
 *        (b) keyword-density of routing_terms vs the query — reusing
 *            ClusterRouter's scoring verbatim (DEMO001 §4.2),
 *        (c) recency-of-write prior (warm shards first, log-decay rank).
 *   3. top maxShards candidates; router recall is a gated metric.
 */
import { ClusterRouter } from '../spatial/router.js';
import { rrfFuse } from '../search/rrf.js';
import { keywordTerms } from '../search/terms.js';
import type { Catalog, ShardRow } from './catalog.js';

export interface RouteOptions {
  maxShards?: number;
  /** explicit shard pin, e.g. 'gh:acme/payments' or 'cf:ENG' */
  graphHint?: string;
  /**
   * relative density floor for candidate membership: shards scoring
   * below cutoff × best-density are dropped. Disabled (0) by default —
   * probe-wave deepening already bounds fan-out cost, and a hard floor
   * prunes secondary targets of multi-subject queries (cross-shard
   * recall regression). Kept as an opt-in for precision-tuned callers.
   */
  densityCutoff?: number;
}

export interface RouteResult {
  /** candidate shard keys, best first */
  shardKeys: string[];
  /** true when an explicit hint short-circuited scoring */
  pinned: boolean;
  /** the query with any hint syntax stripped */
  query: string;
}

/** `space:KEY` → cf:KEY; `repo:org/name` → gh:org/name; `shard:<key>` verbatim. */
export function parseHint(query: string): { hint: string | null; rest: string } {
  const m = query.match(/(?:^|\s)(space|repo|shard):(\S+)/);
  if (!m) return { hint: null, rest: query };
  const [, kind, value] = m;
  const hint = kind === 'space' ? `cf:${value}` : kind === 'repo' ? `gh:${value}` : value;
  return { hint, rest: query.replace(m[0], ' ').trim() };
}

export class ShardRouter {
  /**
   * Derived routing state is expensive to build (one regex per routing
   * term across every shard + JSON parse of every signature) — caching
   * it is the difference between sub-ms and tens-of-ms per route() call,
   * which under a 200-way storm is the difference between a working p95
   * and a main-thread pile-up. Invalidated via the catalog cache token
   * (own mutations + cross-process data_version).
   */
  private cache: { token: string; shards: ShardRow[]; densityRouter: ClusterRouter } | null = null;

  constructor(private readonly catalog: Catalog) {}

  private routingState(): { shards: ShardRow[]; densityRouter: ClusterRouter } {
    const token = this.catalog.cacheToken();
    if (!this.cache || this.cache.token !== token) {
      const shards = this.catalog.listShards().filter((s) => s.status !== 'EVICTED');
      this.cache = {
        token,
        shards,
        // density scoring runs per query on the main thread — score only
        // the distinctive HEAD of each signature (tf×idf already ranks
        // routing_terms best-first). The top-8 terms are repeated 3× so a
        // distinctive-term match (project codename grade) outweighs an
        // echo of org-wide shared vocabulary: ClusterRouter weighs
        // keywords by length only, and "subscription" must not outscore
        // a matched codename. The full 200-term signature stays in the
        // shard_terms FTS mirror for lane (a).
        densityRouter: new ClusterRouter(
          shards.map((s) => {
            const head = s.routingTerms.slice(0, 32);
            const distinctive = head.slice(0, 8);
            return { name: s.shardKey, keywords: [...distinctive, ...distinctive, ...head] };
          }),
          { minDensity: 0 },
        ),
      };
    }
    return this.cache;
  }

  route(query: string, opts: RouteOptions = {}): RouteResult {
    const maxShards = opts.maxShards ?? 32;
    const parsed = parseHint(query);
    const hint = opts.graphHint ?? parsed.hint;

    if (hint) {
      const shard = this.catalog.getShard(hint);
      if (shard) return { shardKeys: [shard.shardKey], pinned: true, query: parsed.rest || query };
      // unknown hint → fall through to scored routing on the full query
    }

    const q = parsed.rest || query;
    const { shards } = this.routingState();
    if (shards.length === 0) return { shardKeys: [], pinned: false, query: q };

    // IDEA.v2 Phase 9 — per-term × per-shard scope resolution: each
    // salient term of a multi-subject query nominates its own best
    // shards, and the nominations interleave round-robin so every
    // subject's top shard lands in the probe head (a fused-only ranking
    // would let one subject's echoes crowd the other subject out of the
    // probe waves entirely).
    const terms = keywordTerms(q);
    if (terms.length > 1) {
      const perTerm = terms.map((t) => this.scoreCandidates(t, maxShards, opts.densityCutoff ?? 0));
      const merged: string[] = [];
      const seen = new Set<string>();
      outer: for (let rank = 0; ; rank++) {
        let any = false;
        for (const list of perTerm) {
          if (rank >= list.length) continue;
          any = true;
          const key = list[rank];
          if (!seen.has(key)) {
            seen.add(key);
            merged.push(key);
            if (merged.length >= maxShards) break outer;
          }
        }
        if (!any) break;
      }
      if (merged.length > 0) return { shardKeys: merged, pinned: false, query: q };
      // no per-term signal → fall through to whole-query scoring/fallback
    }

    const ranked = this.scoreCandidates(q, maxShards, opts.densityCutoff ?? 0);
    if (ranked.length === 0) {
      // zero-signal queries get a small warm-shard hedge, not a full
      // fan-out — a 2,000-shard org cannot pay 32 cold opens for a
      // query nothing routes to (these are the abstention candidates)
      const recencyRanked = shards.map((s) => s.shardKey);
      return { shardKeys: recencyRanked.slice(0, Math.min(4, maxShards)), pinned: false, query: q };
    }
    return { shardKeys: ranked.slice(0, maxShards), pinned: false, query: q };
  }

  /**
   * Score one query text against all shards; returns RRF-fused,
   * signal-bearing candidates (best first), or [] when nothing routes.
   *
   * Aggressive spatial scoping (IDEA.v1): candidate MEMBERSHIP requires
   * a routing signal — recency only orders signal-bearing shards.
   * Probing all maxShards on every query would put the whole-org scan
   * back on the hot path.
   */
  private scoreCandidates(text: string, maxShards: number, cutoff: number): string[] {
    const { shards, densityRouter } = this.routingState();

    // (a) FTS rank over the shard_terms mirror
    const ftsRanked = this.catalog.searchShardTerms(text, Math.max(64, maxShards * 2)).map((r) => r.shardKey);

    // (b) ClusterRouter keyword-density scoring, verbatim reuse: one
    // "cluster" per shard, keywords = routing_terms head.
    const { scores } = densityRouter.route(text);
    const bestDensity = Math.max(0, ...Object.values(scores));
    const densityRanked = Object.entries(scores)
      .filter(([, score]) => score > 0 && score >= cutoff * bestDensity)
      .sort(([a, sa], [b, sb]) => sb - sa || (a < b ? -1 : 1))
      .map(([key]) => key);

    const signal = new Set([...ftsRanked, ...densityRanked]);
    if (signal.size === 0) return [];

    // (c) recency prior — a SLIGHT boost (ε-weighted), never an equal
    // voter: with one signal lane empty, an equal-weight recency list
    // would let any warm shard outvote the true match. listShards is
    // already updated_at DESC.
    const recencyRank = new Map<string, number>();
    shards.forEach((s, i) => recencyRank.set(s.shardKey, i + 1));

    const score = new Map<string, number>();
    ftsRanked.forEach((k, i) => score.set(k, (score.get(k) ?? 0) + 1 / (60 + i + 1)));
    densityRanked.forEach((k, i) => score.set(k, (score.get(k) ?? 0) + 1 / (60 + i + 1)));
    for (const k of signal) {
      score.set(k, (score.get(k) ?? 0) + 0.05 / (60 + (recencyRank.get(k) ?? shards.length)));
    }

    return [...score.entries()]
      .sort(([ka, a], [kb, b]) => b - a || (ka < kb ? -1 : ka > kb ? 1 : 0))
      .map(([k]) => k);
  }
}

export type { ShardRow };
