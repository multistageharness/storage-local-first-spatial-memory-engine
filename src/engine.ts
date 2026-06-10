/**
 * MemoryEngine — the public facade tying the four phases together.
 *
 *   Phase 1: WorkerBroker (1 writer / N readers, WAL, BEGIN IMMEDIATE)
 *   Phase 2: ClusterRouter + chunker (Graph → Cluster → Node/Atom)
 *   Phase 3: FTS5 trigram BM25 retrieval with column weighting
 *   Phase 4: CRDTStorageAdapter + event-sourced outbox + SyncPipeline
 *
 * v2 per-shard deltas (IDEA.v2 §5):
 *   §5.1 replaceDocument / deleteDocument — incremental-ingest primitives
 *   §5.2 hybridSearch — trigram + unicode61 (+ optional vector lane) RRF
 */
import { createHash } from 'node:crypto';
import { WorkerBroker } from './workers/broker.js';
import { ClusterRouter, GENERAL_CLUSTER } from './spatial/router.js';
import { chunkText, type ChunkOptions } from './spatial/chunker.js';
import { CRDTStorageAdapter } from './sync/adapter.js';
import { SyncPipeline } from './sync/pipeline.js';
import { HashingEmbedder, type Embedder } from './search/embedder.js';
import { keywordTerms } from './search/terms.js';
import type {
  AddEdgesResult,
  ClusterScore,
  ClusterDef,
  CompactAtomResult,
  CompactAtomsPayload,
  DocumentRow,
  EdgeDirection,
  EdgeInput,
  EdgeRow,
  HybridSearchHit,
  HybridSearchPayload,
  InsertNodeRow,
  NeighborRow,
  RebuildSupernodesResult,
  ReplaceDocumentResult,
  SearchHit,
  SearchPayload,
  SupernodeRow,
} from './workers/protocol.js';

/**
 * 'off' (default) — lexical lanes only. 'local' — embeddings stored in
 * nodes_vec, brute-force cosine lane (offline/CI). 'sqlite-vec' is the
 * production ANN swap-in; unavailable in this environment, the option is
 * reserved (IDEA.v2 §5.2; deviation recorded in the IR artifact).
 */
export type VectorMode = 'off' | 'local';

export interface EngineOptions {
  dbPath: string;
  /** entity-level contextual firewall (Phase 2 "Graph") */
  graph?: string;
  clusters?: ClusterDef[];
  minReaders?: number;
  maxReaders?: number;
  /** background CRDT sync poll; 0 = manual syncNow() only */
  syncIntervalMs?: number;
  chunking?: ChunkOptions;
  /** routing threshold — weighted keyword hits per 1000 chars */
  minDensity?: number;
  /** IDEA.v2 §5.2 — optional vector lane, off by default */
  vectors?: VectorMode;
  /** embedder for the vector lane; HashingEmbedder(384) by default */
  embedder?: Embedder;
  /**
   * IDEA.v2 §5.3 — epoch-GC heuristic: after each sync round, atoms
   * whose crdt_blob exceeds this many bytes are compacted (bounded
   * sweep). Default 64 KiB; 0 disables.
   */
  gcBlobThreshold?: number;
}

/** Connector-facing source document (IDEA.v2 §7 contract). */
export interface SourceDocumentInput {
  /** repo-relative path | confluence page id */
  sourceKey: string;
  title: string;
  text: string;
  /** computed from text (sha256) when omitted */
  contentHash?: string;
  sourceVersion?: string;
  originFile?: string;
}

export interface ReplaceDocumentOutcome extends ReplaceDocumentResult {
  chunks: number;
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export interface IngestResult {
  nodeIds: number[];
  chunks: number;
  /** distinct clusters the chunks were routed into */
  clusters: Record<string, number>;
}

export interface SearchOptions {
  limit?: number;
  cluster?: string;
  titleWeight?: number;
  bodyWeight?: number;
}

/**
 * DEMO003 Feature 1 — opt-in relationship-aware expansion. When set, the
 * 1-hop neighbours of the base hits (along `edgeType`, `direction`) join
 * the result set with a down-weighted score, so a related Atom that no
 * lexical/vector lane matched can still surface. OFF by default — the
 * tuned default retrieval path is unchanged.
 */
export interface EdgeExpandOptions {
  edgeType?: string;
  direction?: EdgeDirection;
  /** multiplier applied to the parent hit's score for a neighbour; default 0.5 */
  weight?: number;
}

/** DEMO003 Feature 2 — opt-in Supernode pre-filter (see hybridSearch). */
export interface SupernodeRouteOptions {
  /** keep only hits from the top-k clusters by Supernode signature; default 1 */
  topClusters?: number;
}

export interface HybridSearchOptions extends SearchOptions {
  expand?: EdgeExpandOptions;
  viaSupernodes?: SupernodeRouteOptions | boolean;
}

export class MemoryEngine {
  readonly crdt: CRDTStorageAdapter;

  private constructor(
    private readonly broker: WorkerBroker,
    private readonly sync: SyncPipeline,
    private readonly router: ClusterRouter,
    private readonly graphId: number,
    private readonly clusterIds: Record<string, number>,
    private readonly chunking: ChunkOptions,
    private readonly vectors: VectorMode,
    private readonly embedder: Embedder,
    private readonly gcBlobThreshold: number,
  ) {
    this.crdt = new CRDTStorageAdapter(broker);
  }

  static async open(opts: EngineOptions): Promise<MemoryEngine> {
    const broker = await WorkerBroker.open({
      dbPath: opts.dbPath,
      minReaders: opts.minReaders,
      maxReaders: opts.maxReaders,
    });
    const clusters = opts.clusters ?? [];
    const { id: graphId } = await broker.write<{ id: number }>('ensureGraph', {
      name: opts.graph ?? 'default',
    });
    const { ids: clusterIds } = await broker.write<{ ids: Record<string, number> }>('ensureClusters', {
      graphId,
      clusters,
    });
    const sync = await SyncPipeline.start({
      dbPath: opts.dbPath,
      broker,
      intervalMs: opts.syncIntervalMs ?? 0,
    });
    const router = new ClusterRouter(clusters, { minDensity: opts.minDensity });
    return new MemoryEngine(
      broker,
      sync,
      router,
      graphId,
      clusterIds,
      opts.chunking ?? {},
      opts.vectors ?? 'off',
      opts.embedder ?? new HashingEmbedder(),
      opts.gcBlobThreshold ?? 64 * 1024,
    );
  }

  /** chunk → route → (optionally embed) → InsertNodeRow batch */
  private async buildRows(doc: {
    title: string;
    text: string;
    originFile?: string;
  }): Promise<{ rows: InsertNodeRow[]; clusterCounts: Record<string, number> }> {
    const chunks = chunkText(doc.text, this.chunking);
    const rows: InsertNodeRow[] = [];
    const clusterCounts: Record<string, number> = {};
    for (const chunk of chunks) {
      const { cluster } = this.router.route(chunk.text);
      const clusterId = this.clusterIds[cluster] ?? this.clusterIds[GENERAL_CLUSTER];
      clusterCounts[cluster] = (clusterCounts[cluster] ?? 0) + 1;
      rows.push({
        graphId: this.graphId,
        clusterId,
        title: doc.title,
        body: chunk.text,
        originFile: doc.originFile,
        chunkIndex: chunk.index,
        embedding: this.vectors === 'off' ? undefined : await this.embedder.embed(chunk.text),
      });
    }
    return { rows, clusterCounts };
  }

  /**
   * Feature 2.2 — verbatim ingestion: chunk → route each chunk by keyword
   * density → batch-insert as immutable Atoms (one BEGIN IMMEDIATE
   * transaction, outbox events appended atomically).
   */
  async ingestDocument(doc: { title: string; text: string; originFile?: string }): Promise<IngestResult> {
    const { rows, clusterCounts } = await this.buildRows(doc);
    if (rows.length === 0) return { nodeIds: [], chunks: 0, clusters: {} };
    const { ids } = await this.broker.write<{ ids: number[] }>('insertNodes', { nodes: rows });
    return { nodeIds: ids, chunks: rows.length, clusters: clusterCounts };
  }

  /**
   * IDEA.v2 §5.1 — the incremental-ingest primitive. Same chunk/route
   * path as ingestDocument, but keyed by (graph, sourceKey): unchanged
   * content_hash no-ops, changed content atomically swaps every atom of
   * the document in one BEGIN IMMEDIATE transaction.
   */
  async replaceDocument(doc: SourceDocumentInput): Promise<ReplaceDocumentOutcome> {
    const contentHash = doc.contentHash ?? sha256Hex(doc.text);
    // cheap engine-side pre-check: unchanged hash skips chunking/embedding
    const existing = await this.getDocument(doc.sourceKey);
    if (existing && existing.contentHash === contentHash) {
      return { documentId: existing.id, skipped: true, nodeIds: [], chunks: 0 };
    }
    const { rows } = await this.buildRows({
      title: doc.title,
      text: doc.text,
      originFile: doc.originFile ?? doc.sourceKey,
    });
    const result = await this.broker.write<ReplaceDocumentResult>('replaceDocument', {
      graphId: this.graphId,
      sourceKey: doc.sourceKey,
      contentHash,
      sourceVersion: doc.sourceVersion,
      rows,
    });
    return { ...result, chunks: rows.length };
  }

  /** IDEA.v2 §7 — delta-crawl deletions (trashed pages, removed paths). */
  async deleteDocument(sourceKey: string): Promise<{ deleted: boolean; atoms: number }> {
    return this.broker.write('deleteDocument', { graphId: this.graphId, sourceKey });
  }

  async getDocument(sourceKey: string): Promise<DocumentRow | null> {
    return this.broker.read('getDocument', { graphId: this.graphId, sourceKey });
  }

  /** Phase 3 — exact-match lexical retrieval, BM25-ranked, title 2× weighted. */
  async search(query: string, opts: SearchOptions = {}): Promise<SearchHit[]> {
    const payload: SearchPayload = {
      query,
      limit: opts.limit,
      graphId: this.graphId,
      clusterId: opts.cluster ? this.clusterIds[opts.cluster] : undefined,
      titleWeight: opts.titleWeight,
      bodyWeight: opts.bodyWeight,
    };
    return this.broker.read<SearchHit[]>('search', payload);
  }

  /** IDEA.v2 §5.2 — word-level lane only (unicode61 index), for diagnostics. */
  async wordSearch(query: string, opts: SearchOptions = {}): Promise<SearchHit[]> {
    const payload: SearchPayload = {
      query,
      limit: opts.limit,
      graphId: this.graphId,
      clusterId: opts.cluster ? this.clusterIds[opts.cluster] : undefined,
      titleWeight: opts.titleWeight,
      bodyWeight: opts.bodyWeight,
    };
    return this.broker.read<SearchHit[]>('wordSearch', payload);
  }

  /**
   * IDEA.v2 §5.2 — hybrid retrieval: trigram + unicode61 word lanes
   * (+ vector lane when enabled), fused with RRF k=60, lane provenance
   * on every hit. Multi-word queries are split into salient terms and
   * fused per term in-shard (IDEA.v2 Phase 9 — the AND-semantics
   * bridge). The exact-match pillar is protected by a gated property:
   * hybrid recall ≥ trigram-only recall on every eval.
   */
  async hybridSearch(query: string, opts: HybridSearchOptions = {}): Promise<HybridSearchHit[]> {
    const terms = keywordTerms(query);
    const limit = opts.limit ?? 10;
    // When a relationship/supernode post-step is requested, over-fetch the
    // base so expansion/pre-filter has headroom to re-rank into the top-N.
    const wantsPost = opts.expand != null || opts.viaSupernodes;
    const payload: HybridSearchPayload = {
      query,
      // pass terms whenever extraction found any salient token — a raw
      // NL query with one identifier must search the identifier alone
      terms: terms.length > 0 ? terms : undefined,
      limit: wantsPost ? Math.max(limit, limit * 3) : opts.limit,
      graphId: this.graphId,
      clusterId: opts.cluster ? this.clusterIds[opts.cluster] : undefined,
      titleWeight: opts.titleWeight,
      bodyWeight: opts.bodyWeight,
      embedding: this.vectors === 'off' ? undefined : await this.embedder.embed(query),
    };
    let hits = await this.broker.read<HybridSearchHit[]>('hybridSearch', payload);

    // DEMO003 Feature 2 — Supernode pre-filter: keep only hits whose
    // Cluster ranks in the top-k by Supernode signature for this query.
    // Recall-preserving by construction (a strict subset of base hits).
    if (opts.viaSupernodes) {
      const topClusters =
        typeof opts.viaSupernodes === 'object' ? opts.viaSupernodes.topClusters ?? 1 : 1;
      const ranked = await this.routeToClusters(query, topClusters);
      const keep = new Set(ranked.map((r) => r.clusterId));
      if (keep.size > 0) hits = hits.filter((h) => keep.has(h.clusterId));
    }

    // DEMO003 Feature 1 — edge expansion: fold 1-hop neighbours of the base
    // hits in as extra candidates with a down-weighted score.
    if (opts.expand) {
      hits = await this.expandAlongEdges(hits, opts.expand);
    }

    return wantsPost ? hits.slice(0, limit) : hits;
  }

  /** Merge edge-neighbours of the base hits into the result set (Feature 1). */
  private async expandAlongEdges(
    base: HybridSearchHit[],
    expand: EdgeExpandOptions,
  ): Promise<HybridSearchHit[]> {
    const factor = expand.weight ?? 0.5;
    const byId = new Map<number, HybridSearchHit>(base.map((h) => [h.id, h]));
    for (const parent of base) {
      const neighbours = await this.neighbors(parent.id, {
        edgeType: expand.edgeType,
        direction: expand.direction ?? 'out',
      });
      for (const n of neighbours) {
        const candidateScore = parent.rrfScore * factor * n.weight;
        const existing = byId.get(n.nodeId);
        if (existing) {
          // already a hit — only lift its score, never lower, and tag provenance
          if (candidateScore > existing.rrfScore) existing.rrfScore = candidateScore;
          if (!existing.sources.includes('edge')) existing.sources.push('edge');
          continue;
        }
        byId.set(n.nodeId, {
          id: n.nodeId,
          graphId: this.graphId,
          clusterId: n.clusterId,
          cluster: n.cluster,
          title: n.title,
          originFile: null,
          chunkIndex: 0,
          score: 0,
          snippet: '',
          body: n.body,
          rrfScore: candidateScore,
          sources: ['edge'],
        });
      }
    }
    return [...byId.values()].sort((a, b) => b.rrfScore - a.rrfScore);
  }

  // ---- DEMO003 Feature 1 — Edge Type API --------------------------------

  /** Add one typed edge between two Atoms (intra-Graph; idempotent). */
  async addEdge(edge: EdgeInput): Promise<number> {
    const { ids } = await this.addEdges([edge]);
    return ids[0];
  }

  /** Batch edge insert — one BEGIN IMMEDIATE. */
  async addEdges(edges: EdgeInput[]): Promise<AddEdgesResult> {
    return this.broker.write<AddEdgesResult>('addEdges', { edges });
  }

  async deleteEdge(srcNodeId: number, dstNodeId: number, edgeType: string): Promise<{ deleted: boolean }> {
    return this.broker.write('deleteEdge', { srcNodeId, dstNodeId, edgeType });
  }

  /** 1-hop neighbours of a Node along typed edges. */
  async neighbors(
    nodeId: number,
    opts: { edgeType?: string; direction?: EdgeDirection; limit?: number } = {},
  ): Promise<NeighborRow[]> {
    return this.broker.read<NeighborRow[]>('neighbors', { nodeId, ...opts });
  }

  /** Raw edge rows touching a Node (either direction). */
  async edgesOf(nodeId: number): Promise<EdgeRow[]> {
    return this.broker.read<EdgeRow[]>('edgesOf', { nodeId });
  }

  // ---- DEMO003 Feature 2 — Supernode API --------------------------------

  /**
   * Rebuild the per-Cluster Supernode summaries for this Graph. Extractive
   * and deterministic — no LLM, reproducible across runs.
   */
  async rebuildSupernodes(opts: { clusterIds?: number[]; signatureTerms?: number; summaryAtoms?: number } = {}): Promise<RebuildSupernodesResult> {
    return this.broker.write<RebuildSupernodesResult>('rebuildSupernodes', {
      graphId: this.graphId,
      ...opts,
    });
  }

  async listSupernodes(): Promise<SupernodeRow[]> {
    return this.broker.read<SupernodeRow[]>('listSupernodes', { graphId: this.graphId });
  }

  async getSupernode(cluster: string): Promise<SupernodeRow | null> {
    const clusterId = this.clusterIds[cluster];
    if (clusterId == null) return null;
    return this.broker.read<SupernodeRow | null>('getSupernode', { graphId: this.graphId, clusterId });
  }

  /**
   * Rank this Graph's Clusters for a query by Supernode signature — the
   * cheap "is this topic worth opening?" probe (retro bottleneck #1). Reads
   * supernodes only, never the Atoms.
   */
  async routeToClusters(query: string, limit?: number): Promise<ClusterScore[]> {
    return this.broker.read<ClusterScore[]>('routeToClusters', {
      graphId: this.graphId,
      query,
      limit,
    });
  }

  async getNode(id: number): Promise<unknown> {
    return this.broker.read('getNode', { id });
  }

  /** Delete one Atom; AFTER DELETE trigger cascades FTS, vector, and edge hygiene. */
  async deleteNode(id: number): Promise<{ ok: true }> {
    return this.broker.write('deleteNode', { id });
  }

  /**
   * Simulate/ingest a remote peer's CRDT differential (Feature 4.2).
   * v2: an optional sender epoch arbitrates stale/adopt/merge paths
   * (IDEA.v2 §5.3).
   */
  async applyRemoteUpdate(
    nodeId: number,
    update: Uint8Array,
    epoch?: number,
  ): Promise<{ ok: true; outcome: 'queued' | 'stale' | 'adopted' }> {
    return this.broker.write('applyRemoteUpdate', { nodeId, update, epoch });
  }

  /** IDEA.v2 §5.3 — collapse one atom's CRDT history (epoch GC). */
  async compactAtom(nodeId: number): Promise<CompactAtomResult> {
    return this.broker.write('compactAtom', { nodeId });
  }

  /** Batched GC sweep by blob size and/or age. */
  async compactAtoms(opts: CompactAtomsPayload = {}): Promise<{ compacted: CompactAtomResult[] }> {
    return this.broker.write('compactAtoms', opts);
  }

  /**
   * Drive one sync round: merge all DIRTY/CONFLICT outbox entries.
   * v2: when the gcBlobThreshold heuristic trips, a bounded compaction
   * sweep follows the round (IDEA.v2 §5.3 — GC is driven by the sync
   * pipeline, the batched-single-transaction lesson of DEMO001 §13).
   */
  async syncNow(): Promise<{ merged: number; compacted?: number }> {
    const result = await this.sync.syncNow();
    if (this.gcBlobThreshold > 0) {
      const { compacted } = await this.compactAtoms({ maxBlobBytes: this.gcBlobThreshold, limit: 100 });
      if (compacted.length > 0) return { ...result, compacted: compacted.length };
    }
    return result;
  }

  async stats(): Promise<Record<string, unknown>> {
    return this.broker.read('stats', {});
  }

  get readerCount(): number {
    return this.broker.readerCount;
  }

  async close(): Promise<void> {
    await this.sync.close();
    await this.broker.close();
  }
}
