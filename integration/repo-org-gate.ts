/**
 * repo-org-gate (IDEA.v2 §9.2) — fixture org of 12 small git repos
 * served as local remotes: discover → clone fan-out → ingest → synthetic
 * commits → delta round → cache-reuse verification.
 *
 * Proves: all repos land as shards, delta touches only changed paths,
 * cached clones are reused (fetch, not clone) on later runs, and the
 * federated layer routes repo queries correctly.
 *
 * Usage: node dist/integration/repo-org-gate.js [--root path] [--report path]
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { FederatedEngine } from '../dist/src/federated-engine.js';
import { GitOrgConnector } from '../dist/src/connectors/git-org.js';
import { runOrgCrawl } from '../dist/src/connectors/runner.js';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const ROOT = arg('root', join(process.cwd(), '.data', 'repo-org-gate'));
const REPORT = arg('report', join(process.cwd(), 'reports', 'repo-org-gate-report.json'));
const REPOS = 12;

const failures: string[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(`${name}${detail ? ` (${detail})` : ''}`);
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.com',
      GIT_COMMITTER_NAME: 'fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.com',
      GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
      GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
    },
  });
}

const SERVICES = ['payments', 'identity', 'search', 'mailer', 'gateway', 'ledger', 'webapp', 'mobile-api', 'etl', 'metrics', 'docs-site', 'cli'];

function makeFixtureOrg(orgDir: string): { name: string; cloneUrl: string }[] {
  return SERVICES.map((name, r) => {
    const repoDir = join(orgDir, name);
    mkdirSync(join(repoDir, 'src'), { recursive: true });
    mkdirSync(join(repoDir, 'docs'), { recursive: true });
    for (let f = 0; f < 6; f++) {
      writeFileSync(
        join(repoDir, 'src', `module${f}.ts`),
        [
          `// ${name} module ${f}`,
          `export function ${name.replace(/-/g, '_')}Handler${f}(req: Request): Response {`,
          `  const marker = 'repoNeedle_${name}_${r}x${f}';`,
          `  return process(req, marker);`,
          `}`,
        ].join('\n') + '\n',
      );
    }
    writeFileSync(join(repoDir, 'docs', 'README.md'), `# ${name}\nService ${name} overview, repo ${r}.\n`);
    git(['init', '-q', '-b', 'main'], repoDir);
    git(['add', '-A'], repoDir);
    git(['commit', '-q', '-m', 'init'], repoDir);
    return { name, cloneUrl: repoDir };
  });
}

async function main(): Promise<void> {
  console.log(`\n=== repo-org-gate — ${REPOS} fixture repos, clone fan-out + delta ===\n`);
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });

  const repos = makeFixtureOrg(join(ROOT, 'remotes'));
  const org = await FederatedEngine.open({ rootDir: join(ROOT, 'org'), maxConcurrentShardIngests: 6 });
  const connector = new GitOrgConnector({ org: 'acme', repos, cacheDir: join(ROOT, 'clones') });

  // ---- full crawl: clone fan-out -------------------------------------------
  const full = await runOrgCrawl(org, connector, { mode: 'full' });
  check('all repos landed as shards', full.length === REPOS, `${full.length}/${REPOS}`);
  check('clone per repo on first run', connector.clonesPerformed === REPOS, `${connector.clonesPerformed} clones`);
  const fullDocs = full.reduce((a, r) => a + r.docs, 0);
  check('every file ingested', fullDocs === REPOS * 7, `${fullDocs}/${REPOS * 7} docs`);
  const shards = org.catalog.listShards();
  check(
    'clusters = top-level directories',
    shards.every((s) => s.clusters.some((c) => c.name === 'src') && s.clusters.some((c) => c.name === 'docs')),
  );

  // federated routing across the repo org (no hint)
  const fed = await org.search('repoNeedle_ledger_5x3', { strict: true });
  check('federated query routes to the right repo', fed.hits.some((h) => h.shardKey === 'gh:acme/ledger'));

  // ---- synthetic commits in 3 repos → delta ----------------------------------
  for (const [i, name] of (['payments', 'search', 'cli'] as const).entries()) {
    const repoDir = join(ROOT, 'remotes', name);
    writeFileSync(
      join(repoDir, 'src', 'module0.ts'),
      `// ${name} touched\nexport const changedMarker_${name} = ${i};\n`,
    );
    writeFileSync(join(repoDir, 'src', 'added.ts'), `export const addedMarker_${name} = true;\n`);
    git(['rm', '-q', 'docs/README.md'], repoDir);
    git(['add', '-A'], repoDir);
    git(['commit', '-q', '-m', 'delta'], repoDir);
  }

  connector.clonesPerformed = 0;
  connector.fetchesPerformed = 0;
  const delta = await runOrgCrawl(org, connector, { mode: 'auto' });
  check('delta mode everywhere', delta.every((r) => r.mode === 'delta'));
  check('cache reused — zero re-clones', connector.clonesPerformed === 0, `${connector.fetchesPerformed} fetches`);
  const deltaDocs = delta.reduce((a, r) => a + r.docs, 0);
  const deltaDeletes = delta.reduce((a, r) => a + r.deletedDocs, 0);
  check('delta touched only changed paths', deltaDocs === 6, `${deltaDocs} docs (2 × 3 repos)`);
  check('deletions propagated', deltaDeletes === 3, `${deltaDeletes}/3`);
  check(
    'changed content findable',
    (await org.search('changedMarker_payments', { shard: 'gh:acme/payments', strict: true })).hits.length > 0,
  );
  check(
    'old content gone',
    (await org.search('repoNeedle_payments_0x0', { shard: 'gh:acme/payments', strict: true })).hits.length === 0,
  );
  check(
    'untouched repos skipped whole',
    delta.filter((r) => r.docs === 0 && r.deletedDocs === 0).length === REPOS - 3,
  );

  const totals = await org.stats();
  mkdirSync(dirname(REPORT), { recursive: true });
  writeFileSync(
    REPORT,
    JSON.stringify(
      { repos: REPOS, fullDocs, deltaDocs, deltaDeletes, clones: REPOS, fetches: connector.fetchesPerformed, totalAtoms: totals.totalAtoms, failures },
      null,
      2,
    ),
  );
  await org.close();

  if (failures.length > 0) {
    console.error(`\nFAIL: repo-org-gate — ${failures.length} check(s) failed.`);
    process.exit(1);
  }
  console.log(`\nPASS: ${REPOS}-repo org crawls, deltas ∝ change set, clones cached.\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
