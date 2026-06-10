/**
 * Integration use case 3 — "offline-first replicas converge without
 * Last-Write-Wins".
 *
 * Two replicas (separate database files, e.g. a laptop and a desktop)
 * hold the same logical atom. They go "offline", make DIVERGENT edits —
 * replica A rewrites the body while replica B renames the title — then
 * exchange CRDT updates and run their background sync workers.
 *
 * Self-verifying: both replicas must converge to the IDENTICAL merged
 * state preserving BOTH concurrent edits (no destructive LWW), and end
 * SYNCED with empty outboxes.
 */
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryEngine } from '../src/engine.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DB_A = join(ROOT, '.data', 'integration-replica-a.db');
const DB_B = join(ROOT, '.data', 'integration-replica-b.db');

function freshDb(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  for (const f of [path, `${path}-wal`, `${path}-shm`]) if (existsSync(f)) rmSync(f);
}

interface NodeView {
  title: string;
  body: string;
  syncStatus: string;
}

async function main(): Promise<void> {
  console.log('\n=== integration: offline replicas, conflict-free convergence ===\n');
  freshDb(DB_A);
  freshDb(DB_B);

  const a = await MemoryEngine.open({ dbPath: DB_A, graph: 'shared', clusters: [] });
  const b = await MemoryEngine.open({ dbPath: DB_B, graph: 'shared', clusters: [] });

  // -- 1. both replicas ingest the same logical document ----------------------
  const seed = { title: 'config.ts', text: 'export const config = { mode: "base", retries: 3 };' };
  const [{ nodeIds: [idA] }, { nodeIds: [idB] }] = await Promise.all([
    a.ingestDocument(seed),
    b.ingestDocument(seed),
  ]);

  // -- 2. initial replication: exchange full CRDT states, merge to shared base
  const [blobA0, blobB0] = await Promise.all([a.crdt.load(idA), b.crdt.load(idB)]);
  await Promise.all([a.applyRemoteUpdate(idA, blobB0!), b.applyRemoteUpdate(idB, blobA0!)]);
  await Promise.all([a.syncNow(), b.syncNow()]);
  const baseA = (await a.getNode(idA)) as NodeView;
  const baseB = (await b.getNode(idB)) as NodeView;
  if (baseA.title !== baseB.title || baseA.body !== baseB.body) {
    throw new Error('replicas failed to converge on the shared base');
  }
  console.log(`[base] replicas share base state: "${baseA.title}" / ${baseA.body.length} chars ✓`);

  // -- 3. OFFLINE: divergent concurrent edits ---------------------------------
  await a.crdt.updateFields(idA, { body: 'export const config = { mode: "replicaA-edit", retries: 5 };' });
  await b.crdt.updateFields(idB, { title: 'config-renamed-by-B.ts' });
  console.log('[offline] A rewrote body; B renamed title — divergence created');

  // -- 4. back online: exchange updates, sync workers merge -------------------
  const [blobA1, blobB1] = await Promise.all([a.crdt.load(idA), b.crdt.load(idB)]);
  await Promise.all([a.applyRemoteUpdate(idA, blobB1!), b.applyRemoteUpdate(idB, blobA1!)]);

  const nodeBeforeSync = (await a.getNode(idA)) as NodeView;
  console.log(`[online] remote update queued — replica A node status: ${nodeBeforeSync.syncStatus}`);

  await Promise.all([a.syncNow(), b.syncNow()]);

  // -- 5. verify mathematical convergence -------------------------------------
  const finalA = (await a.getNode(idA)) as NodeView;
  const finalB = (await b.getNode(idB)) as NodeView;
  console.log(`[merge] A → title="${finalA.title}", body="${finalA.body}"`);
  console.log(`[merge] B → title="${finalB.title}", body="${finalB.body}"`);

  if (finalA.title !== finalB.title || finalA.body !== finalB.body) {
    throw new Error('CONVERGENCE FAILURE: replicas disagree after merge');
  }
  if (finalA.title !== 'config-renamed-by-B.ts') {
    throw new Error(`B's concurrent title edit was destroyed (LWW behavior): "${finalA.title}"`);
  }
  if (!finalA.body.includes('replicaA-edit')) {
    throw new Error(`A's concurrent body edit was destroyed (LWW behavior): "${finalA.body}"`);
  }
  if (finalA.syncStatus !== 'SYNCED' || finalB.syncStatus !== 'SYNCED') {
    throw new Error(`expected SYNCED/SYNCED, got ${finalA.syncStatus}/${finalB.syncStatus}`);
  }
  const [sa, sb] = await Promise.all([a.stats(), b.stats()]);
  if ((sa.outboxDirty as number) !== 0 || (sb.outboxDirty as number) !== 0) {
    throw new Error('outboxes not drained');
  }

  await Promise.all([a.close(), b.close()]);
  console.log('\nPASS: divergent offline edits merged conflict-free — both survive, replicas identical.\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
