/**
 * IDEA.v2 §5.4 — MigrationManager: schema_version read/write, idempotent
 * re-application, commutative-offline-migration convergence (two
 * replicas migrate independently and merge byte-identically),
 * unmigrated-blob lazy upgrade on load.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Y from 'yjs';
import { MemoryEngine } from '../src/engine.js';
import { MigrationManager, type Migration } from '../src/sync/migrations.js';
import { createAtomBlob } from '../src/sync/crdt.js';

const MIGRATIONS: Migration[] = [
  {
    to: 1,
    description: 'add tags field',
    migrate: (atom) => {
      if (!atom.has('tags')) atom.set('tags', 'untagged');
    },
  },
  {
    to: 2,
    description: 'split originFile into originDir/originBase',
    migrate: (atom) => {
      const origin = (atom.get('originFile') as string | null) ?? '';
      const slash = origin.lastIndexOf('/');
      atom.set('originDir', slash >= 0 ? origin.slice(0, slash) : '');
      atom.set('originBase', slash >= 0 ? origin.slice(slash + 1) : origin);
    },
  },
];

test('manager: version bookkeeping + ordering validation', () => {
  const m = new MigrationManager(MIGRATIONS);
  assert.equal(m.latestVersion, 2);
  const doc = new Y.Doc();
  Y.applyUpdate(doc, createAtomBlob({ title: 't', body: 'b', originFile: 'src/x.ts' }));
  assert.equal(m.currentVersion(doc), 0);
  assert.equal(m.needsMigration(doc), true);

  assert.throws(() => new MigrationManager([{ to: 1, migrate: () => {} }, { to: 1, migrate: () => {} }]), /duplicate/);
  assert.throws(() => new MigrationManager([{ to: 0, migrate: () => {} }]), /≥ 1/);
});

test('apply: runs pending migrations in order, stamps schema_version', () => {
  const m = new MigrationManager(MIGRATIONS);
  const doc = new Y.Doc();
  Y.applyUpdate(doc, createAtomBlob({ title: 't', body: 'b', originFile: 'src/deep/x.ts' }));
  assert.equal(m.apply(doc), true);
  assert.equal(m.currentVersion(doc), 2);
  const atom = doc.getMap('atom');
  assert.equal(atom.get('tags'), 'untagged');
  assert.equal(atom.get('originDir'), 'src/deep');
  assert.equal(atom.get('originBase'), 'x.ts');
});

test('apply: idempotent — second application is a no-op', () => {
  const m = new MigrationManager(MIGRATIONS);
  const doc = new Y.Doc();
  Y.applyUpdate(doc, createAtomBlob({ title: 't', body: 'b', originFile: 'a/b.ts' }));
  assert.equal(m.apply(doc), true);
  const bytes = Y.encodeStateAsUpdate(doc);
  assert.equal(m.apply(doc), false, 'no pending migrations → untouched');
  assert.deepEqual([...Y.encodeStateAsUpdate(doc)], [...bytes]);
});

test('commutative offline convergence: two replicas migrate independently, merge byte-identically', () => {
  const m = new MigrationManager(MIGRATIONS);
  const base = createAtomBlob({ title: 'note', body: 'shared base', originFile: 'src/n.ts' });

  const a = new Y.Doc();
  const b = new Y.Doc();
  Y.applyUpdate(a, base);
  Y.applyUpdate(b, base);

  // both replicas apply the SAME migration logic while disconnected
  assert.equal(m.apply(a), true);
  assert.equal(m.apply(b), true);

  // exchange differentials both ways
  const updA = Y.encodeStateAsUpdate(a);
  const updB = Y.encodeStateAsUpdate(b);
  Y.applyUpdate(a, updB);
  Y.applyUpdate(b, updA);

  assert.deepEqual([...Y.encodeStateAsUpdate(a)], [...Y.encodeStateAsUpdate(b)], 'byte-identical after merge');
  assert.equal(m.currentVersion(a), 2);
  const atomA = a.getMap('atom');
  assert.equal(atomA.get('originBase'), 'n.ts', 'structural changes aligned, not duplicated');
});

test('migrateBlob: lazy upgrade of a legacy blob yields blob + outbox-able update', () => {
  const m = new MigrationManager(MIGRATIONS);
  const legacy = createAtomBlob({ title: 'old', body: 'pre-migration', originFile: 'x/y.ts' });
  const { blob, update, changed } = m.migrateBlob(legacy);
  assert.equal(changed, true);
  assert.ok(update, 'differential present for saveAtomic');

  // the differential alone upgrades another replica holding the legacy blob
  const other = new Y.Doc();
  Y.applyUpdate(other, legacy);
  Y.applyUpdate(other, update!);
  assert.equal(m.currentVersion(other), 2);
  assert.deepEqual([...Y.encodeStateAsUpdate(other)], [...blob]);

  // already-migrated blob short-circuits
  const again = m.migrateBlob(blob);
  assert.equal(again.changed, false);
});

// ---- engine integration: lazy upgrade through the CRDT adapter -------------

const dir = mkdtempSync(join(tmpdir(), 'sme-mig-'));
const engine = await MemoryEngine.open({ dbPath: join(dir, 'mig.db'), graph: 'mig', minReaders: 1 });

after(async () => {
  await engine.close();
  rmSync(dir, { recursive: true, force: true });
});

test('adapter.migrate: upgrades a stored atom and rides the outbox', async () => {
  const m = new MigrationManager(MIGRATIONS);
  const { nodeIds } = await engine.ingestDocument({
    title: 'legacy.md',
    text: 'A legacy atom that predates the logical schema.',
    originFile: 'docs/legacy.md',
  });
  const nodeId = nodeIds[0];

  const upgraded = await engine.crdt.migrate(nodeId, m);
  assert.equal(upgraded, true);

  const blob = (await engine.crdt.load(nodeId))!;
  const doc = new Y.Doc();
  Y.applyUpdate(doc, blob);
  assert.equal(m.currentVersion(doc), 2);
  assert.equal(doc.getMap('atom').get('originBase'), 'legacy.md');

  // second migrate is a no-op
  assert.equal(await engine.crdt.migrate(nodeId, m), false);

  // the migration flowed the outbox like any edit
  const stats = await engine.stats();
  assert.ok((stats.outboxDirty as number) > 0);
  await engine.syncNow();
});
