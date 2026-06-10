/**
 * Read operations executed inside the parallel read-only reader threads
 * (Task 1.2.2). WAL mode lets these run concurrently with the writer
 * without ever observing a torn state.
 */
import type { Connection } from '../db/connection.js';
import {
  buildSearchSql,
  buildWordSearchSql,
  DEFAULT_WEIGHTS,
  sanitizeFtsQuery,
  sanitizeWordFtsQuery,
} from '../search/query.js';
import { bufferToEmbedding, dot } from '../search/embedder.js';
import { rrfFuse } from '../search/rrf.js';
import { keywordTerms } from '../search/terms.js';
import type {
  ClusterScore,
  DirtyOutboxPayload,
  DirtyOutboxRow,
  DocumentRow,
  EdgeRow,
  GetNodePayload,
  HybridSearchHit,
  HybridSearchPayload,
  HybridSource,
  NeighborRow,
  NeighborsPayload,
  RouteToClustersPayload,
  SearchHit,
  SearchPayload,
  SupernodeRow,
  VectorSearchPayload,
} from './protocol.js';

export function search(conn: Connection, p: SearchPayload): SearchHit[] {
  const match = sanitizeFtsQuery(p.query);
  if (!match) return [];
  const sql = buildSearchSql({ graphId: p.graphId, clusterId: p.clusterId });
  const rows = conn.db.prepare(sql).all({
    match,
    graphId: p.graphId,
    clusterId: p.clusterId,
    titleWeight: p.titleWeight ?? DEFAULT_WEIGHTS.title,
    bodyWeight: p.bodyWeight ?? DEFAULT_WEIGHTS.body,
    limit: p.limit ?? 10,
  });
  return rows as SearchHit[];
}

/** identifier-shaped query term: digits, _ , - , $ or internal camelCase */
function isIdentifierTerm(term: string): boolean {
  return /[0-9_$-]/.test(term) || /[a-z][A-Z]/.test(term);
}

/** IDEA.v2 §5.2 — word-level lane over the unicode61 index. */
export function wordSearch(conn: Connection, p: SearchPayload): SearchHit[] {
  const match = sanitizeWordFtsQuery(p.query);
  if (!match) return [];
  const sql = buildWordSearchSql({ graphId: p.graphId, clusterId: p.clusterId });
  const rows = conn.db.prepare(sql).all({
    match,
    graphId: p.graphId,
    clusterId: p.clusterId,
    titleWeight: p.titleWeight ?? DEFAULT_WEIGHTS.title,
    bodyWeight: p.bodyWeight ?? DEFAULT_WEIGHTS.body,
    limit: p.limit ?? 10,
  });
  return rows as SearchHit[];
}

/**
 * IDEA.v2 §5.2 — brute-force cosine top-K over the nodes_vec side-table.
 * The offline/CI lane; sqlite-vec ANN is the production swap-in behind
 * the same payload shape. Embeddings are L2-normalized → dot == cosine.
 */
export function vectorSearch(conn: Connection, p: VectorSearchPayload): SearchHit[] {
  const where: string[] = [];
  if (p.graphId != null) where.push(`n.graph_id = @graphId`);
  if (p.clusterId != null) where.push(`n.cluster_id = @clusterId`);
  const rows = conn.db
    .prepare(`
      SELECT
        n.id AS id, n.graph_id AS graphId, n.cluster_id AS clusterId, c.name AS cluster,
        n.title AS title, n.origin_file AS originFile, n.chunk_index AS chunkIndex,
        n.body AS body, v.embedding AS embedding
      FROM nodes_vec v
      JOIN nodes n    ON n.id = v.node_id
      JOIN clusters c ON c.id = n.cluster_id
      ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
    `)
    .all({ graphId: p.graphId, clusterId: p.clusterId }) as (SearchHit & { embedding: Buffer })[];

  const query = p.embedding;
  const scored = rows
    .map((r) => {
      const sim = dot(query, bufferToEmbedding(r.embedding));
      const { embedding: _e, ...hit } = r;
      // negate: SearchHit.score follows bm25's negative-is-better convention
      return { ...hit, score: -sim, snippet: '' } as SearchHit;
    })
    .sort((a, b) => a.score - b.score);
  return scored.slice(0, p.limit ?? 10);
}

/**
 * IDEA.v2 §5.2 — hybrid retrieval: trigram + word (+ optional vector)
 * lanes fused with RRF k=60 in one reader round-trip. Lane provenance is
 * retained per hit for eval attribution (DEMO001 §8.6 principle).
 *
 * IDEA.v2 Phase 9: when pre-extracted `terms` are supplied (NL queries —
 * the AND-semantics pitfall, DEMO001 §13), the lexical lanes run per
 * term and every (term × lane) ranking joins one in-shard RRF fusion, so
 * a chunk matching several question terms rises to the top before any
 * cross-shard fusion happens ("fused twice").
 */
export function hybridSearch(conn: Connection, p: HybridSearchPayload): HybridSearchHit[] {
  const limit = p.limit ?? 10;
  // modest over-fetch: fusion can promote a hit ranked just past `limit`
  // (kept tight — lane cost is the per-probe unit the whole federation
  // multiplies by)
  const laneLimit = Math.max(limit, 12);
  // ANY extracted term set replaces the raw query: "Where is X
  // implemented?" must search [X], not AND three unmatchable words
  // (the DEMO001 §13 AND-semantics pitfall, single-term edition)
  const queries = p.terms && p.terms.length > 0 ? p.terms : [p.query];

  const lanes: { name: HybridSource; hits: SearchHit[] }[] = [];
  for (const q of queries) {
    const lanePayload = { ...p, query: q, limit: laneLimit };
    const trigram = { name: 'trigram' as const, hits: search(conn, lanePayload) };
    const word = { name: 'word' as const, hits: wordSearch(conn, lanePayload) };
    lanes.push(trigram, word);
    // identifier-grade terms (digits / underscores / hyphens / camelCase)
    // are the exact-match payload — triple their fusion weight so three
    // prose words ("quarter milestone planned") can never out-vote the
    // one term that names the answer (exact-match precision pillar)
    if (isIdentifierTerm(q) && queries.length > 1) {
      lanes.push(trigram, word, trigram, word);
    }
  }
  if (p.embedding) {
    // the vector lane embeds the whole query once — semantic similarity
    // is not term-separable the way lexical matching is
    lanes.push({
      name: 'vector',
      hits: vectorSearch(conn, {
        embedding: p.embedding,
        limit: laneLimit,
        graphId: p.graphId,
        clusterId: p.clusterId,
      }),
    });
  }
  const fused = rrfFuse(
    lanes.map((l) => l.hits),
    (h) => String(h.id),
  );
  return fused.slice(0, limit).map((f) => ({
    ...f.item,
    rrfScore: f.rrfScore,
    sources: [...new Set(f.sources.map((i) => lanes[i].name))],
  }));
}

/** IDEA.v2 §5.1 — document identity lookup (dedup / incremental checks). */
export function getDocument(
  conn: Connection,
  p: { graphId: number; sourceKey: string },
): DocumentRow | null {
  return (
    (conn.db
      .prepare(`
        SELECT id, graph_id AS graphId, source_key AS sourceKey, content_hash AS contentHash,
               source_version AS sourceVersion, atom_count AS atomCount, ingested_at AS ingestedAt
        FROM documents WHERE graph_id = ? AND source_key = ?
      `)
      .get(p.graphId, p.sourceKey) as DocumentRow | undefined) ?? null
  );
}

/**
 * DEMO003 Feature 1 — 1-hop neighbours of a Node along typed edges. The
 * adjacent Node is joined to its title/cluster/body so callers can treat
 * neighbours as retrieval candidates (edge-expanded search). `direction`
 * selects out-edges (this node is the src), in-edges (this node is the
 * dst), or both. Ordered by weight desc, then node id for determinism.
 */
export function neighbors(conn: Connection, p: NeighborsPayload): NeighborRow[] {
  const direction = p.direction ?? 'out';
  const typeClause = p.edgeType ? `AND e.edge_type = @edgeType` : '';
  const parts: string[] = [];
  if (direction === 'out' || direction === 'both') {
    parts.push(`
      SELECT e.dst_node_id AS nodeId, e.edge_type AS edgeType, e.weight AS weight,
             'out' AS direction, n.title AS title, n.cluster_id AS clusterId,
             c.name AS cluster, n.body AS body
      FROM edges e JOIN nodes n ON n.id = e.dst_node_id JOIN clusters c ON c.id = n.cluster_id
      WHERE e.src_node_id = @nodeId ${typeClause}`);
  }
  if (direction === 'in' || direction === 'both') {
    parts.push(`
      SELECT e.src_node_id AS nodeId, e.edge_type AS edgeType, e.weight AS weight,
             'in' AS direction, n.title AS title, n.cluster_id AS clusterId,
             c.name AS cluster, n.body AS body
      FROM edges e JOIN nodes n ON n.id = e.src_node_id JOIN clusters c ON c.id = n.cluster_id
      WHERE e.dst_node_id = @nodeId ${typeClause}`);
  }
  const sql = `${parts.join(' UNION ALL ')} ORDER BY weight DESC, nodeId ASC LIMIT @limit`;
  return conn.db
    .prepare(sql)
    .all({ nodeId: p.nodeId, edgeType: p.edgeType ?? null, limit: p.limit ?? 25 }) as NeighborRow[];
}

export function edgesOf(conn: Connection, p: { nodeId: number }): EdgeRow[] {
  return conn.db
    .prepare(`
      SELECT id, graph_id AS graphId, src_node_id AS srcNodeId, dst_node_id AS dstNodeId,
             edge_type AS edgeType, weight
      FROM edges WHERE src_node_id = ? OR dst_node_id = ?
      ORDER BY id
    `)
    .all(p.nodeId, p.nodeId) as EdgeRow[];
}

export function getNode(conn: Connection, p: GetNodePayload): unknown {
  return (
    conn.db
      .prepare(`
        SELECT id, graph_id AS graphId, cluster_id AS clusterId, title, body,
               origin_file AS originFile, chunk_index AS chunkIndex, created_at AS createdAt,
               epoch, _version AS version, _last_modified AS lastModified, _sync_status AS syncStatus
        FROM nodes WHERE id = ?
      `)
      .get(p.id) ?? null
  );
}

export function loadCrdt(conn: Connection, p: { nodeId: number }): { blob: Uint8Array | null } {
  const row = conn.db.prepare(`SELECT crdt_blob AS blob FROM nodes WHERE id = ?`).get(p.nodeId) as
    | { blob: Uint8Array | null }
    | undefined;
  return { blob: row?.blob ?? null };
}

/**
 * Sync worker's poll query: DIRTY/CONFLICT outbox rows + current node
 * state. 'remote.stale' events are EXCLUDED — they are application-
 * review signals (IDEA.v2 §5.3); merging their pre-compaction payloads
 * back in would be exactly the silent merge the epoch check forbids.
 */
export function dirtyOutbox(conn: Connection, p: DirtyOutboxPayload): DirtyOutboxRow[] {
  return conn.db
    .prepare(`
      SELECT o.id AS outboxId, o.node_id AS nodeId, o.event_type AS eventType,
             o.payload AS payload, n.crdt_blob AS nodeBlob, n.title AS title, n.body AS body
      FROM outbox o JOIN nodes n ON n.id = o.node_id
      WHERE o._sync_status != 'SYNCED' AND o.event_type != 'remote.stale'
      ORDER BY o.id
      LIMIT ?
    `)
    .all(p.limit ?? 500) as DirtyOutboxRow[];
}

// ---- DEMO003 Feature 2 — Supernode (cluster summary) --------------------

function rowToSupernode(r: {
  id: number;
  graphId: number;
  clusterId: number;
  cluster: string;
  title: string;
  summary: string;
  signature: string;
  atomCount: number;
  updatedAt: string;
}): SupernodeRow {
  return { ...r, signature: JSON.parse(r.signature) as Record<string, number> };
}

const SUPERNODE_SELECT = `
  SELECT s.id AS id, s.graph_id AS graphId, s.cluster_id AS clusterId, c.name AS cluster,
         s.title AS title, s.summary AS summary, s.signature AS signature,
         s.atom_count AS atomCount, s.updated_at AS updatedAt
  FROM supernodes s JOIN clusters c ON c.id = s.cluster_id
`;

export function listSupernodes(conn: Connection, p: { graphId: number }): SupernodeRow[] {
  const rows = conn.db
    .prepare(`${SUPERNODE_SELECT} WHERE s.graph_id = ? ORDER BY s.cluster_id`)
    .all(p.graphId) as Parameters<typeof rowToSupernode>[0][];
  return rows.map(rowToSupernode);
}

export function getSupernode(
  conn: Connection,
  p: { graphId: number; clusterId: number },
): SupernodeRow | null {
  const row = conn.db
    .prepare(`${SUPERNODE_SELECT} WHERE s.graph_id = ? AND s.cluster_id = ?`)
    .get(p.graphId, p.clusterId) as Parameters<typeof rowToSupernode>[0] | undefined;
  return row ? rowToSupernode(row) : null;
}

/**
 * DEMO003 Feature 2 — rank a Graph's Clusters for a query by Supernode
 * signature. The cheap "is this topic worth opening?" probe: it reads only
 * the supernodes table, never the Atoms, so it can gate the expensive
 * lane work (retro bottleneck #1 — cold-open cost). Score = sum of the
 * matched terms' signature weights. Deterministic tie-break by cluster id.
 */
export function routeToClusters(conn: Connection, p: RouteToClustersPayload): ClusterScore[] {
  const terms = keywordTerms(p.query).map((t) => t.toLowerCase());
  const supers = listSupernodes(conn, { graphId: p.graphId });
  const scored = supers.map((s) => {
    let score = 0;
    for (const t of terms) score += s.signature[t] ?? 0;
    return { clusterId: s.clusterId, cluster: s.cluster, score, atomCount: s.atomCount };
  });
  scored.sort((a, b) => b.score - a.score || a.clusterId - b.clusterId);
  const ranked = scored.filter((s) => s.score > 0);
  // if nothing matched, fall back to the densest clusters (never empty-route)
  const base = ranked.length > 0 ? ranked : scored;
  return base.slice(0, p.limit ?? base.length);
}

export function stats(conn: Connection): Record<string, unknown> {
  const one = (sql: string) => (conn.db.prepare(sql).get() as Record<string, number>);
  return {
    graphs: one(`SELECT COUNT(*) AS n FROM graphs`).n,
    clusters: one(`SELECT COUNT(*) AS n FROM clusters`).n,
    nodes: one(`SELECT COUNT(*) AS n FROM nodes`).n,
    documents: one(`SELECT COUNT(*) AS n FROM documents`).n,
    ftsRows: one(`SELECT COUNT(*) AS n FROM nodes_fts`).n,
    ftsWordRows: one(`SELECT COUNT(*) AS n FROM nodes_fts_words`).n,
    vecRows: one(`SELECT COUNT(*) AS n FROM nodes_vec`).n,
    edges: one(`SELECT COUNT(*) AS n FROM edges`).n,
    supernodes: one(`SELECT COUNT(*) AS n FROM supernodes`).n,
    outboxDirty: one(`SELECT COUNT(*) AS n FROM outbox WHERE _sync_status != 'SYNCED'`).n,
    outboxTotal: one(`SELECT COUNT(*) AS n FROM outbox`).n,
    nodesByStatus: conn.db
      .prepare(`SELECT _sync_status AS status, COUNT(*) AS n FROM nodes GROUP BY _sync_status`)
      .all(),
    journalMode: (conn.db.pragma('journal_mode', { simple: true }) as string),
  };
}
