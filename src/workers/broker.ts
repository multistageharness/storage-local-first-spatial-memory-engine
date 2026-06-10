/**
 * Task 1.2.3 — the async message-passing broker living in the main
 * process. Dispatches JSON payloads to worker threads and resolves
 * promises on reply. The main thread therefore NEVER touches
 * better-sqlite3's synchronous bindings.
 *
 * Topology (Feature 1.2):
 *   - 1 singleton writer thread  → all INSERT/UPDATE/DELETE
 *   - N read-only reader threads → all SELECT / FTS5 MATCH
 *     (dynamic: scales up to maxReaders under queue pressure)
 */
import { Worker } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import type { WorkerResponse } from './protocol.js';

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

class ManagedWorker {
  readonly worker: Worker;
  readonly pending = new Map<number, Pending>();
  ready: Promise<void>;

  constructor(script: URL, dbPath: string, role: 'writer' | 'reader') {
    this.worker = new Worker(script, { workerData: { dbPath, role } });
    this.ready = new Promise<void>((resolve, reject) => {
      const onMessage = (msg: WorkerResponse | { type: 'ready' }) => {
        if ('type' in msg && msg.type === 'ready') {
          this.worker.off('message', onMessage);
          resolve();
        }
      };
      this.worker.on('message', onMessage);
      this.worker.once('error', reject);
    });
    this.worker.on('message', (msg: WorkerResponse | { type: 'ready' }) => {
      if ('type' in msg) return;
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result);
      else {
        const err = new Error(msg.error.message);
        err.stack = msg.error.stack ?? err.stack;
        p.reject(err);
      }
    });
    this.worker.on('error', (err) => {
      const error = err instanceof Error ? err : new Error(String(err));
      for (const p of this.pending.values()) p.reject(error);
      this.pending.clear();
    });
  }

  get inflight(): number {
    return this.pending.size;
  }

  exec<T>(id: number, op: string, payload: unknown): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.worker.postMessage({ id, op, payload });
    });
  }

  async terminate(): Promise<void> {
    await this.worker.terminate();
  }
}

export interface BrokerOptions {
  dbPath: string;
  /** readers spawned at boot; default 2 */
  minReaders?: number;
  /** dynamic ceiling; default availableParallelism() - 2, min 2 */
  maxReaders?: number;
  /** spawn another reader when avg inflight per reader exceeds this */
  scaleThreshold?: number;
}

const WRITER_URL = new URL('./writer-worker.js', import.meta.url);
const READER_URL = new URL('./reader-worker.js', import.meta.url);

export class WorkerBroker {
  private writer!: ManagedWorker;
  private readers: ManagedWorker[] = [];
  private nextId = 1;
  private rr = 0;
  private scaling = false;
  private closed = false;
  private readonly opts: Required<BrokerOptions>;

  private constructor(opts: BrokerOptions) {
    this.opts = {
      dbPath: opts.dbPath,
      minReaders: opts.minReaders ?? 2,
      maxReaders: opts.maxReaders ?? Math.max(2, availableParallelism() - 2),
      scaleThreshold: opts.scaleThreshold ?? 4,
    };
  }

  static async open(opts: BrokerOptions): Promise<WorkerBroker> {
    const broker = new WorkerBroker(opts);
    // Writer first: it creates the DB file + schema. Readers open
    // readonly and would fail on a nonexistent file.
    broker.writer = new ManagedWorker(WRITER_URL, broker.opts.dbPath, 'writer');
    await broker.writer.ready;
    const boot = Array.from({ length: broker.opts.minReaders }, () => broker.spawnReader());
    await Promise.all(boot.map((r) => r.ready));
    return broker;
  }

  private spawnReader(): ManagedWorker {
    const r = new ManagedWorker(READER_URL, this.opts.dbPath, 'reader');
    this.readers.push(r);
    return r;
  }

  /** All mutations serialize through the singleton writer. */
  write<T>(op: string, payload: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new Error('broker closed'));
    return this.writer.exec<T>(this.nextId++, op, payload);
  }

  /** Reads round-robin across the pool; pool grows under pressure. */
  read<T>(op: string, payload: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new Error('broker closed'));
    this.maybeScaleUp();
    // least-busy pick, round-robin tiebreak
    let best = this.readers[this.rr++ % this.readers.length];
    for (const r of this.readers) if (r.inflight < best.inflight) best = r;
    return best.exec<T>(this.nextId++, op, payload);
  }

  private maybeScaleUp(): void {
    if (this.scaling || this.readers.length >= this.opts.maxReaders) return;
    const totalInflight = this.readers.reduce((s, r) => s + r.inflight, 0);
    if (totalInflight / this.readers.length < this.opts.scaleThreshold) return;
    this.scaling = true;
    const r = this.spawnReader();
    void r.ready.finally(() => {
      this.scaling = false;
    });
  }

  get readerCount(): number {
    return this.readers.length;
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([this.writer.terminate(), ...this.readers.map((r) => r.terminate())]);
  }
}
