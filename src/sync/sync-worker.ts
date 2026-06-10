/**
 * Task 4.2.2 — the background polling worker (no Redis, no BullMQ:
 * a native worker_thread querying the SQLite outbox directly).
 *
 * Read-side only: it polls DIRTY/CONFLICT outbox rows over its own
 * read-only connection, performs the mathematical CRDT merge
 * (Y.mergeUpdates) off the main thread, and posts merge results to the
 * parent. The parent routes the commit through the SINGLETON WRITER so
 * the 1-writer discipline is never violated.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { openConnection } from '../db/connection.js';
import { dirtyOutbox } from '../workers/read-ops.js';
import { mergeBlobs, readAtomFields } from './crdt.js';
import type { DirtyOutboxRow } from '../workers/protocol.js';

export interface MergeResult {
  nodeId: number;
  mergedBlob: Uint8Array;
  title: string;
  body: string;
  outboxIds: number[];
}

export type SyncWorkerMessage =
  | { type: 'poll-result'; token: number; merges: MergeResult[] }
  | { type: 'error'; message: string };

if (!parentPort) throw new Error('sync-worker must run as a worker thread');
const port = parentPort;
const { dbPath, intervalMs } = workerData as { dbPath: string; intervalMs: number };

const conn = openConnection(dbPath, { readonly: true });

/** nodes whose merge has been posted but not yet committed by the writer */
const inflight = new Set<number>();

function computeMerges(): MergeResult[] {
  const rows = dirtyOutbox(conn, { limit: 1000 }) as DirtyOutboxRow[];
  const byNode = new Map<number, DirtyOutboxRow[]>();
  for (const r of rows) {
    if (inflight.has(r.nodeId)) continue;
    const list = byNode.get(r.nodeId) ?? [];
    list.push(r);
    byNode.set(r.nodeId, list);
  }

  const merges: MergeResult[] = [];
  for (const [nodeId, events] of byNode) {
    // CRDT merge: current materialized blob + every pending event payload.
    // Order-independent and idempotent — conflict-free by construction.
    const blobs = [
      events[0].nodeBlob ?? new Uint8Array(),
      ...events.map((e) => e.payload).filter((p): p is Uint8Array => p != null),
    ];
    const mergedBlob = mergeBlobs(blobs);
    const fields = readAtomFields(mergedBlob);
    inflight.add(nodeId);
    merges.push({
      nodeId,
      mergedBlob,
      title: fields.title,
      body: fields.body ?? '',
      outboxIds: events.map((e) => e.outboxId),
    });
  }
  return merges;
}

function poll(token: number): void {
  try {
    port.postMessage({ type: 'poll-result', token, merges: computeMerges() } satisfies SyncWorkerMessage);
  } catch (err) {
    port.postMessage({ type: 'error', message: (err as Error).message } satisfies SyncWorkerMessage);
  }
}

port.on('message', (msg: { type: 'poll'; token: number } | { type: 'committed'; nodeIds: number[] }) => {
  if (msg.type === 'poll') poll(msg.token);
  else if (msg.type === 'committed') for (const id of msg.nodeIds) inflight.delete(id);
});

if (intervalMs > 0) {
  const timer = setInterval(() => poll(-1), intervalMs);
  timer.unref();
}

port.postMessage({ type: 'ready' });
