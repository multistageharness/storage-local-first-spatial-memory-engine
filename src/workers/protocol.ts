/**
 * Phase 1 / Feature 1.2 — message-passing protocol between the main
 * process broker and the worker threads. JSON-structured payloads,
 * matched to promises by monotonic request id.
 */

export interface WorkerRequest {
  id: number;
  op: string;
  payload: unknown;
}

export type WorkerResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: { message: string; stack?: string } };

/** First message a worker posts once its DB connection is open. */
export interface ReadyMessage {
  type: 'ready';
}

export interface WorkerInit {
  dbPath: string;
  /** writer applies schema on boot; readers wait for it to exist */
  role: 'writer' | 'reader';
}

// ---- write ops --------------------------------------------------------

export interface EnsureGraphPayload {
  name: string;
}

export interface ClusterDef {
  name: string;
  keywords: string[];
}

export interface EnsureClustersPayload {
  graphId: number;
  clusters: ClusterDef[];
}

export interface InsertNodeRow {
  graphId: number;
  clusterId: number;
  title: string;
  body: string;
  originFile?: string;
  chunkIndex: number;
  /** optional vector-lane embedding (IDEA.v2 §5.2), computed engine-side */
  embedding?: Float32Array;
}

export interface InsertNodesPayload {
  nodes: InsertNodeRow[];
}

// ---- IDEA.v2 §5.1 — incremental-ingest primitive -----------------------

export interface ReplaceDocumentPayload {
  graphId: number;
  /** repo-relative path | confluence page id */
  sourceKey: string;
  /** sha256 of normalized source text | git blob sha */
  contentHash: string;
  sourceVersion?: string;
  /** pre-chunked, pre-routed atom rows (connectors never diff content) */
  rows: InsertNodeRow[];
}

export interface ReplaceDocumentResult {
  documentId: number;
  /** true → content_hash unchanged, nothing touched */
  skipped: boolean;
  nodeIds: number[];
}

export interface DeleteDocumentPayload {
  graphId: number;
  sourceKey: string;
}

export interface DocumentRow {
  id: number;
  graphId: number;
  sourceKey: string;
  contentHash: string;
  sourceVersion: string | null;
  atomCount: number;
  ingestedAt: string;
}

export interface SaveAtomicPayload {
  nodeId: number;
  /** serialized Yjs differential update */
  crdtUpdate: Uint8Array;
  metadata?: { title?: string; originFile?: string };
}

export interface CommitMergePayload {
  nodeId: number;
  mergedBlob: Uint8Array;
  /** materialized text extracted from the merged doc, for FTS5 re-index */
  title: string;
  body: string;
  outboxIds: number[];
}

export interface ApplyRemoteUpdatePayload {
  nodeId: number;
  update: Uint8Array;
  /**
   * IDEA.v2 §5.3 — sender's epoch for the atom. Comparison against the
   * local epoch decides the path:
   *   remote < local  → CONFLICT + outbox('remote.stale') — never a
   *                     silent merge of pre-compaction history;
   *   remote > local  → adopt the compacted baseline (snapshot = new
   *                     genesis state);
   *   equal / absent  → normal merge-queue path (demo001 behavior).
   */
  epoch?: number;
}

// ---- IDEA.v2 §5.3 — epoch-based CRDT GC ---------------------------------

export interface CompactAtomPayload {
  nodeId: number;
}

export interface CompactAtomResult {
  nodeId: number;
  epoch: number;
  bytesBefore: number;
  bytesAfter: number;
}

export interface CompactAtomsPayload {
  /** compact atoms whose blob exceeds this many bytes */
  maxBlobBytes?: number;
  /** and/or atoms last modified before this ISO timestamp */
  olderThan?: string;
  limit?: number;
}

// ---- DEMO003 Feature 1 — Edge Type (typed relationships) ----------------

export interface EdgeInput {
  srcNodeId: number;
  dstNodeId: number;
  /** relationship kind, e.g. 'references' | 'derived_from' | 'mentions' */
  edgeType: string;
  /** default 1.0 */
  weight?: number;
}

export interface AddEdgesPayload {
  edges: EdgeInput[];
}

export interface AddEdgesResult {
  ids: number[];
}

export interface DeleteEdgePayload {
  srcNodeId: number;
  dstNodeId: number;
  edgeType: string;
}

export type EdgeDirection = 'out' | 'in' | 'both';

export interface NeighborsPayload {
  nodeId: number;
  edgeType?: string;
  direction?: EdgeDirection;
  limit?: number;
}

export interface NeighborRow {
  /** the adjacent node's id */
  nodeId: number;
  edgeType: string;
  weight: number;
  /** 'out' = nodeId is the dst of an edge from the query node, etc. */
  direction: 'out' | 'in';
  title: string;
  clusterId: number;
  cluster: string;
  body: string;
}

export interface EdgeRow {
  id: number;
  graphId: number;
  srcNodeId: number;
  dstNodeId: number;
  edgeType: string;
  weight: number;
}

// ---- DEMO003 Feature 2 — Supernode (cluster summary) --------------------

export interface RebuildSupernodesPayload {
  graphId: number;
  /** restrict to these cluster ids; omit = every non-empty cluster */
  clusterIds?: number[];
  /** signature size (top-N terms); default 16 */
  signatureTerms?: number;
  /** summary length (lead atoms); default 3 */
  summaryAtoms?: number;
}

export interface SupernodeRow {
  id: number;
  graphId: number;
  clusterId: number;
  cluster: string;
  title: string;
  summary: string;
  /** parsed term→weight signature */
  signature: Record<string, number>;
  atomCount: number;
  updatedAt: string;
}

export interface RebuildSupernodesResult {
  rebuilt: number;
  clusterIds: number[];
}

export interface RouteToClustersPayload {
  graphId: number;
  query: string;
  limit?: number;
}

export interface ClusterScore {
  clusterId: number;
  cluster: string;
  score: number;
  atomCount: number;
}

// ---- read ops ---------------------------------------------------------

export interface SearchPayload {
  query: string;
  limit?: number;
  graphId?: number;
  clusterId?: number;
  /** Task 3.2.3 — column weighting; defaults: title 2.0, body 1.0 */
  titleWeight?: number;
  bodyWeight?: number;
}

export interface SearchHit {
  id: number;
  graphId: number;
  clusterId: number;
  cluster: string;
  title: string;
  originFile: string | null;
  chunkIndex: number;
  score: number;
  snippet: string;
  body: string;
}

// ---- IDEA.v2 §5.2 — hybrid retrieval ------------------------------------

export type HybridSource = 'trigram' | 'word' | 'vector' | 'edge';

export interface HybridSearchPayload extends SearchPayload {
  /** query embedding — present only when the vector lane is enabled */
  embedding?: Float32Array;
  /**
   * IDEA.v2 Phase 9 — pre-extracted salient terms. When present (> 1),
   * lanes run per term and the per-term rankings RRF-fuse inside the
   * shard before any cross-shard fusion ("fused twice").
   */
  terms?: string[];
}

export interface HybridSearchHit extends SearchHit {
  /** RRF k=60 fused score across the contributing lanes */
  rrfScore: number;
  sources: HybridSource[];
}

export interface VectorSearchPayload {
  embedding: Float32Array;
  limit?: number;
  graphId?: number;
  clusterId?: number;
}

export interface GetNodePayload {
  id: number;
}

export interface DirtyOutboxPayload {
  limit?: number;
}

export interface DirtyOutboxRow {
  outboxId: number;
  nodeId: number;
  eventType: string;
  payload: Uint8Array | null;
  nodeBlob: Uint8Array | null;
  title: string;
  body: string;
}
