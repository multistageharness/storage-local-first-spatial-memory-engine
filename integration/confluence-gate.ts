/**
 * confluence-gate (IDEA.v2 §9.2) — FixtureConfluenceServer (3 spaces,
 * ~120 pages with code macros, tables, links; fault injection):
 * discover → full crawl through a 429 storm → mid-crawl crash + resume →
 * delta crawl with live edits and trashed pages.
 *
 * Proves: crawl completes through faults, checkpoints resume exactly,
 * code-macro content retrievable verbatim, deletions unfindable,
 * unchanged content hash-skips on re-crawl.
 *
 * Usage: node dist/integration/confluence-gate.js [--root path] [--report path]
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { FederatedEngine } from '../src/federated-engine.js';
import { ConfluenceConnector } from '../src/connectors/confluence.js';
import { runCrawl, runOrgCrawl } from '../src/connectors/runner.js';
import {
  FixtureConfluenceServer,
  buildFixtureSite,
} from '../__test__/fixtures/confluence-fixture-server.js';
import type { ShardDescriptor } from '../src/connectors/types.js';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const ROOT = arg('root', join(process.cwd(), '.data', 'confluence-gate'));
const REPORT = arg('report', join(process.cwd(), 'reports', 'confluence-gate-report.json'));

const failures: string[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(`${name}${detail ? ` (${detail})` : ''}`);
}

async function main(): Promise<void> {
  console.log(`\n=== confluence-gate — fixture site crawl with fault injection ===\n`);
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });

  const site = buildFixtureSite();
  const totalPages = site.reduce((a, s) => a + s.pages.length, 0);
  const server = new FixtureConfluenceServer(site);
  const baseUrl = await server.start();
  const org = await FederatedEngine.open({ rootDir: ROOT, maxConcurrentShardIngests: 3 });
  const connector = new ConfluenceConnector({ baseUrl, ratePerSec: 200, batchSize: 25 });

  // ---- full org crawl through a 429 storm ---------------------------------
  server.injectRateLimits(3);
  const reports = await runOrgCrawl(org, connector, { mode: 'full' });
  const docs = reports.reduce((a, r) => a + r.docs, 0);
  check('discovery → one shard per space', reports.length === 3, `${reports.length}/3`);
  check('full crawl ingested every page', docs === totalPages, `${docs}/${totalPages} docs`);
  check('429 storm absorbed', connector.rateLimited === 3, `${connector.rateLimited} absorbed`);
  for (const key of ['cf:ENG', 'cf:PROD', 'cf:SEC']) {
    check(`checkpoint durable for ${key}`, org.catalog.getCheckpoint(key, 'confluence') != null);
  }

  // exact-match pillar: code-macro-only tokens, one per space
  for (const [shard, token] of [
    ['cf:ENG', 'engHelper_1102'],
    ['cf:SEC', 'secToken_3105'],
  ] as const) {
    const hits = await org.search(token, { shard, strict: true });
    check(`code macro verbatim in ${shard}`, hits.hits.length > 0, token);
  }
  // table + link content survives conversion
  const tableHit = await org.search('svc-1103', { shard: 'cf:ENG', strict: true });
  check('table cells indexed', tableHit.hits.length > 0);

  // ---- mid-crawl crash + exact resume --------------------------------------
  // force a re-crawl of ENG that crashes after one batch, then resume:
  // the replay must be pure hash-skips (idempotent), no duplicates
  const engDesc: ShardDescriptor = { shardKey: 'cf:ENG', kind: 'space', displayName: 'Engineering' };
  let crashed = false;
  try {
    await runCrawl(org, connector, engDesc, { mode: 'full', crashAfterBatches: 1 });
  } catch {
    crashed = true;
  }
  check('crash injection fired', crashed);
  const resumed = await runCrawl(org, connector, engDesc, { mode: 'full' });
  check('crash replay is idempotent', resumed.skippedDocs === resumed.docs, `${resumed.skippedDocs}/${resumed.docs} skipped`);
  const engStats = await org.withEngine('cf:ENG', (e) => e.stats());
  check('no duplicate documents after replay', engStats.documents === 39, `${engStats.documents}/39`);

  // ---- delta crawl: edits + additions + trashed sweep ------------------------
  const ts = '2099-01-01T00:00:00.000Z';
  server.editPage('ENG', '1101', `<p>Hotfix notes with deltaEditToken_42.</p>`, ts);
  server.addPage('ENG', {
    id: '1999',
    title: 'Brand new page',
    parentId: '1r0',
    body: `<p>Fresh content deltaNewToken_43.</p>`,
    version: 1,
    lastModified: ts,
  });
  server.trashPage('ENG', '1104', ts);

  const delta = await runCrawl(org, connector, engDesc, { mode: 'auto' });
  check('delta mode selected from checkpoint', delta.mode === 'delta');
  check('delta touched only the change set', delta.docs <= 3, `${delta.docs} docs re-crossed`);
  check('trashed page deleted', delta.deletedDocs === 1);
  check(
    'edited content findable',
    (await org.search('deltaEditToken_42', { shard: 'cf:ENG', strict: true })).hits.length > 0,
  );
  check(
    'new page findable',
    (await org.search('deltaNewToken_43', { shard: 'cf:ENG', strict: true })).hits.length > 0,
  );
  check(
    'trashed content unfindable',
    (await org.search('engHelper_1104', { shard: 'cf:ENG', strict: true })).hits.length === 0,
  );

  // dual-FTS lock-step after the full churn
  const finalStats = await org.withEngine('cf:ENG', (e) => e.stats());
  check(
    'both FTS indexes in lock-step',
    finalStats.ftsRows === finalStats.nodes && finalStats.ftsWordRows === finalStats.nodes,
  );

  mkdirSync(dirname(REPORT), { recursive: true });
  writeFileSync(
    REPORT,
    JSON.stringify(
      { totalPages, fullCrawlDocs: docs, rateLimited: connector.rateLimited, requests: connector.requests, deltaDocs: delta.docs, failures },
      null,
      2,
    ),
  );
  await org.close();
  await server.stop();

  if (failures.length > 0) {
    console.error(`\nFAIL: confluence-gate — ${failures.length} check(s) failed.`);
    process.exit(1);
  }
  console.log(`\nPASS: Confluence connector survives faults, resumes exactly, preserves code verbatim.\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
