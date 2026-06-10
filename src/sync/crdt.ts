/**
 * Phase 4 — CRDT helpers. Design decision (answering the REQ's closing
 * question): we instantiate a DISTINCT Yjs document per Node/Atom rather
 * than one massive doc for the whole Graph→Cluster→Node hierarchy. Atoms
 * are immutable verbatim chunks, so per-atom docs keep update blobs tiny,
 * merges O(atom) instead of O(graph), and let the spatial hierarchy live
 * in plain relational columns where FTS5 and routing need it.
 */
import * as Y from 'yjs';

export interface AtomFields {
  title: string;
  body: string;
  originFile?: string | null;
}

const MAP_KEY = 'atom';

/** Create a fresh per-atom doc and return its full state as an update blob. */
export function createAtomBlob(fields: AtomFields): Uint8Array {
  const doc = new Y.Doc();
  const map = doc.getMap(MAP_KEY);
  doc.transact(() => {
    map.set('title', fields.title);
    map.set('body', fields.body);
    if (fields.originFile != null) map.set('originFile', fields.originFile);
  });
  return Y.encodeStateAsUpdate(doc);
}

/** Compute a differential update that applies `fields` on top of `baseBlob`. */
export function diffUpdate(baseBlob: Uint8Array | null, fields: Partial<AtomFields>): Uint8Array {
  const doc = new Y.Doc();
  if (baseBlob) Y.applyUpdate(doc, baseBlob);
  const before = Y.encodeStateVector(doc);
  const map = doc.getMap(MAP_KEY);
  doc.transact(() => {
    for (const [k, v] of Object.entries(fields)) {
      if (v != null) map.set(k, v);
    }
  });
  return Y.encodeStateAsUpdate(doc, before);
}

/**
 * Feature 4.2 — mathematical merge instead of destructive Last-Write-Wins.
 * Yjs guarantees convergence regardless of update arrival order.
 */
export function mergeBlobs(blobs: Uint8Array[]): Uint8Array {
  const real = blobs.filter((b): b is Uint8Array => b != null && b.byteLength > 0);
  if (real.length === 1) return real[0];
  return Y.mergeUpdates(real);
}

/** Materialize the relational view (title/body) from a merged blob. */
export function readAtomFields(blob: Uint8Array): AtomFields {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, blob);
  const map = doc.getMap(MAP_KEY);
  return {
    title: (map.get('title') as string) ?? '',
    body: (map.get('body') as string) ?? '',
    originFile: (map.get('originFile') as string | undefined) ?? null,
  };
}

/** State vector of a blob — used by the sync worker to detect divergence. */
export function stateVector(blob: Uint8Array): Uint8Array {
  return Y.encodeStateVectorFromUpdate(blob);
}
