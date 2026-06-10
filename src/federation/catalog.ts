/**
 * IDEA.v2 §6.1 — the Federation catalog: shard registry + routing
 * signals + connector checkpoints + persistent ingest work queue +
 * replica state vectors.
 *
 * catalog.db is just another demo001-hardened SQLite file: every
 * connection goes through openConnection (WAL, busy_timeout,
 * synchronous=NORMAL) and every mutation through immediate() — BEGIN
 * IMMEDIATE. Catalog operations are microsecond-scale PK lookups over
 * ≤ ~2,000 rows, so they run on the calling thread; the kernel's
 * worker-pool topology exists for FTS/BM25 query latency, which the
 * catalog never incurs. Cross-OS-process safety comes from the same
 * WAL + busy_timeout + BEGIN IMMEDIATE discipline the shards use.
 *
 * No external queue (IDEA.v1 "Rejecting External Queues"): ingest_queue
 * is a table, restart-safe by construction.
 */
import { openConnection, type Connection } from '../db/connection.js';

export type ShardKind = 'repo' | 'space' | 'synthetic' | 'tree';
export type ShardStatus = 'ACTIVE' | 'INGESTING' | 'EVICTED' | 'SPLIT';
export type IngestTaskKind = 'full' | 'delta';

/** IDEA.v2 §6.4 — split signal thresholds (advisory only in v2). */
export const SPLIT_ATOM_THRESHOLD = 150_000;
export const SPLIT_BYTES_THRESHOLD = 1.5 * 1024 ** 3;

export interface ShardRow {
  id: number;
  shardKey: string;
  kind: ShardKind;
  dbPath: string;
  displayName: string;
  atomCount: number;
  docCount: number;
  bytes: number;
  status: ShardStatus;
  routingTerms: string[];
  /** ClusterDefs the shard's engine opens with (connector-supplied) */
  clusters: { name: string; keywords: string[] }[];
  updatedAt: string;
}

export interface IngestTask {
  id: number;
  shardKey: string;
  task: IngestTaskKind;
  priority: number;
}

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ','now')`;

export class Catalog {
  /** bumped on every same-connection mutation (cache invalidation) */
  private mutations = 0;

  private constructor(private readonly conn: Connection) {}

  /**
   * Cache token for derived routing state (ShardRouter): combines
   * SQLite's data_version (bumped when ANOTHER connection/process writes
   * the file) with a local mutation counter (own writes don't move
   * data_version). Token change ⇒ rebuild caches.
   */
  cacheToken(): string {
    const dv = this.conn.db.pragma('data_version', { simple: true }) as number;
    return `${dv}:${this.mutations}`;
  }

  /** wrap a mutating transaction; bumps the local mutation counter */
  private mutate<T>(fn: () => T): T {
    this.mutations++;
    return this.conn.immediate(fn);
  }

  static open(dbPath: string): Catalog {
    const conn = openConnection(dbPath);
    const cat = new Catalog(conn);
    cat.applySchema();
    cat.recoverQueue();
    return cat;
  }

  private applySchema(): void {
    this.conn.db.exec(`
      CREATE TABLE IF NOT EXISTS shards (
        id            INTEGER PRIMARY KEY,
        shard_key     TEXT NOT NULL UNIQUE,      -- 'gh:acme/payments' | 'cf:ENG' | synthetic key
        kind          TEXT NOT NULL CHECK (kind IN ('repo','space','synthetic','tree')),
        db_path       TEXT NOT NULL,
        display_name  TEXT NOT NULL,
        atom_count    INTEGER NOT NULL DEFAULT 0,
        doc_count     INTEGER NOT NULL DEFAULT 0,
        bytes         INTEGER NOT NULL DEFAULT 0,
        status        TEXT NOT NULL DEFAULT 'ACTIVE'
                      CHECK (status IN ('ACTIVE','INGESTING','EVICTED','SPLIT')),
        routing_terms TEXT NOT NULL DEFAULT '[]',  -- JSON: the shard's keyword signature
        clusters      TEXT NOT NULL DEFAULT '[]',  -- JSON ClusterDef[] for the shard engine
        updated_at    TEXT NOT NULL DEFAULT (${NOW})
      );

      -- IDEA.v2 §7 — connector resume points. Written strictly AFTER the
      -- document batch commits (checkpoint-after-commit discipline).
      CREATE TABLE IF NOT EXISTS checkpoints (
        shard_id  INTEGER NOT NULL REFERENCES shards(id),
        connector TEXT NOT NULL,
        cursor    TEXT NOT NULL,   -- git HEAD sha | confluence {watermark, pageCursor} JSON
        PRIMARY KEY (shard_id, connector)
      );

      -- IDEA.v2 §6.4 — persistent work queue (restart-safe; per-shard
      -- serialization enforced by the scheduler's claim discipline).
      CREATE TABLE IF NOT EXISTS ingest_queue (
        id         INTEGER PRIMARY KEY,
        shard_key  TEXT NOT NULL,
        task       TEXT NOT NULL CHECK (task IN ('full','delta')),
        priority   INTEGER NOT NULL DEFAULT 0,
        status     TEXT NOT NULL DEFAULT 'PENDING'
                   CHECK (status IN ('PENDING','RUNNING','DONE','FAILED')),
        created_at TEXT NOT NULL DEFAULT (${NOW}),
        updated_at TEXT NOT NULL DEFAULT (${NOW})
      );
      CREATE INDEX IF NOT EXISTS idx_queue_pending ON ingest_queue(status, priority DESC, id)
        WHERE status = 'PENDING';

      -- IDEA.v2 §5.3 — StabilityTracker inputs: per (replica, graph)
      -- acknowledged CRDT state vectors for causal-stability GC.
      CREATE TABLE IF NOT EXISTS replica_vectors (
        replica_id   TEXT NOT NULL,
        graph_id     TEXT NOT NULL,    -- shard key (one graph per shard in v2)
        state_vector BLOB NOT NULL,
        acked_at     TEXT NOT NULL DEFAULT (${NOW}),
        PRIMARY KEY (replica_id, graph_id)
      );

      -- DF-CAT-ROUTING-01 — per-shard term statistics + incremental
      -- document-frequency rollup, so IDF is computed ACROSS shards from
      -- aggregated stats rather than from whatever signatures happened to
      -- exist at ingest time (order-of-ingest bias).
      CREATE TABLE IF NOT EXISTS shard_term_stats (
        shard_id INTEGER PRIMARY KEY REFERENCES shards(id),
        stats    TEXT NOT NULL DEFAULT '{}'   -- JSON {term: tf}, top-N
      );
      CREATE TABLE IF NOT EXISTS term_df (
        term TEXT PRIMARY KEY,
        df   INTEGER NOT NULL DEFAULT 0       -- #shards whose stats contain the term
      );

      -- routing-signal FTS mirror (plain FTS5 table: rowid = shard id)
      CREATE VIRTUAL TABLE IF NOT EXISTS shard_terms USING fts5(
        shard_key, display_name, routing_terms_text
      );
    `);
  }

  /** Restart-safety: tasks left RUNNING by a crashed process re-queue. */
  private recoverQueue(): void {
    this.mutate(() => {
      this.conn.db
        .prepare(`UPDATE ingest_queue SET status = 'PENDING', updated_at = ${NOW} WHERE status = 'RUNNING'`)
        .run();
    });
  }

  // ---- shards ----------------------------------------------------------

  ensureShard(s: {
    shardKey: string;
    kind: ShardKind;
    dbPath: string;
    displayName?: string;
    clusters?: { name: string; keywords: string[] }[];
  }): ShardRow {
    return this.mutate(() => {
      this.conn.db
        .prepare(`
          INSERT INTO shards (shard_key, kind, db_path, display_name, clusters, updated_at)
          VALUES (@shardKey, @kind, @dbPath, @displayName, @clusters, ${NOW})
          ON CONFLICT(shard_key) DO UPDATE SET
            display_name = excluded.display_name,
            clusters = CASE WHEN excluded.clusters != '[]' THEN excluded.clusters ELSE shards.clusters END,
            updated_at = ${NOW}
        `)
        .run({
          shardKey: s.shardKey,
          kind: s.kind,
          dbPath: s.dbPath,
          displayName: s.displayName ?? s.shardKey,
          clusters: JSON.stringify(s.clusters ?? []),
        });
      return this.rowToShard(this.getShardRaw(s.shardKey)!);
    });
  }

  private getShardRaw(shardKey: string): Record<string, unknown> | undefined {
    return this.conn.db.prepare(`SELECT * FROM shards WHERE shard_key = ?`).get(shardKey) as
      | Record<string, unknown>
      | undefined;
  }

  private rowToShard(r: Record<string, unknown>): ShardRow {
    return {
      id: r.id as number,
      shardKey: r.shard_key as string,
      kind: r.kind as ShardKind,
      dbPath: r.db_path as string,
      displayName: r.display_name as string,
      atomCount: r.atom_count as number,
      docCount: r.doc_count as number,
      bytes: r.bytes as number,
      status: r.status as ShardStatus,
      routingTerms: JSON.parse(r.routing_terms as string) as string[],
      clusters: JSON.parse(r.clusters as string) as { name: string; keywords: string[] }[],
      updatedAt: r.updated_at as string,
    };
  }

  getShard(shardKey: string): ShardRow | null {
    const r = this.getShardRaw(shardKey);
    return r ? this.rowToShard(r) : null;
  }

  listShards(opts: { status?: ShardStatus } = {}): ShardRow[] {
    const rows = (
      opts.status
        ? this.conn.db
            .prepare(`SELECT * FROM shards WHERE status = ? ORDER BY updated_at DESC, shard_key`)
            .all(opts.status)
        : this.conn.db.prepare(`SELECT * FROM shards ORDER BY updated_at DESC, shard_key`).all()
    ) as Record<string, unknown>[];
    return rows.map((r) => this.rowToShard(r));
  }

  setShardStatus(shardKey: string, status: ShardStatus): void {
    this.mutate(() => {
      this.conn.db
        .prepare(`UPDATE shards SET status = @status, updated_at = ${NOW} WHERE shard_key = @shardKey`)
        .run({ shardKey, status });
    });
  }

  /**
   * Post-ingest stats rollup + split-signal detection (IDEA.v2 §6.4):
   * atom_count > 150k or bytes > 1.5 GiB marks SPLIT (advisory in v2 —
   * detect and report, never auto-split).
   */
  updateShardStats(
    shardKey: string,
    stats: { atomCount: number; docCount: number; bytes: number },
  ): { split: boolean } {
    return this.mutate(() => {
      const split = stats.atomCount > SPLIT_ATOM_THRESHOLD || stats.bytes > SPLIT_BYTES_THRESHOLD;
      this.conn.db
        .prepare(`
          UPDATE shards SET
            atom_count = @atomCount, doc_count = @docCount, bytes = @bytes,
            status = CASE WHEN @split THEN 'SPLIT' ELSE status END,
            updated_at = ${NOW}
          WHERE shard_key = @shardKey
        `)
        .run({ shardKey, ...stats, split: split ? 1 : 0 });
      return { split };
    });
  }

  // ---- routing signals (IDEA.v2 §6.1) ------------------------------------

  /**
   * routing_terms = top-N distinctive terms per shard (Σ tf × idf where
   * IDF is computed ACROSS shards — see recomputeRoutingTerms). Mirrors
   * into the shard_terms FTS table for rank-based candidate scoring.
   */
  setRoutingTerms(shardKey: string, terms: string[]): void {
    this.mutate(() => {
      const shard = this.getShardRaw(shardKey);
      if (!shard) throw new Error(`setRoutingTerms: unknown shard ${shardKey}`);
      this.conn.db
        .prepare(`UPDATE shards SET routing_terms = @terms, updated_at = ${NOW} WHERE shard_key = @shardKey`)
        .run({ shardKey, terms: JSON.stringify(terms) });
      this.conn.db.prepare(`DELETE FROM shard_terms WHERE rowid = ?`).run(shard.id as number);
      this.conn.db
        .prepare(`INSERT INTO shard_terms (rowid, shard_key, display_name, routing_terms_text) VALUES (?, ?, ?, ?)`)
        .run(shard.id as number, shardKey, shard.display_name as string, terms.join(' '));
    });
  }

  /**
   * Record one shard's raw term frequencies (top maxTerms by tf) and
   * keep the org-wide document-frequency rollup incremental: terms that
   * enter/leave the shard's stat set bump/drop term_df rows. This is the
   * "catalog aggregates per-shard term stats" half of DF-CAT-ROUTING-01.
   */
  recordTermStats(shardKey: string, termFreqs: Map<string, number>, maxTerms = 500): void {
    this.mutate(() => {
      const shard = this.getShardRaw(shardKey);
      if (!shard) throw new Error(`recordTermStats: unknown shard ${shardKey}`);
      const shardId = shard.id as number;
      const old = this.conn.db
        .prepare(`SELECT stats FROM shard_term_stats WHERE shard_id = ?`)
        .get(shardId) as { stats: string } | undefined;
      const oldTerms = new Set(Object.keys(old ? (JSON.parse(old.stats) as Record<string, number>) : {}));

      const top = [...termFreqs.entries()]
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
        .slice(0, maxTerms);
      const newStats: Record<string, number> = Object.fromEntries(top);
      const newTerms = new Set(Object.keys(newStats));

      const dfUp = this.conn.db.prepare(
        `INSERT INTO term_df (term, df) VALUES (?, 1) ON CONFLICT(term) DO UPDATE SET df = df + 1`,
      );
      const dfDown = this.conn.db.prepare(`UPDATE term_df SET df = MAX(0, df - 1) WHERE term = ?`);
      for (const t of newTerms) if (!oldTerms.has(t)) dfUp.run(t);
      for (const t of oldTerms) if (!newTerms.has(t)) dfDown.run(t);

      this.conn.db
        .prepare(`
          INSERT INTO shard_term_stats (shard_id, stats) VALUES (?, ?)
          ON CONFLICT(shard_id) DO UPDATE SET stats = excluded.stats
        `)
        .run(shardId, JSON.stringify(newStats));
    });
  }

  /**
   * Cross-shard IDF recompute (DF-CAT-ROUTING-01): score each of the
   * shard's recorded terms by tf × ln((total+1) / (1+df)), df from the
   * incremental org-wide rollup, and persist the top-N as the shard's
   * signature. When `termFreqs` is passed the stats are recorded first
   * (the common post-ingest path).
   */
  recomputeRoutingTerms(shardKey: string, termFreqs?: Map<string, number>, topN = 200): string[] {
    if (termFreqs) this.recordTermStats(shardKey, termFreqs);
    const shard = this.getShardRaw(shardKey);
    if (!shard) throw new Error(`recomputeRoutingTerms: unknown shard ${shardKey}`);
    const statsRow = this.conn.db
      .prepare(`SELECT stats FROM shard_term_stats WHERE shard_id = ?`)
      .get(shard.id as number) as { stats: string } | undefined;
    if (!statsRow) return [];
    const stats = JSON.parse(statsRow.stats) as Record<string, number>;
    const total = (this.conn.db.prepare(`SELECT COUNT(*) AS n FROM shards`).get() as { n: number }).n;
    const getDf = this.conn.db.prepare(`SELECT df FROM term_df WHERE term = ?`);
    const scored = Object.entries(stats)
      .map(([term, tf]) => {
        const df = ((getDf.get(term) as { df: number } | undefined)?.df ?? 0) || 1;
        return { term, score: tf * Math.log((total + 1) / (1 + df)) };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || (a.term < b.term ? -1 : 1))
      .slice(0, topN)
      .map((x) => x.term);
    this.setRoutingTerms(shardKey, scored);
    return scored;
  }

  /**
   * Re-derive every shard's signature from the aggregated stats. Run
   * after org-wide ingest waves: per-shard recomputes during the wave see
   * a moving df baseline (order-of-ingest bias); this pass settles all
   * signatures against the final rollup.
   */
  refreshAllRoutingTerms(topN = 200): number {
    let refreshed = 0;
    for (const s of this.listShards()) {
      const hasStats = this.conn.db
        .prepare(`SELECT 1 FROM shard_term_stats WHERE shard_id = ?`)
        .get(s.id);
      if (!hasStats) continue;
      this.recomputeRoutingTerms(s.shardKey, undefined, topN);
      refreshed++;
    }
    return refreshed;
  }

  /** rank-ordered shard candidates from the FTS mirror (component (a) of routing). */
  searchShardTerms(query: string, limit = 64): { shardKey: string; rank: number }[] {
    const terms = query
      .split(/\s+/)
      .map((t) => t.trim())
      .filter((t) => t.length > 0)
      .map((t) => `"${t.replaceAll('"', '""')}"`);
    if (terms.length === 0) return [];
    const match = terms.join(' OR ');
    const rows = this.conn.db
      .prepare(`
        SELECT shard_key AS shardKey, rank FROM shard_terms
        WHERE shard_terms MATCH ? ORDER BY rank LIMIT ?
      `)
      .all(match, limit) as { shardKey: string; rank: number }[];
    return rows;
  }

  // ---- checkpoints (IDEA.v2 §7) -------------------------------------------

  getCheckpoint(shardKey: string, connector: string): string | null {
    const row = this.conn.db
      .prepare(`
        SELECT c.cursor AS cursor FROM checkpoints c
        JOIN shards s ON s.id = c.shard_id
        WHERE s.shard_key = ? AND c.connector = ?
      `)
      .get(shardKey, connector) as { cursor: string } | undefined;
    return row?.cursor ?? null;
  }

  /** MUST be called only after the corresponding batch commits (IDEA.v2 §12). */
  putCheckpoint(shardKey: string, connector: string, cursor: string): void {
    this.mutate(() => {
      const shard = this.getShardRaw(shardKey);
      if (!shard) throw new Error(`putCheckpoint: unknown shard ${shardKey}`);
      this.conn.db
        .prepare(`
          INSERT INTO checkpoints (shard_id, connector, cursor) VALUES (?, ?, ?)
          ON CONFLICT(shard_id, connector) DO UPDATE SET cursor = excluded.cursor
        `)
        .run(shard.id as number, connector, cursor);
    });
  }

  // ---- ingest queue (IDEA.v2 §6.4) ----------------------------------------

  /** Enqueue; an identical PENDING task for the same shard dedupes. */
  enqueue(t: { shardKey: string; task: IngestTaskKind; priority?: number }): number {
    return this.mutate(() => {
      const dup = this.conn.db
        .prepare(`SELECT id FROM ingest_queue WHERE shard_key = ? AND task = ? AND status = 'PENDING'`)
        .get(t.shardKey, t.task) as { id: number } | undefined;
      if (dup) return dup.id;
      const info = this.conn.db
        .prepare(`INSERT INTO ingest_queue (shard_key, task, priority) VALUES (?, ?, ?)`)
        .run(t.shardKey, t.task, t.priority ?? 0);
      return Number(info.lastInsertRowid);
    });
  }

  /**
   * Claim the next PENDING task whose shard is not already running —
   * per-shard serialization (the 1-writer invariant at org level): a
   * shard never has two RUNNING ingest tasks.
   */
  claimNext(): IngestTask | null {
    return this.mutate(() => {
      const row = this.conn.db
        .prepare(`
          SELECT id, shard_key AS shardKey, task, priority FROM ingest_queue q
          WHERE status = 'PENDING'
            AND NOT EXISTS (
              SELECT 1 FROM ingest_queue r
              WHERE r.shard_key = q.shard_key AND r.status = 'RUNNING'
            )
          ORDER BY priority DESC, id
          LIMIT 1
        `)
        .get() as IngestTask | undefined;
      if (!row) return null;
      this.conn.db
        .prepare(`UPDATE ingest_queue SET status = 'RUNNING', updated_at = ${NOW} WHERE id = ?`)
        .run(row.id);
      return row;
    });
  }

  completeTask(id: number, ok: boolean): void {
    this.mutate(() => {
      this.conn.db
        .prepare(`UPDATE ingest_queue SET status = ?, updated_at = ${NOW} WHERE id = ?`)
        .run(ok ? 'DONE' : 'FAILED', id);
    });
  }

  queueDepth(): { pending: number; running: number } {
    const g = (s: string) =>
      (this.conn.db.prepare(`SELECT COUNT(*) AS n FROM ingest_queue WHERE status = ?`).get(s) as { n: number }).n;
    return { pending: g('PENDING'), running: g('RUNNING') };
  }

  // ---- replica vectors (IDEA.v2 §5.3 StabilityTracker) ---------------------

  ackReplicaVector(replicaId: string, graphId: string, stateVector: Uint8Array): void {
    this.mutate(() => {
      this.conn.db
        .prepare(`
          INSERT INTO replica_vectors (replica_id, graph_id, state_vector) VALUES (?, ?, ?)
          ON CONFLICT(replica_id, graph_id) DO UPDATE SET
            state_vector = excluded.state_vector, acked_at = ${NOW}
        `)
        .run(replicaId, graphId, stateVector);
    });
  }

  listReplicaVectors(graphId: string): { replicaId: string; stateVector: Uint8Array }[] {
    return (
      this.conn.db
        .prepare(`SELECT replica_id AS replicaId, state_vector AS stateVector FROM replica_vectors WHERE graph_id = ?`)
        .all(graphId) as { replicaId: string; stateVector: Uint8Array }[]
    );
  }

  close(): void {
    this.conn.close();
  }
}
