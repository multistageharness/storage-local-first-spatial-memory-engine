/**
 * Mutation operations executed ONLY inside the singleton writer thread
 * (Task 1.2.1). Every multi-statement mutation goes through
 * Connection.immediate() — BEGIN IMMEDIATE — so the write lock is taken
 * up-front and concurrent processes queue on busy_timeout.
 *
 * Phase 4 dual-write discipline: any mutation that changes a node ALSO
 * appends its CRDT differential to the outbox in the SAME transaction.
 */
import type { Connection } from '../db/connection.js';
import { applySchema } from '../db/schema.js';
import { embeddingToBuffer } from '../search/embedder.js';
import { createAtomBlob, diffUpdate, mergeBlobs, readAtomFields } from '../sync/crdt.js';
import type {
  AddEdgesPayload,
  AddEdgesResult,
  ApplyRemoteUpdatePayload,
  CommitMergePayload,
  CompactAtomPayload,
  CompactAtomResult,
  CompactAtomsPayload,
  DeleteDocumentPayload,
  DeleteEdgePayload,
  EnsureClustersPayload,
  EnsureGraphPayload,
  InsertNodeRow,
  InsertNodesPayload,
  RebuildSupernodesPayload,
  RebuildSupernodesResult,
  ReplaceDocumentPayload,
  ReplaceDocumentResult,
  SaveAtomicPayload,
} from './protocol.js';

export function init(conn: Connection): { ok: true } {
  applySchema(conn);
  return { ok: true };
}

export function ensureGraph(conn: Connection, p: EnsureGraphPayload): { id: number } {
  return conn.immediate(() => {
    conn.db.prepare(`INSERT INTO graphs (name) VALUES (?) ON CONFLICT(name) DO NOTHING`).run(p.name);
    const row = conn.db.prepare(`SELECT id FROM graphs WHERE name = ?`).get(p.name) as { id: number };
    return { id: row.id };
  });
}

export function ensureClusters(
  conn: Connection,
  p: EnsureClustersPayload,
): { ids: Record<string, number> } {
  return conn.immediate(() => {
    const upsert = conn.db.prepare(`
      INSERT INTO clusters (graph_id, name, keywords) VALUES (@graphId, @name, @keywords)
      ON CONFLICT(graph_id, name) DO UPDATE SET keywords = excluded.keywords
    `);
    const select = conn.db.prepare(`SELECT id FROM clusters WHERE graph_id = ? AND name = ?`);
    const ids: Record<string, number> = {};
    // 'general' fallback cluster always exists (Task 2.1.2)
    const all = [...p.clusters, { name: 'general', keywords: [] }];
    for (const c of all) {
      upsert.run({ graphId: p.graphId, name: c.name, keywords: JSON.stringify(c.keywords) });
      ids[c.name] = (select.get(p.graphId, c.name) as { id: number }).id;
    }
    return { ids };
  });
}

/** Shared row-insertion body used by insertNodes and replaceDocument. */
function insertNodeRows(conn: Connection, rows: InsertNodeRow[], documentId: number | null): number[] {
  const insertNode = conn.db.prepare(`
    INSERT INTO nodes (graph_id, cluster_id, document_id, title, body, origin_file, chunk_index, crdt_blob, _sync_status)
    VALUES (@graphId, @clusterId, @documentId, @title, @body, @originFile, @chunkIndex, @blob, 'DIRTY')
  `);
  const insertEvent = conn.db.prepare(`
    INSERT INTO outbox (node_id, event_type, payload) VALUES (?, 'node.created', ?)
  `);
  const insertVec = conn.db.prepare(`
    INSERT INTO nodes_vec (node_id, embedding) VALUES (?, ?)
  `);
  const ids: number[] = [];
  for (const n of rows) {
    // one CRDT doc per atom; full initial state is the first event payload
    const blob = createAtomBlob({ title: n.title, body: n.body, originFile: n.originFile ?? null });
    const info = insertNode.run({
      graphId: n.graphId,
      clusterId: n.clusterId,
      documentId,
      title: n.title,
      body: n.body,
      originFile: n.originFile ?? null,
      chunkIndex: n.chunkIndex,
      blob,
    });
    const id = Number(info.lastInsertRowid);
    insertEvent.run(id, blob);
    if (n.embedding) insertVec.run(id, embeddingToBuffer(n.embedding));
    ids.push(id);
  }
  return ids;
}

export function insertNodes(conn: Connection, p: InsertNodesPayload): { ids: number[] } {
  return conn.immediate(() => ({ ids: insertNodeRows(conn, p.nodes, null) }));
}

/** Delete a document's atoms + their outbox rows (triggers clean both FTS indexes + nodes_vec). */
function deleteDocumentAtoms(conn: Connection, documentId: number): number {
  const nodeIds = (
    conn.db.prepare(`SELECT id FROM nodes WHERE document_id = ?`).all(documentId) as { id: number }[]
  ).map((r) => r.id);
  const delOutbox = conn.db.prepare(`DELETE FROM outbox WHERE node_id = ?`);
  const delNode = conn.db.prepare(`DELETE FROM nodes WHERE id = ?`);
  for (const id of nodeIds) {
    delOutbox.run(id);
    delNode.run(id); // AFTER DELETE trigger: 'delete' command into BOTH FTS tables + vec hygiene
  }
  return nodeIds.length;
}

/**
 * IDEA.v2 §5.1 — the incremental-ingest primitive, one BEGIN IMMEDIATE:
 * look up the documents row by (graph_id, source_key); unchanged
 * content_hash → no-op {skipped:true}; else delete prior atoms (triggers
 * keep both FTS indexes in lock-step), insert the new chunk batch, and
 * upsert the documents row. Connectors never diff content themselves.
 */
export function replaceDocument(conn: Connection, p: ReplaceDocumentPayload): ReplaceDocumentResult {
  return conn.immediate(() => {
    const existing = conn.db
      .prepare(`SELECT id, content_hash AS hash FROM documents WHERE graph_id = ? AND source_key = ?`)
      .get(p.graphId, p.sourceKey) as { id: number; hash: string } | undefined;

    if (existing && existing.hash === p.contentHash) {
      return { documentId: existing.id, skipped: true, nodeIds: [] };
    }

    let documentId: number;
    if (existing) {
      deleteDocumentAtoms(conn, existing.id);
      documentId = existing.id;
    } else {
      const info = conn.db
        .prepare(`INSERT INTO documents (graph_id, source_key, content_hash) VALUES (?, ?, ?)`)
        .run(p.graphId, p.sourceKey, p.contentHash);
      documentId = Number(info.lastInsertRowid);
    }

    const nodeIds = insertNodeRows(conn, p.rows, documentId);
    conn.db
      .prepare(`
        UPDATE documents SET
          content_hash = @hash, source_version = @version, atom_count = @count,
          ingested_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = @id
      `)
      .run({ id: documentId, hash: p.contentHash, version: p.sourceVersion ?? null, count: nodeIds.length });
    return { documentId, skipped: false, nodeIds };
  });
}

/** IDEA.v2 §7 — deletions from delta crawls (trashed pages, removed paths). */
export function deleteDocument(conn: Connection, p: DeleteDocumentPayload): { deleted: boolean; atoms: number } {
  return conn.immediate(() => {
    const row = conn.db
      .prepare(`SELECT id FROM documents WHERE graph_id = ? AND source_key = ?`)
      .get(p.graphId, p.sourceKey) as { id: number } | undefined;
    if (!row) return { deleted: false, atoms: 0 };
    const atoms = deleteDocumentAtoms(conn, row.id);
    conn.db.prepare(`DELETE FROM documents WHERE id = ?`).run(row.id);
    return { deleted: true, atoms };
  });
}

/**
 * Feature 4.1 — the CRDTStorageAdapter.saveAtomic() server side.
 * Atomically: apply the differential to the stored blob, refresh the
 * materialized title/body (which fires the FTS5 triggers), bump
 * _version, flag DIRTY, and append the event to the outbox.
 */
export function saveAtomic(conn: Connection, p: SaveAtomicPayload): { version: number } {
  return conn.immediate(() => {
    const row = conn.db
      .prepare(`SELECT crdt_blob AS blob, _version AS version FROM nodes WHERE id = ?`)
      .get(p.nodeId) as { blob: Uint8Array | null; version: number } | undefined;
    if (!row) throw new Error(`saveAtomic: node ${p.nodeId} not found`);

    const merged = mergeBlobs([row.blob ?? new Uint8Array(), p.crdtUpdate]);
    const fields = readAtomFields(merged);
    conn.db
      .prepare(`
        UPDATE nodes SET
          crdt_blob = @blob, title = @title, body = @body,
          _version = _version + 1,
          _last_modified = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
          _sync_status = 'DIRTY'
        WHERE id = @id
      `)
      .run({ id: p.nodeId, blob: merged, title: fields.title, body: fields.body });
    conn.db
      .prepare(`INSERT INTO outbox (node_id, event_type, payload) VALUES (?, 'node.updated', ?)`)
      .run(p.nodeId, p.crdtUpdate);
    return { version: row.version + 1 };
  });
}

/**
 * A remote peer's differential arrives. We do NOT clobber local state
 * (no Last-Write-Wins): the update is appended to the event log and the
 * node is flagged for the background sync worker to merge mathematically.
 *
 * v2 (IDEA.v2 §5.3) — epoch-aware arbitration:
 *   - a STALE-epoch update (sender compacted-behind) becomes
 *     _sync_status='CONFLICT' + outbox('remote.stale') for
 *     application-level review — graceful degradation, never silent
 *     merge of pre-compaction history, never corruption;
 *   - a NEWER-epoch update is a compacted snapshot: adopt it as the new
 *     baseline genesis state (blob replaced, fields rematerialized);
 *   - equal/absent epoch keeps demo001's merge-queue semantics.
 */
export function applyRemoteUpdate(
  conn: Connection,
  p: ApplyRemoteUpdatePayload,
): { ok: true; outcome: 'queued' | 'stale' | 'adopted' } {
  return conn.immediate(() => {
    const row = conn.db.prepare(`SELECT epoch FROM nodes WHERE id = ?`).get(p.nodeId) as
      | { epoch: number }
      | undefined;
    if (!row) throw new Error(`applyRemoteUpdate: node ${p.nodeId} not found`);

    if (p.epoch != null && p.epoch < row.epoch) {
      conn.db
        .prepare(`INSERT INTO outbox (node_id, event_type, payload) VALUES (?, 'remote.stale', ?)`)
        .run(p.nodeId, p.update);
      conn.db.prepare(`UPDATE nodes SET _sync_status = 'CONFLICT' WHERE id = ?`).run(p.nodeId);
      return { ok: true, outcome: 'stale' };
    }

    if (p.epoch != null && p.epoch > row.epoch) {
      const fields = readAtomFields(p.update);
      conn.db
        .prepare(`
          UPDATE nodes SET
            crdt_blob = @blob, title = @title, body = @body, epoch = @epoch,
            _version = _version + 1,
            _last_modified = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            _sync_status = 'SYNCED'
          WHERE id = @id
        `)
        .run({ id: p.nodeId, blob: p.update, title: fields.title, body: fields.body ?? '', epoch: p.epoch });
      conn.db
        .prepare(`INSERT INTO outbox (node_id, event_type, payload, _sync_status) VALUES (?, 'remote.adopt', ?, 'SYNCED')`)
        .run(p.nodeId, p.update);
      return { ok: true, outcome: 'adopted' };
    }

    conn.db
      .prepare(`INSERT INTO outbox (node_id, event_type, payload) VALUES (?, 'remote.update', ?)`)
      .run(p.nodeId, p.update);
    conn.db.prepare(`UPDATE nodes SET _sync_status = 'CONFLICT' WHERE id = ?`).run(p.nodeId);
    return { ok: true, outcome: 'queued' };
  });
}

/**
 * IDEA.v2 §5.3 — epoch GC: collapse one atom's CRDT history into a
 * fresh baseline doc (IDEA.v1 "The Snapshot … new baseline genesis
 * state"), preserving the materialized fields and bumping the epoch.
 * One BEGIN IMMEDIATE.
 */
export function compactAtom(conn: Connection, p: CompactAtomPayload): CompactAtomResult {
  return conn.immediate(() => compactAtomInTx(conn, p.nodeId));
}

function compactAtomInTx(conn: Connection, nodeId: number): CompactAtomResult {
  const row = conn.db
    .prepare(`SELECT crdt_blob AS blob, epoch FROM nodes WHERE id = ?`)
    .get(nodeId) as { blob: Uint8Array | null; epoch: number } | undefined;
  if (!row) throw new Error(`compactAtom: node ${nodeId} not found`);
  const bytesBefore = row.blob?.byteLength ?? 0;
  const fields = readAtomFields(row.blob ?? new Uint8Array());
  const fresh = createAtomBlob(fields); // collapsed baseline
  const epoch = row.epoch + 1;
  conn.db
    .prepare(`
      UPDATE nodes SET
        crdt_blob = @blob, epoch = @epoch,
        _last_modified = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = @id
    `)
    .run({ id: nodeId, blob: fresh, epoch });
  // the compacted snapshot flows the outbox like any edit so replicas
  // can adopt the new baseline (dual-write discipline)
  conn.db
    .prepare(`INSERT INTO outbox (node_id, event_type, payload) VALUES (?, 'node.compacted', ?)`)
    .run(nodeId, fresh);
  return { nodeId, epoch, bytesBefore, bytesAfter: fresh.byteLength };
}

/**
 * Batched GC sweep (one BEGIN IMMEDIATE per sweep — the batched-single-
 * transaction lesson of DEMO001 §13): candidates by blob size and/or
 * age, capped by limit.
 */
export function compactAtoms(
  conn: Connection,
  p: CompactAtomsPayload,
): { compacted: CompactAtomResult[] } {
  const where: string[] = [`crdt_blob IS NOT NULL`];
  if (p.maxBlobBytes != null) where.push(`length(crdt_blob) > ${Math.max(0, Math.floor(p.maxBlobBytes))}`);
  if (p.olderThan != null) where.push(`_last_modified < '${p.olderThan.replaceAll("'", "''")}'`);
  return conn.immediate(() => {
    const ids = (
      conn.db
        .prepare(`SELECT id FROM nodes WHERE ${where.join(' AND ')} ORDER BY id LIMIT ?`)
        .all(p.limit ?? 100) as { id: number }[]
    ).map((r) => r.id);
    return { compacted: ids.map((id) => compactAtomInTx(conn, id)) };
  });
}

/**
 * Task 4.2.2 — commit the sync worker's merge result: store the merged
 * blob + materialized text, mark node and consumed outbox rows SYNCED.
 */
export function commitMerge(conn: Connection, p: CommitMergePayload): { ok: true } {
  return conn.immediate(() => {
    conn.db
      .prepare(`
        UPDATE nodes SET
          crdt_blob = @blob, title = @title, body = @body,
          _version = _version + 1,
          _last_modified = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
          _sync_status = 'SYNCED'
        WHERE id = @id
      `)
      .run({ id: p.nodeId, blob: p.mergedBlob, title: p.title, body: p.body });
    const mark = conn.db.prepare(`UPDATE outbox SET _sync_status = 'SYNCED' WHERE id = ?`);
    for (const oid of p.outboxIds) mark.run(oid);
    return { ok: true };
  });
}

/** Batched variant — one BEGIN IMMEDIATE for a whole sync round. */
export function commitMerges(conn: Connection, p: { merges: CommitMergePayload[] }): { ok: true } {
  return conn.immediate(() => {
    const updateNode = conn.db.prepare(`
      UPDATE nodes SET
        crdt_blob = @blob, title = @title, body = @body,
        _version = _version + 1,
        _last_modified = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
        _sync_status = 'SYNCED'
      WHERE id = @id
    `);
    const markOutbox = conn.db.prepare(`UPDATE outbox SET _sync_status = 'SYNCED' WHERE id = ?`);
    for (const m of p.merges) {
      updateNode.run({ id: m.nodeId, blob: m.mergedBlob, title: m.title, body: m.body });
      for (const oid of m.outboxIds) markOutbox.run(oid);
    }
    return { ok: true };
  });
}

export function deleteNode(conn: Connection, p: { id: number }): { ok: true } {
  return conn.immediate(() => {
    // AFTER DELETE trigger emits the explicit 'delete' FTS5 command
    conn.db.prepare(`DELETE FROM outbox WHERE node_id = ?`).run(p.id);
    conn.db.prepare(`DELETE FROM nodes WHERE id = ?`).run(p.id);
    return { ok: true };
  });
}

// ---- DEMO003 Feature 1 — Edge Type (typed relationships) ----------------

/**
 * Add typed, weighted edges between Nodes. One BEGIN IMMEDIATE for the
 * whole batch (dual-write discipline; the batched-single-transaction
 * lesson of DEMO001 §13). Firewall: both endpoints must exist AND share a
 * graph_id — a cross-Graph edge is rejected, never silently stored, so an
 * edge can never breach the contextual firewall. UNIQUE(src,dst,type)
 * makes a repeated addEdge idempotent (it refreshes the weight).
 */
export function addEdges(conn: Connection, p: AddEdgesPayload): AddEdgesResult {
  return conn.immediate(() => {
    const graphOf = conn.db.prepare(`SELECT graph_id AS g FROM nodes WHERE id = ?`);
    const upsert = conn.db.prepare(`
      INSERT INTO edges (graph_id, src_node_id, dst_node_id, edge_type, weight)
      VALUES (@graphId, @src, @dst, @type, @weight)
      ON CONFLICT(src_node_id, dst_node_id, edge_type)
        DO UPDATE SET weight = excluded.weight
    `);
    const idOf = conn.db.prepare(
      `SELECT id FROM edges WHERE src_node_id = ? AND dst_node_id = ? AND edge_type = ?`,
    );
    const ids: number[] = [];
    for (const e of p.edges) {
      const srcG = graphOf.get(e.srcNodeId) as { g: number } | undefined;
      const dstG = graphOf.get(e.dstNodeId) as { g: number } | undefined;
      if (!srcG) throw new Error(`addEdge: src node ${e.srcNodeId} not found`);
      if (!dstG) throw new Error(`addEdge: dst node ${e.dstNodeId} not found`);
      if (srcG.g !== dstG.g) {
        throw new Error(
          `addEdge: cross-Graph edge rejected (src graph ${srcG.g} != dst graph ${dstG.g}) — contextual firewall`,
        );
      }
      upsert.run({
        graphId: srcG.g,
        src: e.srcNodeId,
        dst: e.dstNodeId,
        type: e.edgeType,
        weight: e.weight ?? 1.0,
      });
      ids.push((idOf.get(e.srcNodeId, e.dstNodeId, e.edgeType) as { id: number }).id);
    }
    return { ids };
  });
}

export function deleteEdge(conn: Connection, p: DeleteEdgePayload): { deleted: boolean } {
  return conn.immediate(() => {
    const info = conn.db
      .prepare(`DELETE FROM edges WHERE src_node_id = ? AND dst_node_id = ? AND edge_type = ?`)
      .run(p.srcNodeId, p.dstNodeId, p.edgeType);
    return { deleted: info.changes > 0 };
  });
}

// ---- DEMO003 Feature 2 — Supernode (cluster summary) --------------------

const SUPERNODE_STOPWORDS = new Set([
  'and', 'are', 'about', 'for', 'from', 'has', 'have', 'into', 'its', 'not',
  'that', 'the', 'this', 'was', 'were', 'with', 'will', 'you', 'your',
]);

/** Deterministic body tokenizer: lowercased words ≥3 chars, sans stopwords. */
function supernodeTokens(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9_]+/)) {
    if (raw.length < 3 || SUPERNODE_STOPWORDS.has(raw)) continue;
    out.push(raw);
  }
  return out;
}

/** First sentence (or first ~200 chars) of an atom body — a verbatim slice. */
function leadSentence(body: string): string {
  const trimmed = body.trim();
  const m = trimmed.match(/^[\s\S]*?[.!?](\s|$)/);
  const lead = (m ? m[0] : trimmed).trim();
  return lead.length > 200 ? lead.slice(0, 200).trim() : lead;
}

/**
 * DEMO003 Feature 2 — rebuild the per-Cluster Supernode summaries for a
 * Graph. Extractive + deterministic (no LLM, no randomness): the signature
 * is the cluster's top weighted terms (document-frequency × length); the
 * summary is the lead sentences of the Atoms most central to that
 * signature, as VERBATIM slices. One BEGIN IMMEDIATE. Re-running on
 * unchanged content yields an identical row (idempotent rebuild). Clusters
 * with no Atoms have their stale Supernode removed.
 */
export function rebuildSupernodes(conn: Connection, p: RebuildSupernodesPayload): RebuildSupernodesResult {
  const sigTerms = p.signatureTerms ?? 16;
  const sumAtoms = p.summaryAtoms ?? 3;
  return conn.immediate(() => {
    const filter =
      p.clusterIds && p.clusterIds.length > 0
        ? `AND id IN (${p.clusterIds.map((n) => Math.floor(n)).join(',')})`
        : '';
    const clusters = conn.db
      .prepare(`SELECT id, name FROM clusters WHERE graph_id = ? ${filter} ORDER BY id`)
      .all(p.graphId) as { id: number; name: string }[];

    const selAtoms = conn.db.prepare(
      `SELECT id, title, body FROM nodes WHERE cluster_id = ? ORDER BY id`,
    );
    const upsert = conn.db.prepare(`
      INSERT INTO supernodes (graph_id, cluster_id, title, summary, signature, atom_count, updated_at)
      VALUES (@graphId, @clusterId, @title, @summary, @signature, @atomCount,
              strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ON CONFLICT(cluster_id) DO UPDATE SET
        title = excluded.title, summary = excluded.summary, signature = excluded.signature,
        atom_count = excluded.atom_count, updated_at = excluded.updated_at
    `);
    const dropEmpty = conn.db.prepare(`DELETE FROM supernodes WHERE cluster_id = ?`);

    const rebuiltIds: number[] = [];
    for (const c of clusters) {
      const atoms = selAtoms.all(c.id) as { id: number; title: string; body: string }[];
      if (atoms.length === 0) {
        dropEmpty.run(c.id);
        continue;
      }
      // document-frequency × length weighting over distinct per-atom terms
      const weight = new Map<string, number>();
      const atomTerms: Set<string>[] = [];
      for (const a of atoms) {
        const terms = new Set(supernodeTokens(`${a.title} ${a.body}`));
        atomTerms.push(terms);
        for (const t of terms) weight.set(t, (weight.get(t) ?? 0) + Math.max(1, t.length / 4));
      }
      const ranked = [...weight.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      const top = ranked.slice(0, sigTerms);
      const maxW = top.length > 0 ? top[0][1] : 1;
      const signature: Record<string, number> = {};
      for (const [term, w] of top) signature[term] = Math.round((w / maxW) * 1000) / 1000;

      // centrality: atoms whose terms overlap the signature most
      const central = atoms
        .map((a, i) => {
          let overlap = 0;
          for (const t of atomTerms[i]) overlap += signature[t] ?? 0;
          return { a, overlap };
        })
        .sort((x, y) => y.overlap - x.overlap || x.a.id - y.a.id)
        .slice(0, sumAtoms)
        .map((x) => leadSentence(x.a.body))
        .filter((s) => s.length > 0);

      upsert.run({
        graphId: p.graphId,
        clusterId: c.id,
        title: `${c.name} · ${atoms.length} atoms`,
        summary: central.join(' … '),
        signature: JSON.stringify(signature),
        atomCount: atoms.length,
      });
      rebuiltIds.push(c.id);
    }
    return { rebuilt: rebuiltIds.length, clusterIds: rebuiltIds };
  });
}

/**
 * Helper used by tests/maintenance: verify FTS index integrity — BOTH
 * indexes, per IDEA.v2 §12 ("Both FTS tables in every trigger").
 */
export function checkFtsIntegrity(conn: Connection): { ok: true } {
  conn.db.prepare(`INSERT INTO nodes_fts(nodes_fts, rank) VALUES ('integrity-check', 0)`).run();
  conn.db.prepare(`INSERT INTO nodes_fts_words(nodes_fts_words, rank) VALUES ('integrity-check', 0)`).run();
  return { ok: true };
}
