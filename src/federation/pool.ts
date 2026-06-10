/**
 * IDEA.v2 §2 — ShardPool: an LRU of open demo001 engines.
 *
 * 2,000 shards must NOT mean 2,000 worker pools (IDEA.v2 §12 pitfall):
 * shards open lazily on first touch, idle shards evict at the LRU
 * ceiling, and pooled engines open cold with minReaders=1 so the global
 * thread budget stays bounded (generalizing DEMO001 §3.5's dynamic pool
 * sizing fleet-wide).
 *
 * Engines that are mid-call are pinned (refcounted) and never evicted;
 * eviction picks the least-recently-used unpinned engine and awaits its
 * clean close.
 */
import { availableParallelism } from 'node:os';
import { MemoryEngine, type VectorMode } from '../engine.js';
import type { Embedder } from '../search/embedder.js';
import type { ClusterDef } from '../workers/protocol.js';

export interface ShardPoolOptions {
  /** LRU ceiling for simultaneously open engines; default 64 */
  maxOpenShards?: number;
  /** global worker budget; default 4 × availableParallelism() */
  maxTotalWorkers?: number;
  /** vector lane config propagated to every shard engine */
  vectors?: VectorMode;
  embedder?: Embedder;
  /** readers per pooled engine (cold open); default 1 */
  minReaders?: number;
  maxReaders?: number;
}

interface PoolEntry {
  engine: MemoryEngine;
  /** in-flight calls pinning the engine against eviction */
  refs: number;
  /** monotonic LRU clock value of the last touch */
  lastUsed: number;
  opening?: Promise<MemoryEngine>;
}

export interface PoolStats {
  open: number;
  opens: number;
  evictions: number;
  maxOpenShards: number;
}

export class ShardPool {
  private readonly entries = new Map<string, PoolEntry>();
  private readonly opening = new Map<string, Promise<MemoryEngine>>();
  private clock = 0;
  private opens = 0;
  private evictions = 0;
  private closed = false;
  readonly maxOpenShards: number;
  private readonly maxReadersPerShard: number;
  private readonly minReadersPerShard: number;

  constructor(
    private readonly resolve: (shardKey: string) => { dbPath: string; graph: string; clusters: ClusterDef[] },
    private readonly opts: ShardPoolOptions = {},
  ) {
    this.maxOpenShards = opts.maxOpenShards ?? 64;
    // budget: each open shard costs 1 writer + minReaders readers + 1 sync
    // worker; cap reader ceilings so maxOpenShards × workers stays within
    // maxTotalWorkers (IDEA.v2 §2 worker budget).
    const budget = opts.maxTotalWorkers ?? 4 * availableParallelism();
    const perShard = Math.max(3, Math.floor(budget / this.maxOpenShards));
    this.minReadersPerShard = opts.minReaders ?? 1;
    this.maxReadersPerShard = opts.maxReaders ?? Math.max(this.minReadersPerShard, perShard - 2);
  }

  /** Acquire (open if needed) and pin the engine; callers MUST release(). */
  private async acquire(shardKey: string): Promise<MemoryEngine> {
    if (this.closed) throw new Error('ShardPool closed');
    const existing = this.entries.get(shardKey);
    if (existing) {
      existing.refs++;
      existing.lastUsed = ++this.clock;
      return existing.engine;
    }
    // single-flight open per shard
    let openP = this.opening.get(shardKey);
    if (!openP) {
      openP = (async () => {
        const { dbPath, graph, clusters } = this.resolve(shardKey);
        await this.evictIfNeeded();
        const engine = await MemoryEngine.open({
          dbPath,
          graph,
          clusters,
          minReaders: this.minReadersPerShard,
          maxReaders: this.maxReadersPerShard,
          vectors: this.opts.vectors,
          embedder: this.opts.embedder,
        });
        this.opens++;
        return engine;
      })();
      this.opening.set(shardKey, openP);
    }
    try {
      const engine = await openP;
      let entry = this.entries.get(shardKey);
      if (!entry) {
        entry = { engine, refs: 0, lastUsed: 0 };
        this.entries.set(shardKey, entry);
      }
      entry.refs++;
      entry.lastUsed = ++this.clock;
      return engine;
    } finally {
      this.opening.delete(shardKey);
    }
  }

  private release(shardKey: string): void {
    const entry = this.entries.get(shardKey);
    if (entry) entry.refs = Math.max(0, entry.refs - 1);
  }

  /** Run `fn` against the shard engine with pin/unpin bookkeeping. */
  async withShard<T>(shardKey: string, fn: (engine: MemoryEngine) => Promise<T>): Promise<T> {
    const engine = await this.acquire(shardKey);
    try {
      return await fn(engine);
    } finally {
      this.release(shardKey);
    }
  }

  /** Long-lived pin (FederatedEngine.engine()); balance with unpin(). */
  async pin(shardKey: string): Promise<MemoryEngine> {
    return this.acquire(shardKey);
  }

  unpin(shardKey: string): void {
    this.release(shardKey);
  }

  private async evictIfNeeded(): Promise<void> {
    while (this.entries.size >= this.maxOpenShards) {
      // LRU among unpinned entries
      let victim: { key: string; entry: PoolEntry } | null = null;
      for (const [key, entry] of this.entries) {
        if (entry.refs > 0) continue;
        if (!victim || entry.lastUsed < victim.entry.lastUsed) victim = { key, entry };
      }
      if (!victim) return; // everything pinned — allow temporary overshoot
      this.entries.delete(victim.key);
      this.evictions++;
      await victim.entry.engine.close();
    }
  }

  /** True if the shard engine is currently open (test/diagnostic). */
  isOpen(shardKey: string): boolean {
    return this.entries.has(shardKey);
  }

  stats(): PoolStats {
    return {
      open: this.entries.size,
      opens: this.opens,
      evictions: this.evictions,
      maxOpenShards: this.maxOpenShards,
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    const engines = [...this.entries.values()].map((e) => e.engine);
    this.entries.clear();
    await Promise.all(engines.map((e) => e.close()));
  }
}
