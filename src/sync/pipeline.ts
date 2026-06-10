/**
 * Phase 4 — main-process side of the sync pipeline. Owns the background
 * polling worker and forwards its merge results to the singleton writer
 * (commitMerge), preserving the strict 1-writer topology.
 */
import { Worker } from 'node:worker_threads';
import type { WorkerBroker } from '../workers/broker.js';
import type { MergeResult, SyncWorkerMessage } from './sync-worker.js';

const SYNC_WORKER_URL = new URL('./sync-worker.js', import.meta.url);

export interface SyncPipelineOptions {
  dbPath: string;
  broker: WorkerBroker;
  /** background poll interval; 0 disables the timer (manual syncNow only) */
  intervalMs?: number;
}

export class SyncPipeline {
  private worker!: Worker;
  private nextToken = 1;
  private waiters = new Map<number, (merges: MergeResult[]) => void>();
  private closed = false;

  private constructor(private readonly opts: SyncPipelineOptions) {}

  static async start(opts: SyncPipelineOptions): Promise<SyncPipeline> {
    const p = new SyncPipeline(opts);
    p.worker = new Worker(SYNC_WORKER_URL, {
      workerData: { dbPath: opts.dbPath, intervalMs: opts.intervalMs ?? 0 },
    });
    await new Promise<void>((resolve, reject) => {
      const onMsg = (m: { type?: string }) => {
        if (m.type === 'ready') {
          p.worker.off('message', onMsg);
          resolve();
        }
      };
      p.worker.on('message', onMsg);
      p.worker.once('error', reject);
    });
    p.worker.on('message', (msg: SyncWorkerMessage) => void p.onMessage(msg));
    return p;
  }

  private async onMessage(msg: SyncWorkerMessage): Promise<void> {
    if (msg.type === 'error') {
      // background poll failure is non-fatal; next poll retries
      return;
    }
    if (msg.type !== 'poll-result') return;
    await this.commit(msg.merges);
    const waiter = this.waiters.get(msg.token);
    if (waiter) {
      this.waiters.delete(msg.token);
      waiter(msg.merges);
    }
  }

  private async commit(merges: MergeResult[]): Promise<void> {
    if (this.closed) return;
    if (merges.length > 0) {
      // single BEGIN IMMEDIATE for the whole round — at scale this is the
      // difference between N fsync'd commits and one
      await this.opts.broker.write('commitMerges', { merges });
    }
    if (merges.length > 0 && !this.closed) {
      this.worker.postMessage({ type: 'committed', nodeIds: merges.map((m) => m.nodeId) });
    }
  }

  /** Force a poll+merge+commit round; resolves when commits have landed. */
  async syncNow(): Promise<{ merged: number }> {
    if (this.closed) return { merged: 0 };
    const token = this.nextToken++;
    const merges = await new Promise<MergeResult[]>((resolve) => {
      this.waiters.set(token, resolve);
      this.worker.postMessage({ type: 'poll', token });
    });
    return { merged: merges.length };
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.worker.terminate();
  }
}
