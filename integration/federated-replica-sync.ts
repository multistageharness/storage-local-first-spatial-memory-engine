/**
 * federated-replica-sync (IDEA.v2 §9.2) — tiered partial replication:
 *
 *   replica A subscribes to shard X only; replica B to X + Y.
 *   1. both replicate a shared base in X;
 *   2. OFFLINE divergent edits in X (A rewrites body, B renames title);
 *   3. blob exchange through the subscription-gated boundary + sync;
 *      → byte-identical convergence, BOTH edits survive (anti-LWW);
 *   4. B's Y edits never reach A (unsubscribed-shard updates rejected);
 *   5. epoch-GC interplay: B compacts X's atom, then A's pre-compaction
 *      edit arrives → CONFLICT (application review), never corruption;
 *      B's compacted snapshot reaches A → adopted as the new baseline.
 *
 * Usage: node dist/integration/federated-replica-sync.js [--root path]
 */
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { FederatedEngine } from '../src/federated-engine.js';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const ROOT = arg('root', join(process.cwd(), '.data', 'fed-replica'));

const failures: string[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
}

interface NodeView {
  title: string;
  body: string;
  epoch: number;
  syncStatus: string;
}

async function main(): Promise<void> {
  console.log(`\n=== federated-replica-sync — partial replication + epoch GC interplay ===\n`);
  rmSync(ROOT, { recursive: true, force: true });

  const A = await FederatedEngine.open({ rootDir: join(ROOT, 'replica-a') });
  const B = await FederatedEngine.open({ rootDir: join(ROOT, 'replica-b') });
  A.subscribe(['syn:x']);
  B.subscribe(['syn:x', 'syn:y']);

  for (const org of [A, B]) {
    await org.ensureShard({ shardKey: 'syn:x', kind: 'synthetic', displayName: 'shard X' });
  }
  await B.ensureShard({ shardKey: 'syn:y', kind: 'synthetic', displayName: 'shard Y' });

  // ---- 1. shared base in X ---------------------------------------------------
  const seed = { sourceKey: 'shared/config.ts', title: 'config.ts', text: 'export const config = { mode: "base" };' };
  const engA = await A.engine('syn:x');
  const engB = await B.engine('syn:x');
  const [resA, resB] = await Promise.all([engA.replaceDocument(seed), engB.replaceDocument(seed)]);
  const idA = resA.nodeIds[0];
  const idB = resB.nodeIds[0];
  // initial replication: exchange full states → shared CRDT base
  await B.applyRemoteShardUpdate('syn:x', idB, (await engA.crdt.load(idA))!);
  await A.applyRemoteShardUpdate('syn:x', idA, (await engB.crdt.load(idB))!);
  await Promise.all([engA.syncNow(), engB.syncNow()]);
  check('shared base replicated', ((await engA.getNode(idA)) as NodeView).body === ((await engB.getNode(idB)) as NodeView).body);

  // ---- 2. offline divergence --------------------------------------------------
  await engA.crdt.updateFields(idA, { body: 'export const config = { mode: "edited-by-A" };' });
  await engB.crdt.updateFields(idB, { title: 'config-renamed-by-B.ts' });

  // ---- 3. exchange via the subscription-gated boundary --------------------------
  const exA = await B.applyRemoteShardUpdate('syn:x', idB, (await engA.crdt.load(idA))!);
  const exB = await A.applyRemoteShardUpdate('syn:x', idA, (await engB.crdt.load(idB))!);
  check('subscribed exchange accepted both ways', exA.applied && exB.applied);
  await Promise.all([engA.syncNow(), engB.syncNow()]);

  const finalA = (await engA.getNode(idA)) as NodeView;
  const finalB = (await engB.getNode(idB)) as NodeView;
  check('byte-identical convergence in X', finalA.title === finalB.title && finalA.body === finalB.body);
  check('anti-LWW: A’s body edit survives', finalA.body.includes('edited-by-A'));
  check('anti-LWW: B’s title edit survives', finalA.title === 'config-renamed-by-B.ts');
  const blobsEqual =
    Buffer.compare(Buffer.from((await engA.crdt.load(idA))!), Buffer.from((await engB.crdt.load(idB))!)) === 0;
  check('CRDT blobs byte-identical', blobsEqual);

  // ---- 4. partial replication: Y stays local to B -------------------------------
  const engY = await B.engine('syn:y');
  const yRes = await engY.replaceDocument({
    sourceKey: 'y/secret.ts',
    title: 'secret.ts',
    text: 'const yOnlyToken_55 = true;',
  });
  const yBlob = (await engY.crdt.load(yRes.nodeIds[0]))!;
  const rejected = await A.applyRemoteShardUpdate('syn:y', yRes.nodeIds[0], yBlob);
  check('unsubscribed-shard update rejected at A', !rejected.applied && rejected.reason === 'unsubscribed');
  check('Y content never visible at A', (await A.search('yOnlyToken_55', { strict: true })).hits.length === 0);
  check('Y content present at B', (await B.search('yOnlyToken_55', { shard: 'syn:y', strict: true })).hits.length > 0);

  // ---- 5. epoch-GC interplay ------------------------------------------------------
  // A makes a pre-compaction edit and holds it (offline)…
  await engA.crdt.updateFields(idA, { body: 'pre-compaction edit from A' });
  const preCompactionBlob = (await engA.crdt.load(idA))!;
  const preCompactionEpoch = ((await engA.getNode(idA)) as NodeView).epoch;
  // …while B compacts the atom (epoch bumps past A's)
  const gc = await engB.compactAtom(idB);
  check('B compacted X’s atom', gc.bytesAfter < gc.bytesBefore && gc.epoch === preCompactionEpoch + 1);

  // A's stale-epoch edit arrives at B → CONFLICT, not corruption/merge
  const stale = await B.applyRemoteShardUpdate('syn:x', idB, preCompactionBlob, preCompactionEpoch);
  check('stale-epoch edit lands as CONFLICT', stale.outcome === 'stale');
  const bAfterStale = (await engB.getNode(idB)) as NodeView;
  check('B flagged for review, content intact', bAfterStale.syncStatus === 'CONFLICT' && !bAfterStale.body.includes('pre-compaction'));
  await engB.syncNow();
  check(
    'stale payload never silently merges',
    !((await engB.getNode(idB)) as NodeView).body.includes('pre-compaction'),
  );

  // B's compacted snapshot reaches A → adopted as the new baseline
  const adopted = await A.applyRemoteShardUpdate('syn:x', idA, (await engB.crdt.load(idB))!, gc.epoch);
  check('A adopts the compacted baseline', adopted.outcome === 'adopted');
  const aAfterAdopt = (await engA.getNode(idA)) as NodeView;
  check('A’s epoch advanced to the snapshot epoch', aAfterAdopt.epoch === gc.epoch);
  const convergedPostGc =
    Buffer.compare(Buffer.from((await engA.crdt.load(idA))!), Buffer.from((await engB.crdt.load(idB))!)) === 0;
  check('post-GC replicas byte-identical', convergedPostGc);

  A.releaseEngine('syn:x');
  B.releaseEngine('syn:x');
  B.releaseEngine('syn:y');
  await Promise.all([A.close(), B.close()]);

  if (failures.length > 0) {
    console.error(`\nFAIL: federated-replica-sync — ${failures.length} check(s) failed.`);
    process.exit(1);
  }
  console.log(`\nPASS: partial replication scoped, anti-LWW held, epoch GC degraded gracefully.\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
