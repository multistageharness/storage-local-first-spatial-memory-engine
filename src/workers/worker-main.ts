/**
 * Shared worker-thread entrypoint body. better-sqlite3 is synchronous —
 * its C bindings would freeze the V8 event loop — so connections live
 * exclusively here, inside worker_threads, never on the main thread.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { openConnection, type Connection } from '../db/connection.js';
import type { WorkerInit, WorkerRequest, WorkerResponse } from './protocol.js';
import * as writeOps from './write-ops.js';
import * as readOps from './read-ops.js';

type OpTable = Record<string, (conn: Connection, payload: never) => unknown>;

const WRITE_OPS: OpTable = {
  init: writeOps.init,
  ensureGraph: writeOps.ensureGraph,
  ensureClusters: writeOps.ensureClusters,
  insertNodes: writeOps.insertNodes,
  saveAtomic: writeOps.saveAtomic,
  applyRemoteUpdate: writeOps.applyRemoteUpdate,
  commitMerge: writeOps.commitMerge,
  commitMerges: writeOps.commitMerges,
  deleteNode: writeOps.deleteNode,
  checkFtsIntegrity: writeOps.checkFtsIntegrity,
  // IDEA.v2 §5.1 — incremental-ingest primitives
  replaceDocument: writeOps.replaceDocument,
  deleteDocument: writeOps.deleteDocument,
  // IDEA.v2 §5.3 — epoch-based CRDT GC
  compactAtom: writeOps.compactAtom,
  compactAtoms: writeOps.compactAtoms,
  // DEMO003 Feature 1 — Edge Type
  addEdges: writeOps.addEdges,
  deleteEdge: writeOps.deleteEdge,
  // DEMO003 Feature 2 — Supernode
  rebuildSupernodes: writeOps.rebuildSupernodes,
};

const READ_OPS: OpTable = {
  search: readOps.search,
  getNode: readOps.getNode,
  loadCrdt: readOps.loadCrdt,
  dirtyOutbox: readOps.dirtyOutbox,
  stats: readOps.stats,
  // IDEA.v2 §5.2 — hybrid retrieval lanes
  wordSearch: readOps.wordSearch,
  vectorSearch: readOps.vectorSearch,
  hybridSearch: readOps.hybridSearch,
  getDocument: readOps.getDocument,
  // DEMO003 Feature 1 — Edge Type
  neighbors: readOps.neighbors,
  edgesOf: readOps.edgesOf,
  // DEMO003 Feature 2 — Supernode
  listSupernodes: readOps.listSupernodes,
  getSupernode: readOps.getSupernode,
  routeToClusters: readOps.routeToClusters,
};

export function runWorker(): void {
  if (!parentPort) throw new Error('must run as a worker thread');
  const port = parentPort;
  const { dbPath, role } = workerData as WorkerInit;

  const conn = openConnection(dbPath, { readonly: role === 'reader' });
  if (role === 'writer') writeOps.init(conn); // schema + triggers on boot

  const ops = role === 'writer' ? { ...WRITE_OPS, ...READ_OPS } : READ_OPS;

  port.on('message', (msg: WorkerRequest) => {
    let response: WorkerResponse;
    try {
      const fn = ops[msg.op];
      if (!fn) throw new Error(`unknown ${role} op: ${msg.op}`);
      response = { id: msg.id, ok: true, result: fn(conn, msg.payload as never) };
    } catch (err) {
      const e = err as Error;
      response = { id: msg.id, ok: false, error: { message: e.message, stack: e.stack } };
    }
    port.postMessage(response);
  });

  port.postMessage({ type: 'ready' });
}
