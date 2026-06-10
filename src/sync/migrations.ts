/**
 * IDEA.v2 §5.4 — logical schema migration inside the CRDT blob
 * (IDEA.v1 "The Schema Migration Recommendation: Logical vs. Physical
 * Separation", adopted verbatim).
 *
 * The physical layer (SQLite columns) stays dumb; the logical schema is
 * versioned INSIDE each Y.Doc via a system map. Registered migrations
 * are pure, idempotent, COMMUTATIVE (YMap) => void transforms — two
 * entirely disconnected replicas applying the same migration offline
 * converge byte-identically after exchange, because identical structural
 * changes merge as aligned operations.
 *
 * Applied lazily: on load / before merge in the sync path; migrated
 * blobs flow back through saveAtomic so the change rides the outbox
 * like any edit (dual-write discipline, DEMO001 §6.3).
 */
import * as Y from 'yjs';

const SYSTEM_MAP = 'system';
const VERSION_KEY = 'schema_version';
const ATOM_MAP = 'atom';

export interface Migration {
  /** version this migration upgrades the doc TO (monotonic, unique) */
  to: number;
  description?: string;
  /** pure, idempotent, commutative transform over the atom map */
  migrate: (atom: Y.Map<unknown>, doc: Y.Doc) => void;
}

export class MigrationManager {
  private readonly migrations: Migration[];

  constructor(migrations: Migration[]) {
    this.migrations = [...migrations].sort((a, b) => a.to - b.to);
    const seen = new Set<number>();
    for (const m of this.migrations) {
      if (m.to <= 0) throw new Error(`migration target must be ≥ 1, got ${m.to}`);
      if (seen.has(m.to)) throw new Error(`duplicate migration target ${m.to}`);
      seen.add(m.to);
    }
  }

  get latestVersion(): number {
    return this.migrations.length > 0 ? this.migrations[this.migrations.length - 1].to : 0;
  }

  currentVersion(doc: Y.Doc): number {
    return (doc.getMap(SYSTEM_MAP).get(VERSION_KEY) as number | undefined) ?? 0;
  }

  needsMigration(doc: Y.Doc): boolean {
    return this.currentVersion(doc) < this.latestVersion;
  }

  /**
   * Apply every pending migration in ascending order, inside one Yjs
   * transaction. Returns true when the doc changed.
   */
  apply(doc: Y.Doc): boolean {
    const from = this.currentVersion(doc);
    const pending = this.migrations.filter((m) => m.to > from);
    if (pending.length === 0) return false;
    doc.transact(() => {
      const atom = doc.getMap(ATOM_MAP) as Y.Map<unknown>;
      const system = doc.getMap(SYSTEM_MAP);
      for (const m of pending) {
        m.migrate(atom, doc);
        system.set(VERSION_KEY, m.to);
      }
    });
    return true;
  }

  /**
   * Lazy-upgrade a stored blob. Returns the (possibly new) blob, the
   * differential update that carries the migration (for saveAtomic /
   * outbox), and whether anything changed.
   */
  migrateBlob(blob: Uint8Array): { blob: Uint8Array; update: Uint8Array | null; changed: boolean } {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, blob);
    const before = Y.encodeStateVector(doc);
    const changed = this.apply(doc);
    if (!changed) return { blob, update: null, changed: false };
    return {
      blob: Y.encodeStateAsUpdate(doc),
      update: Y.encodeStateAsUpdate(doc, before),
      changed: true,
    };
  }
}
