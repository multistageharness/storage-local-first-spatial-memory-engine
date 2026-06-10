/**
 * IDEA.v2 §6.4 — IngestScheduler.
 *
 * No Redis, no BullMQ (IDEA.v1 "Rejecting External Queues"): the durable
 * work queue is the catalog's ingest_queue table; this class adds the
 * runtime discipline around it —
 *
 *   - per-shard serialization: a shard never has two ingest tasks
 *     running (the 1-writer invariant lifted to the org level), enforced
 *     both in-process (mutex) and cross-process (catalog claim);
 *   - bounded global concurrency: maxConcurrentShardIngests, default
 *     availableParallelism()/2;
 *   - backpressure: document batches flow through a prefetch buffer
 *     capped at highWaterMark pending docs per shard — the source
 *     iterator pauses instead of ballooning memory;
 *   - split signal: post-ingest stats rollup marks SPLIT past the
 *     150k-atom / 1.5 GiB thresholds (advisory; v2 detects, never splits).
 */
import { availableParallelism } from 'node:os';
import { statSync } from 'node:fs';
import type { SourceDocumentInput } from '../engine.js';
import type { Catalog, IngestTask } from './catalog.js';
import type { ShardPool } from './pool.js';

export interface IngestSchedulerOptions {
  maxConcurrentShardIngests?: number;
  /** max docs buffered ahead of the shard writer; default 256 */
  highWaterMark?: number;
  log?: (msg: string) => void;
}

export interface IngestReport {
  shardKey: string;
  docs: number;
  atoms: number;
  /** content_hash no-op skips (incremental ingest) */
  skippedDocs: number;
  ms: number;
  atomsPerSec: number;
  split: boolean;
}

export type DocBatchSource =
  | AsyncIterable<SourceDocumentInput[]>
  | Iterable<SourceDocumentInput[]>
  | SourceDocumentInput[];

/** simple counting semaphore */
class Semaphore {
  private queue: (() => void)[] = [];
  constructor(private slots: number) {}
  async acquire(): Promise<void> {
    if (this.slots > 0) {
      this.slots--;
      return;
    }
    await new Promise<void>((r) => this.queue.push(r));
  }
  release(): void {
    const next = this.queue.shift();
    if (next) next();
    else this.slots++;
  }
}

/** one-shot wakeup latch for producer/consumer handoff */
class Signal {
  private resolve: (() => void) | undefined;
  private p: Promise<void> | undefined;
  wait(): Promise<void> {
    if (!this.p) this.p = new Promise<void>((r) => (this.resolve = r));
    return this.p;
  }
  fire(): void {
    const r = this.resolve;
    this.p = undefined;
    this.resolve = undefined;
    r?.();
  }
}

/**
 * Prefetch wrapper: pulls batches from `src` ahead of the consumer while
 * the buffered doc count stays under highWaterMark; past it, pulling
 * pauses until the consumer drains — backpressure without unbounded RAM.
 * (exported for direct unit-testing of the invariant)
 */
export async function* buffered(
  src: AsyncIterator<SourceDocumentInput[]>,
  highWaterMark: number,
): AsyncGenerator<SourceDocumentInput[]> {
  const queue: SourceDocumentInput[][] = [];
  let pendingDocs = 0;
  let done = false;
  let error: Error | null = null;
  const consumerSignal = new Signal();
  const producerSignal = new Signal();

  const producer = (async () => {
    for (;;) {
      while (pendingDocs >= highWaterMark) await producerSignal.wait();
      let next: IteratorResult<SourceDocumentInput[]>;
      try {
        next = await src.next();
      } catch (err) {
        error = err as Error;
        break;
      }
      if (next.done) break;
      queue.push(next.value);
      pendingDocs += next.value.length;
      consumerSignal.fire();
    }
    done = true;
    consumerSignal.fire();
  })();

  for (;;) {
    while (queue.length === 0 && !done) await consumerSignal.wait();
    if (queue.length === 0) break;
    const batch = queue.shift()!;
    pendingDocs -= batch.length;
    producerSignal.fire();
    yield batch;
  }
  await producer;
  if (error) throw error;
}

function normalizeSource(docs: DocBatchSource): AsyncIterator<SourceDocumentInput[]> {
  if (Array.isArray(docs)) {
    // a bare doc array → one batch (detect by first element having sourceKey)
    if (docs.length === 0) return (async function* () {})();
    if (typeof (docs[0] as SourceDocumentInput).sourceKey === 'string') {
      return (async function* () {
        yield docs as SourceDocumentInput[];
      })();
    }
  }
  const it = docs as Partial<AsyncIterable<SourceDocumentInput[]>> & Partial<Iterable<SourceDocumentInput[]>>;
  const asyncIt = (it as AsyncIterable<SourceDocumentInput[]>)[Symbol.asyncIterator];
  if (typeof asyncIt === 'function') {
    return asyncIt.call(it as AsyncIterable<SourceDocumentInput[]>);
  }
  return (async function* () {
    yield* it as Iterable<SourceDocumentInput[]>;
  })();
}

/** word-frequency accumulator feeding routing-term recompute (DF-CAT-ROUTING-01) */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'with', 'this', 'that', 'from',
  'they', 'will', 'would', 'there', 'their', 'what', 'about', 'which', 'when', 'into',
  'const', 'let', 'var', 'function', 'return', 'import', 'export', 'true', 'false', 'null',
]);

export function accumulateTerms(freqs: Map<string, number>, text: string): void {
  for (const m of text.toLowerCase().matchAll(/[a-z][a-z0-9_$]{2,31}/g)) {
    const t = m[0];
    if (STOPWORDS.has(t)) continue;
    freqs.set(t, (freqs.get(t) ?? 0) + 1);
  }
  // bound memory: prune the long tail when the map balloons
  if (freqs.size > 50_000) {
    const top = [...freqs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10_000);
    freqs.clear();
    for (const [k, v] of top) freqs.set(k, v);
  }
}

export class IngestScheduler {
  private readonly semaphore: Semaphore;
  private readonly shardLocks = new Map<string, Promise<void>>();
  private readonly highWaterMark: number;
  private readonly log: (msg: string) => void;
  readonly maxConcurrentShardIngests: number;

  constructor(
    private readonly catalog: Catalog,
    private readonly pool: ShardPool,
    opts: IngestSchedulerOptions = {},
  ) {
    this.maxConcurrentShardIngests =
      opts.maxConcurrentShardIngests ?? Math.max(1, Math.floor(availableParallelism() / 2));
    this.semaphore = new Semaphore(this.maxConcurrentShardIngests);
    this.highWaterMark = opts.highWaterMark ?? 256;
    this.log = opts.log ?? (() => {});
  }

  /** serialize per shard in-process (cross-process serialization = catalog claim) */
  private async withShardLock<T>(shardKey: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.shardLocks.get(shardKey) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    this.shardLocks.set(shardKey, prev.then(() => gate));
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.shardLocks.get(shardKey) === gate) this.shardLocks.delete(shardKey);
    }
  }

  /**
   * Stream document batches into one shard: replaceDocument per doc
   * (content-hash no-ops make this incremental for free), stats rollup +
   * split signal + routing-term recompute when the stream ends.
   */
  async ingestDocs(shardKey: string, docs: DocBatchSource): Promise<IngestReport> {
    await this.semaphore.acquire();
    try {
      return await this.withShardLock(shardKey, async () => {
        const shard = this.catalog.getShard(shardKey);
        if (!shard) throw new Error(`ingestDocs: unknown shard ${shardKey}`);
        this.catalog.setShardStatus(shardKey, 'INGESTING');
        const started = Date.now();
        const termFreqs = new Map<string, number>();
        let docCount = 0;
        let atomCount = 0;
        let skipped = 0;
        try {
          await this.pool.withShard(shardKey, async (engine) => {
            for await (const batch of buffered(normalizeSource(docs), this.highWaterMark)) {
              for (const doc of batch) {
                const res = await engine.replaceDocument(doc);
                docCount++;
                if (res.skipped) skipped++;
                else {
                  atomCount += res.nodeIds.length;
                  accumulateTerms(termFreqs, `${doc.title} ${doc.text}`);
                }
              }
            }
            const stats = await engine.stats();
            let bytes = 0;
            try {
              bytes = statSync(shard.dbPath).size;
            } catch {
              /* db file may not exist for an empty shard */
            }
            const { split } = this.catalog.updateShardStats(shardKey, {
              atomCount: stats.nodes as number,
              docCount: stats.documents as number,
              bytes,
            });
            if (split) this.log(`ingest: shard ${shardKey} crossed split threshold (advisory)`);
            if (termFreqs.size > 0) this.catalog.recomputeRoutingTerms(shardKey, termFreqs);
            return split;
          });
          const split = this.catalog.getShard(shardKey)!.status === 'SPLIT';
          if (!split) this.catalog.setShardStatus(shardKey, 'ACTIVE');
          const ms = Date.now() - started;
          return {
            shardKey,
            docs: docCount,
            atoms: atomCount,
            skippedDocs: skipped,
            ms,
            atomsPerSec: ms > 0 ? Math.round((atomCount / ms) * 1000) : atomCount,
            split,
          };
        } catch (err) {
          this.catalog.setShardStatus(shardKey, 'ACTIVE');
          throw err;
        }
      });
    } finally {
      this.semaphore.release();
    }
  }

  /**
   * Queue worker loop: claim → execute → complete, with
   * maxConcurrentShardIngests parallel workers. The executor maps a task
   * to its document source (a connector crawl or a synthetic generator).
   * Returns when the queue is drained.
   */
  async drainQueue(executor: (task: IngestTask) => Promise<void>): Promise<{ completed: number; failed: number }> {
    let completed = 0;
    let failed = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const task = this.catalog.claimNext();
        if (!task) return;
        try {
          await executor(task);
          this.catalog.completeTask(task.id, true);
          completed++;
        } catch (err) {
          this.log(`drainQueue: task ${task.id} (${task.shardKey}/${task.task}) failed: ${(err as Error).message}`);
          this.catalog.completeTask(task.id, false);
          failed++;
        }
      }
    };
    await Promise.all(Array.from({ length: this.maxConcurrentShardIngests }, () => worker()));
    if (completed > 0) {
      // settle every signature against the final org-wide df rollup —
      // per-shard recomputes during the wave saw a moving IDF baseline
      const refreshed = this.catalog.refreshAllRoutingTerms();
      this.log(`drainQueue: refreshed routing signatures for ${refreshed} shard(s)`);
    }
    return { completed, failed };
  }
}
