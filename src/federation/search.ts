/**
 * IDEA.v2 §6.3 — FederatedSearch: route → fan out → fuse.
 *
 * BM25 scores are NOT comparable across shards (per-shard corpus
 * statistics) — cross-shard fusion is rank-based RRF only, never raw
 * score summation (IDEA.v2 §12 pitfall).
 *
 * Straggler policy: the first quorum = ceil(0.8 × probed) shards within
 * timeoutMs are fused immediately; late results are logged, not awaited.
 * strict:true awaits all probed shards — recall gates MUST use it or
 * they measure the straggler policy, not retrieval (IDEA.v2 §12).
 */
import { availableParallelism } from 'node:os';
import { rrfFuse } from '../search/rrf.js';
import type { HybridSearchHit, HybridSource } from '../workers/protocol.js';
import type { ShardRouter } from './router.js';

export interface FederatedHit {
  shardKey: string;
  nodeId: number;
  cluster: string;
  title: string;
  originFile: string | null;
  chunkIndex: number;
  body: string;
  snippet: string;
  /** cross-shard RRF score (rank-based; per-shard scores are incomparable) */
  rrfScore: number;
  /** lane provenance from the in-shard hybrid fusion */
  sources: HybridSource[];
  /** rank inside its home shard's result list (1-based) */
  shardRank: number;
}

export interface FederatedSearchOptions {
  limit?: number;
  maxShards?: number;
  perShardLimit?: number;
  timeoutMs?: number;
  /** await every probed shard (gates asserting exact recall) */
  strict?: boolean;
  /** pin to one shard (Graph firewall) */
  shard?: string;
  /** in-shard cluster scope */
  cluster?: string;
  /**
   * probe-wave size for iterative deepening: candidates are probed in
   * rank-ordered waves of this size; once a wave has produced any hit,
   * deeper (lower-ranked) waves are skipped — aggressive spatial scoping
   * applied to the fan-out itself. Lower-ranked shards can only echo
   * weaker matches, so the trade is bounded and the recall gates verify
   * it stays above target. Default 4; set ≥ maxShards to always probe
   * every candidate.
   */
  probeWave?: number;
}

export interface FederatedSearchResult {
  hits: FederatedHit[];
  /** shards the router selected */
  probed: string[];
  /** shards whose results made the fusion */
  fusedFrom: string[];
  /** shards that missed the quorum window (logged, not awaited) */
  stragglers: string[];
  pinned: boolean;
}

/** Probe seam: tests inject latency/faults; production binds the ShardPool. */
export type ShardProbe = (
  shardKey: string,
  query: string,
  opts: { limit: number; cluster?: string },
) => Promise<HybridSearchHit[]>;

export class FederatedSearch {
  constructor(
    private readonly router: ShardRouter,
    private readonly probe: ShardProbe,
    private readonly log: (msg: string) => void = () => {},
  ) {}

  async search(query: string, opts: FederatedSearchOptions = {}): Promise<FederatedSearchResult> {
    const limit = opts.limit ?? 20;
    const perShardLimit = opts.perShardLimit ?? 10;
    const timeoutMs = opts.timeoutMs ?? 300;
    const strict = opts.strict ?? false;
    const probeWave = Math.max(1, opts.probeWave ?? 4);

    const routed = this.router.route(query, {
      maxShards: opts.maxShards ?? 32,
      graphHint: opts.shard,
    });
    const candidates = routed.shardKeys;
    if (candidates.length === 0) {
      return { hits: [], probed: [], fusedFrom: [], stragglers: [], pinned: routed.pinned };
    }

    const results = new Map<string, HybridSearchHit[]>();
    const errors = new Map<string, Error>();
    const stragglers: string[] = [];
    const probed: string[] = [];

    // iterative deepening over rank-ordered waves. strict mode probes
    // EVERY candidate — recall gates must measure retrieval, not the
    // wave policy (a generic term hitting an echo shard in wave 1 must
    // not hide a true match ranked deeper); quorum mode keeps the
    // latency-bounding early exit.
    for (let waveStart = 0; waveStart < candidates.length; waveStart += probeWave) {
      const wave = candidates.slice(waveStart, waveStart + probeWave);
      probed.push(...wave);
      await this.probeWaveShards(wave, routed.query, { perShardLimit, cluster: opts.cluster, strict, timeoutMs }, results, errors, stragglers);
      if (strict) continue;
      // any hit in this or an earlier wave → lower-ranked shards are
      // skipped (they can only echo weaker routing signals)
      let anyHit = false;
      for (const hits of results.values()) {
        if (hits.length > 0) {
          anyHit = true;
          break;
        }
      }
      if (anyHit) break;
    }

    if (stragglers.length > 0) {
      this.log(`federatedSearch: ${stragglers.length} straggler shard(s) past quorum: ${stragglers.join(', ')}`);
    }
    for (const [k, e] of errors) this.log(`federatedSearch: shard ${k} failed: ${e.message}`);
    const fusedFrom = [...results.keys()];

    // deterministic fusion: order shard lists by shard key
    const lists = fusedFrom
      .slice()
      .sort()
      .map((shardKey) =>
        (results.get(shardKey) ?? []).map((h, i) => ({ shardKey, hit: h, shardRank: i + 1 })),
      );
    const fused = rrfFuse(lists, (x) => `${x.shardKey}:${x.hit.id}`);

    const hits: FederatedHit[] = fused.slice(0, limit).map((f) => ({
      shardKey: f.item.shardKey,
      nodeId: f.item.hit.id,
      cluster: f.item.hit.cluster,
      title: f.item.hit.title,
      originFile: f.item.hit.originFile,
      chunkIndex: f.item.hit.chunkIndex,
      body: f.item.hit.body,
      snippet: f.item.hit.snippet,
      rrfScore: f.rrfScore,
      sources: f.item.hit.sources,
      shardRank: f.item.shardRank,
    }));
    return { hits, probed, fusedFrom, stragglers, pinned: routed.pinned };
  }

  /** fan one wave out with bounded concurrency + quorum/straggler policy */
  private async probeWaveShards(
    wave: string[],
    query: string,
    opts: { perShardLimit: number; cluster?: string; strict: boolean; timeoutMs: number },
    results: Map<string, HybridSearchHit[]>,
    errors: Map<string, Error>,
    stragglers: string[],
  ): Promise<void> {
    const concurrency = Math.min(wave.length, Math.max(2, availableParallelism()));
    let next = 0;
    let completed = 0;

    let settle!: () => void;
    const settled = new Promise<void>((r) => (settle = r));
    const quorum = opts.strict ? wave.length : Math.ceil(0.8 * wave.length);
    let deadlineHit = false;
    const timer = opts.strict
      ? null
      : setTimeout(() => {
          deadlineHit = true;
          if (completed >= quorum) settle();
        }, opts.timeoutMs);

    const onDone = () => {
      completed++;
      // fuse as soon as the whole wave finished, or — past the deadline —
      // as soon as quorum is reached
      if (completed === wave.length || (deadlineHit && completed >= quorum)) settle();
    };

    const runNext = async (): Promise<void> => {
      while (next < wave.length) {
        const shardKey = wave[next++];
        try {
          const hits = await this.probe(shardKey, query, {
            limit: opts.perShardLimit,
            cluster: opts.cluster,
          });
          results.set(shardKey, hits);
        } catch (err) {
          errors.set(shardKey, err as Error);
        }
        onDone();
      }
    };
    const workers = Array.from({ length: concurrency }, () => runNext());
    void Promise.all(workers); // stragglers keep running; not awaited

    await settled;
    if (timer) clearTimeout(timer);
    for (const k of wave) {
      if (!results.has(k) && !errors.has(k)) stragglers.push(k);
    }
  }
}
