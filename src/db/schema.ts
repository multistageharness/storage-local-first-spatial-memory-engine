/**
 * Schema for the spatial memory paradigm (Phase 2) plus the FTS5
 * external-content index (Phase 3) and the event-sourced sync columns /
 * outbox (Phase 4).
 *
 * v2 (IDEA.v2 §5.1–§5.3) adds, per shard:
 *   - `documents` — per-source-document identity rows enabling
 *     incremental ingest (content_hash no-op skip, atomic replaceDocument);
 *   - `nodes.document_id` — atoms grouped by source document;
 *   - `nodes.epoch` — monotonic counter for epoch-based CRDT GC;
 *   - `nodes_fts_words` — second FTS5 index (unicode61) for hybrid
 *     retrieval; ALL node triggers maintain BOTH indexes in lock-step,
 *     each using the explicit 'delete' command form (DEMO001 §13
 *     pitfall #1 now applies twice per mutation);
 *   - `nodes_vec` — optional vector-lane side-table (float32 BLOB
 *     embeddings; sqlite-vec is the production swap-in, a local cosine
 *     scan serves the offline/CI path).
 *
 * Hierarchy: Graph (entity-level contextual firewall)
 *          → Cluster (topic-level dense grouping)
 *          → Node/Atom (immutable verbatim chunk + metadata).
 */
import type { Connection } from './connection.js';

export const SYNC_STATUS = ['SYNCED', 'DIRTY', 'CONFLICT'] as const;
export type SyncStatus = (typeof SYNC_STATUS)[number];

/** Column guard so applySchema stays idempotent over demo001-era files. */
function ensureColumn(conn: Connection, table: string, column: string, ddl: string): void {
  const cols = conn.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    conn.db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

export function applySchema(conn: Connection): void {
  const { db } = conn;

  db.exec(`
    CREATE TABLE IF NOT EXISTS graphs (
      id   INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS clusters (
      id       INTEGER PRIMARY KEY,
      graph_id INTEGER NOT NULL REFERENCES graphs(id),
      name     TEXT NOT NULL,
      -- JSON array of routing keywords for deterministic density scoring
      keywords TEXT NOT NULL DEFAULT '[]',
      UNIQUE (graph_id, name)
    );

    -- IDEA.v2 §5.1 — per-source-document identity & incremental ingest.
    CREATE TABLE IF NOT EXISTS documents (
      id             INTEGER PRIMARY KEY,
      graph_id       INTEGER NOT NULL REFERENCES graphs(id),
      source_key     TEXT NOT NULL,        -- repo-relative path | confluence page id
      content_hash   TEXT NOT NULL,        -- sha256 of normalized source text | git blob sha
      source_version TEXT,                 -- git blob sha | confluence version number
      atom_count     INTEGER NOT NULL DEFAULT 0,
      ingested_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      UNIQUE (graph_id, source_key)
    );

    -- Task 2.2.2 — immutable Nodes/Atoms with spatial + provenance metadata.
    -- Task 4.1.1 — _version / _last_modified / _sync_status sync columns.
    CREATE TABLE IF NOT EXISTS nodes (
      id             INTEGER PRIMARY KEY,
      graph_id       INTEGER NOT NULL REFERENCES graphs(id),
      cluster_id     INTEGER NOT NULL REFERENCES clusters(id),
      document_id    INTEGER REFERENCES documents(id),
      title          TEXT NOT NULL DEFAULT '',
      body           TEXT NOT NULL,           -- exact verbatim chunk, never paraphrased
      origin_file    TEXT,
      chunk_index    INTEGER NOT NULL DEFAULT 0,
      created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      crdt_blob      BLOB,                    -- one Yjs doc per Node/Atom
      epoch          INTEGER NOT NULL DEFAULT 0,  -- IDEA.v2 §5.3 epoch GC counter
      _version       INTEGER NOT NULL DEFAULT 1,
      _last_modified TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      _sync_status   TEXT NOT NULL DEFAULT 'DIRTY'
                     CHECK (_sync_status IN ('SYNCED','DIRTY','CONFLICT'))
    );
  `);

  // Upgrade path for demo001-era shard files (columns absent there).
  ensureColumn(conn, 'nodes', 'document_id', 'document_id INTEGER REFERENCES documents(id)');
  ensureColumn(conn, 'nodes', 'epoch', 'epoch INTEGER NOT NULL DEFAULT 0');

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_nodes_cluster  ON nodes(cluster_id);
    CREATE INDEX IF NOT EXISTS idx_nodes_graph    ON nodes(graph_id);
    CREATE INDEX IF NOT EXISTS idx_nodes_document ON nodes(document_id);
    CREATE INDEX IF NOT EXISTS idx_nodes_sync     ON nodes(_sync_status)
      WHERE _sync_status != 'SYNCED';

    -- Phase 4 — event-sourced outbox. Appended atomically with every
    -- mutation inside the same BEGIN IMMEDIATE transaction (dual-write
    -- problem solved at the transaction boundary, not by a queue daemon).
    CREATE TABLE IF NOT EXISTS outbox (
      id           INTEGER PRIMARY KEY,
      node_id      INTEGER NOT NULL REFERENCES nodes(id),
      event_type   TEXT NOT NULL,             -- 'node.created' | 'node.updated' | ...
      payload      BLOB,                      -- serialized CRDT differential update
      created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      _sync_status TEXT NOT NULL DEFAULT 'DIRTY'
                   CHECK (_sync_status IN ('SYNCED','DIRTY','CONFLICT'))
    );

    CREATE INDEX IF NOT EXISTS idx_outbox_dirty ON outbox(_sync_status)
      WHERE _sync_status != 'SYNCED';

    -- IDEA.v2 §5.2 — optional vector lane. Embeddings are float32 BLOBs
    -- keyed by node id; rows are removed by trigger when a node goes away
    -- so the lane can never serve a deleted atom.
    CREATE TABLE IF NOT EXISTS nodes_vec (
      node_id   INTEGER PRIMARY KEY REFERENCES nodes(id),
      embedding BLOB NOT NULL
    );

    -- DEMO003 Feature 1 — Edge Type: typed, weighted relationships between
    -- Nodes/Atoms. INTRA-GRAPH ONLY (graph_id pins both endpoints to the
    -- same Graph) so edges never cross the contextual firewall. The
    -- nodes AFTER DELETE trigger removes an atom's edges in lock-step, so a
    -- deleted Node can never leave a dangling edge (same hygiene as
    -- nodes_vec). UNIQUE(src,dst,type) makes addEdge idempotent.
    CREATE TABLE IF NOT EXISTS edges (
      id          INTEGER PRIMARY KEY,
      graph_id    INTEGER NOT NULL REFERENCES graphs(id),
      src_node_id INTEGER NOT NULL REFERENCES nodes(id),
      dst_node_id INTEGER NOT NULL REFERENCES nodes(id),
      edge_type   TEXT NOT NULL,
      weight      REAL NOT NULL DEFAULT 1.0,
      created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      UNIQUE (src_node_id, dst_node_id, edge_type)
    );
    CREATE INDEX IF NOT EXISTS idx_edges_src   ON edges(src_node_id, edge_type);
    CREATE INDEX IF NOT EXISTS idx_edges_dst   ON edges(dst_node_id, edge_type);
    CREATE INDEX IF NOT EXISTS idx_edges_graph ON edges(graph_id);

    -- DEMO003 Feature 2 — Supernode: one derived summary per Cluster. The
    -- summary/signature are SYNTHESIZED (extractive, deterministic), so they
    -- live OUTSIDE the nodes table and never enter the verbatim-Atom FTS
    -- corpus. signature is a JSON term→weight map; updated_at lets a stale
    -- check skip an unchanged rebuild.
    CREATE TABLE IF NOT EXISTS supernodes (
      id          INTEGER PRIMARY KEY,
      graph_id    INTEGER NOT NULL REFERENCES graphs(id),
      cluster_id  INTEGER NOT NULL UNIQUE REFERENCES clusters(id),
      title       TEXT NOT NULL DEFAULT '',
      summary     TEXT NOT NULL DEFAULT '',     -- extractive, verbatim slices
      signature   TEXT NOT NULL DEFAULT '{}',   -- JSON {term: weight}
      atom_count  INTEGER NOT NULL DEFAULT 0,
      updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_supernodes_graph ON supernodes(graph_id);
  `);

  // Phase 3 / Feature 3.1 — FTS5 external-content table over nodes.
  // trigram tokenizer (Task 3.2.1) gives substring / camelCase matching:
  // "Price" matches inside "calculateTotalPrice".
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
      title,
      body,
      content='nodes',
      content_rowid='id',
      tokenize='trigram'
    );
  `);

  // IDEA.v2 §5.1 — second FTS index for hybrid retrieval: word-level
  // unicode61 tokens (diacritics removed, '_'/'$' kept so identifiers
  // like snake_case and $vars stay single tokens). Same external-content
  // + trigger discipline as the trigram index. If the table is created
  // against a database that already holds nodes (demo001 upgrade), the
  // 'rebuild' command back-fills it from the content table.
  const hadWordsIndex =
    db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'nodes_fts_words'`)
      .get() != null;
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts_words USING fts5(
      title,
      body,
      content='nodes',
      content_rowid='id',
      tokenize='unicode61 remove_diacritics 2 tokenchars ''_$'''
    );
  `);
  if (!hadWordsIndex) {
    db.exec(`INSERT INTO nodes_fts_words(nodes_fts_words) VALUES ('rebuild')`);
  }

  // Triggers maintain BOTH FTS indexes in lock-step (IDEA.v2 §12: "Both
  // FTS tables in every trigger"). DROP+CREATE so demo001-era single-index
  // triggers are upgraded in place.
  db.exec(`
    DROP TRIGGER IF EXISTS nodes_ai;
    DROP TRIGGER IF EXISTS nodes_ad;
    DROP TRIGGER IF EXISTS nodes_au;

    -- Task 3.1.2 — keep the indexes in lock-step on insert.
    CREATE TRIGGER nodes_ai AFTER INSERT ON nodes BEGIN
      INSERT INTO nodes_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
      INSERT INTO nodes_fts_words(rowid, title, body) VALUES (new.id, new.title, new.body);
    END;

    -- Task 3.1.3 — the explicit 'delete' command syntax is mandatory for
    -- external-content tables; a plain DELETE would silently corrupt the
    -- index. Applies to BOTH tables, plus vector-lane hygiene.
    CREATE TRIGGER nodes_ad AFTER DELETE ON nodes BEGIN
      INSERT INTO nodes_fts(nodes_fts, rowid, title, body)
        VALUES ('delete', old.id, old.title, old.body);
      INSERT INTO nodes_fts_words(nodes_fts_words, rowid, title, body)
        VALUES ('delete', old.id, old.title, old.body);
      DELETE FROM nodes_vec WHERE node_id = old.id;
      -- DEMO003 Feature 1 — dangling-edge hygiene: a deleted Node drops
      -- every edge it participates in, either direction.
      DELETE FROM edges WHERE src_node_id = old.id OR dst_node_id = old.id;
    END;

    CREATE TRIGGER nodes_au AFTER UPDATE ON nodes BEGIN
      INSERT INTO nodes_fts(nodes_fts, rowid, title, body)
        VALUES ('delete', old.id, old.title, old.body);
      INSERT INTO nodes_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
      INSERT INTO nodes_fts_words(nodes_fts_words, rowid, title, body)
        VALUES ('delete', old.id, old.title, old.body);
      INSERT INTO nodes_fts_words(rowid, title, body) VALUES (new.id, new.title, new.body);
    END;
  `);
}
