/**
 * Feature 2.1 — Graph/Cluster routing engine.
 *
 * Deterministic keyword-density scoring (Task 2.1.1): no embeddings, no
 * randomness — the same chunk always routes to the same cluster. Score is
 * keyword hits per 1000 chars, weighted by keyword length (longer
 * keywords are more specific). Ties break alphabetically by cluster name
 * so routing is total-order deterministic.
 */
import type { ClusterDef } from '../workers/protocol.js';

export interface RouteResult {
  cluster: string;
  score: number;
  /** per-cluster densities, useful for diagnostics */
  scores: Record<string, number>;
}

export interface RouterOptions {
  /** minimum density (weighted hits per 1000 chars) to leave 'general' */
  minDensity?: number;
}

export const GENERAL_CLUSTER = 'general';
const DEFAULT_MIN_DENSITY = 1.0;

export class ClusterRouter {
  private readonly defs: { name: string; patterns: { re: RegExp; weight: number }[] }[];
  private readonly minDensity: number;

  constructor(clusters: ClusterDef[], opts: RouterOptions = {}) {
    this.minDensity = opts.minDensity ?? DEFAULT_MIN_DENSITY;
    this.defs = [...clusters]
      .sort((a, b) => a.name.localeCompare(b.name)) // deterministic tie-break
      .map((c) => ({
        name: c.name,
        patterns: c.keywords.map((k) => ({
          // escape regex metachars; match case-insensitively anywhere
          // (substring semantics — mirrors the trigram index downstream)
          re: new RegExp(k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'),
          weight: Math.max(1, k.length / 4),
        })),
      }));
  }

  route(text: string): RouteResult {
    const scores: Record<string, number> = {};
    let best: { name: string; score: number } | null = null;
    const norm = 1000 / Math.max(1, text.length);

    for (const def of this.defs) {
      let hits = 0;
      for (const { re, weight } of def.patterns) {
        re.lastIndex = 0;
        const count = text.match(re)?.length ?? 0;
        hits += count * weight;
      }
      const density = hits * norm;
      scores[def.name] = density;
      if (density > (best?.score ?? 0)) best = { name: def.name, score: density };
    }

    // Task 2.1.2 — fallback when no cluster clears the threshold
    if (!best || best.score < this.minDensity) {
      return { cluster: GENERAL_CLUSTER, score: best?.score ?? 0, scores };
    }
    return { cluster: best.name, score: best.score, scores };
  }
}
