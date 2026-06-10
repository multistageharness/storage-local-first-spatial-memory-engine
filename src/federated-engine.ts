/**
 * IDEA.v2 §6.5 — FederatedEngine: the org-level facade.
 *
 *   catalog.db  — shard registry, routing signals, checkpoints, queue
 *   ShardPool   — LRU of lazily-opened demo001 kernels
 *   ShardRouter — query → candidate shards (hint short-circuit + RRF)
 *   FederatedSearch — fan-out + quorum + rank-based RRF fusion
 *   IngestScheduler — backpressured, serialized, restart-safe ingest
 *
 * Per-shard engine(shardKey) exposes the full demo001 API unchanged
 * (DEMO001 §7) — CRDT adapter, applyRemoteUpdate, syncNow, etc.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Catalog, type ShardKind, type ShardRow } from './federation/catalog.js';
import { ShardPool, type PoolStats } from './federation/pool.js';
import { ShardRouter } from './federation/router.js';
import {
  FederatedSearch,
  type FederatedSearchOptions,
  type FederatedSearchResult,
} from './federation/search.js';
import { IngestScheduler, type DocBatchSource, type IngestReport } from './federation/scheduler.js';
import type { MemoryEngine, VectorMode } from './engine.js';
import type { Embedder } from './search/embedder.js';
import type { ClusterDef } from './workers/protocol.js';

export interface FederatedEngineOptions {
  /** all state lives under here: catalog.db + shards/<key>.db */
  rootDir: string;
  maxOpenShards?: number;
  maxTotalWorkers?: number;
  vectors?: VectorMode;
  embedder?: Embedder;
  minReaders?: number;
  maxReaders?: number;
  maxConcurrentShardIngests?: number;
  highWaterMark?: number;
  log?: (msg: string) => void;
}

export interface EnsureShardInput {
  shardKey: string;
  kind: ShardKind;
  displayName?: string;
  clusters?: ClusterDef[];
}

export interface OrgStats {
  shards: number;
  byStatus: Record<string, number>;
  totalAtoms: number;
  totalDocs: number;
  totalBytes: number;
  pool: PoolStats;
  queue: { pending: number; running: number };
}

/** stable, filesystem-safe shard filename (slug + FNV hash suffix) */
export function shardFileName(shardKey: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < shardKey.length; i++) {
    h ^= shardKey.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  const slug = shardKey.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
  return `${slug}-${(h >>> 0).toString(16)}.db`;
}

export class FederatedEngine {
  readonly catalog: Catalog;
  readonly pool: ShardPool;
  readonly router: ShardRouter;
  readonly scheduler: IngestScheduler;
  private readonly federated: FederatedSearch;
  /** IDEA.v2 §6/Phase 8 — tiered partial replication subscriptions */
  private subscriptions: Set<string> | null = null;
  /** engines pinned via engine() — released on close */
  private readonly pinned = new Map<string, MemoryEngine>();

  private constructor(
    private readonly opts: FederatedEngineOptions,
    catalog: Catalog,
  ) {
    this.catalog = catalog;
    this.pool = new ShardPool(
      (shardKey) => {
        const shard = this.catalog.getShard(shardKey);
        if (!shard) throw new Error(`unknown shard: ${shardKey}`);
        return { dbPath: shard.dbPath, graph: shard.shardKey, clusters: shard.clusters };
      },
      {
        maxOpenShards: opts.maxOpenShards,
        maxTotalWorkers: opts.maxTotalWorkers,
        vectors: opts.vectors,
        embedder: opts.embedder,
        minReaders: opts.minReaders,
        maxReaders: opts.maxReaders,
      },
    );
    this.router = new ShardRouter(this.catalog);
    this.federated = new FederatedSearch(
      this.router,
      (shardKey, query, o) =>
        this.pool.withShard(shardKey, (e) => e.hybridSearch(query, { limit: o.limit, cluster: o.cluster })),
      opts.log,
    );
    this.scheduler = new IngestScheduler(this.catalog, this.pool, {
      maxConcurrentShardIngests: opts.maxConcurrentShardIngests,
      highWaterMark: opts.highWaterMark,
      log: opts.log,
    });
  }

  static async open(opts: FederatedEngineOptions): Promise<FederatedEngine> {
    mkdirSync(join(opts.rootDir, 'shards'), { recursive: true });
    const catalog = Catalog.open(join(opts.rootDir, 'catalog.db'));
    return new FederatedEngine(opts, catalog);
  }

  /** catalog upsert + lazy db create (file appears on first engine open) */
  async ensureShard(input: EnsureShardInput): Promise<ShardRow> {
    return this.catalog.ensureShard({
      shardKey: input.shardKey,
      kind: input.kind,
      displayName: input.displayName,
      clusters: input.clusters,
      dbPath: join(this.opts.rootDir, 'shards', shardFileName(input.shardKey)),
    });
  }

  /**
   * Pin + return the shard's demo001 engine (full kernel API). Pinned
   * engines never evict until releaseEngine()/close(); prefer
   * withEngine() for scoped access.
   */
  async engine(shardKey: string): Promise<MemoryEngine> {
    const cached = this.pinned.get(shardKey);
    if (cached) return cached;
    const engine = await this.pool.pin(shardKey);
    this.pinned.set(shardKey, engine);
    return engine;
  }

  releaseEngine(shardKey: string): void {
    if (this.pinned.delete(shardKey)) this.pool.unpin(shardKey);
  }

  /** scoped access with LRU pin/unpin bookkeeping */
  async withEngine<T>(shardKey: string, fn: (engine: MemoryEngine) => Promise<T>): Promise<T> {
    return this.pool.withShard(shardKey, fn);
  }

  /** scheduler-mediated ingest (IDEA.v2 §6.4): backpressure + serialization */
  async ingest(shardKey: string, docs: DocBatchSource): Promise<IngestReport> {
    if (!this.catalog.getShard(shardKey)) throw new Error(`ingest: unknown shard ${shardKey}`);
    return this.scheduler.ingestDocs(shardKey, docs);
  }

  /** federated or pinned search (IDEA.v2 §6.3) */
  async search(query: string, opts: FederatedSearchOptions = {}): Promise<FederatedSearchResult> {
    return this.federated.search(query, opts);
  }

  /**
   * IDEA.v2 Phase 8 — tiered partial replication: only subscribed shards
   * participate in CRDT exchange for this replica. null = all shards.
   */
  subscribe(shardKeys: string[] | null): void {
    this.subscriptions = shardKeys == null ? null : new Set(shardKeys);
  }

  isSubscribed(shardKey: string): boolean {
    return this.subscriptions == null || this.subscriptions.has(shardKey);
  }

  /**
   * Inter-replica CRDT ingress, gated by the subscription set: updates
   * for unsubscribed shards are rejected at the boundary (tiered partial
   * replication — IDEA.v2 Phase 8). Epoch arbitration happens inside the
   * shard kernel (stale → CONFLICT, newer → adopt, equal → merge queue).
   */
  async applyRemoteShardUpdate(
    shardKey: string,
    nodeId: number,
    update: Uint8Array,
    epoch?: number,
  ): Promise<{ applied: boolean; outcome?: 'queued' | 'stale' | 'adopted'; reason?: string }> {
    if (!this.isSubscribed(shardKey)) return { applied: false, reason: 'unsubscribed' };
    if (!this.catalog.getShard(shardKey)) return { applied: false, reason: 'unknown-shard' };
    const res = await this.withEngine(shardKey, (e) => e.applyRemoteUpdate(nodeId, update, epoch));
    return { applied: true, outcome: res.outcome };
  }

  /** one shard, or rolling all-dirty (any shard with unsynced outbox rows) */
  async syncNow(shardKey?: string): Promise<{ merged: number; shards: number }> {
    const keys = shardKey ? [shardKey] : this.catalog.listShards().map((s) => s.shardKey);
    let merged = 0;
    let touched = 0;
    for (const key of keys) {
      if (!this.isSubscribed(key)) continue;
      const result = await this.pool.withShard(key, async (e) => {
        const stats = await e.stats();
        if (!shardKey && (stats.outboxDirty as number) === 0) return null;
        return e.syncNow();
      });
      if (result) {
        merged += result.merged;
        touched++;
      }
    }
    return { merged, shards: touched };
  }

  async stats(): Promise<OrgStats> {
    const shards = this.catalog.listShards();
    const byStatus: Record<string, number> = {};
    let totalAtoms = 0;
    let totalDocs = 0;
    let totalBytes = 0;
    for (const s of shards) {
      byStatus[s.status] = (byStatus[s.status] ?? 0) + 1;
      totalAtoms += s.atomCount;
      totalDocs += s.docCount;
      totalBytes += s.bytes;
    }
    return {
      shards: shards.length,
      byStatus,
      totalAtoms,
      totalDocs,
      totalBytes,
      pool: this.pool.stats(),
      queue: this.catalog.queueDepth(),
    };
  }

  async close(): Promise<void> {
    for (const key of this.pinned.keys()) this.pool.unpin(key);
    this.pinned.clear();
    await this.pool.close();
    this.catalog.close();
  }
}

export type { FederatedSearchOptions, FederatedSearchResult, IngestReport, ShardRow, DocBatchSource };
