/**
 * Phase 4 — the custom persistence boundary (CRDTStorageAdapter).
 *
 * The REQ interface sketches synchronous load()/saveAtomic(); here they
 * are Promise-returning because the main thread never touches
 * better-sqlite3 — calls dispatch through the broker to the singleton
 * writer, where the actual BEGIN IMMEDIATE dual-write (node row + CRDT
 * blob + outbox event, atomically) executes synchronously.
 */
import type { WorkerBroker } from '../workers/broker.js';
import { diffUpdate } from './crdt.js';
import type { AtomFields } from './crdt.js';
import type { MigrationManager } from './migrations.js';

export interface NodeMetadata {
  title?: string;
  originFile?: string;
}

export class CRDTStorageAdapter {
  constructor(private readonly broker: WorkerBroker) {}

  /** Raw binary Yjs state for a specific Node/Atom. */
  async load(nodeId: number): Promise<Uint8Array | null> {
    const { blob } = await this.broker.read<{ blob: Uint8Array | null }>('loadCrdt', { nodeId });
    return blob;
  }

  /**
   * Atomically upsert the CRDT payload AND flag the outbox DIRTY.
   * Executes via SQLite BEGIN IMMEDIATE inside the writer thread.
   */
  async saveAtomic(nodeId: number, crdtUpdate: Uint8Array, metadata: NodeMetadata = {}): Promise<{ version: number }> {
    return this.broker.write<{ version: number }>('saveAtomic', { nodeId, crdtUpdate, metadata });
  }

  /**
   * Convenience: optimistic local update — load current state, compute the
   * differential for `fields`, and commit it atomically.
   */
  async updateFields(nodeId: number, fields: Partial<AtomFields>): Promise<{ version: number }> {
    const base = await this.load(nodeId);
    const update = diffUpdate(base, fields);
    return this.saveAtomic(nodeId, update, { title: fields.title ?? undefined });
  }

  /**
   * IDEA.v2 §5.4 — lazy logical-schema upgrade: load the blob, run any
   * pending migrations, and write the differential back through
   * saveAtomic so the migration rides the outbox like any edit.
   * Returns true when the atom was upgraded.
   */
  async migrate(nodeId: number, manager: MigrationManager): Promise<boolean> {
    const base = await this.load(nodeId);
    if (!base) return false;
    const { update, changed } = manager.migrateBlob(base);
    if (!changed || !update) return false;
    await this.saveAtomic(nodeId, update);
    return true;
  }
}
