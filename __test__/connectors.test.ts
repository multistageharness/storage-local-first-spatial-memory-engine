/**
 * IDEA.v2 §7 — connector layer: storage-format converter (code-macro
 * byte-verbatim, tables, links), token bucket honoring Retry-After,
 * cursor-after-commit crash idempotency, git delta path-set correctness
 * including renames and deletions.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { storageToText } from '../src/connectors/confluence-storage.js';
import { ConfluenceConnector } from '../src/connectors/confluence.js';
import { GitOrgConnector } from '../src/connectors/git-org.js';
import { runCrawl } from '../src/connectors/runner.js';
import { FederatedEngine } from '../src/federated-engine.js';
import { FixtureConfluenceServer, buildFixtureSite } from './fixtures/confluence-fixture-server.js';
import type { ShardDescriptor } from '../src/connectors/types.js';

// ---- storage-format converter (pure) --------------------------------------

test('storageToText: code-macro bodies survive byte-verbatim', () => {
  const body = `function f(a < b) {\n  return "x &&  y";   // two spaces kept\n}`;
  const storage =
    `<p>Intro prose.</p>` +
    `<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">ts</ac:parameter>` +
    `<ac:plain-text-body><![CDATA[${body}]]></ac:plain-text-body></ac:structured-macro>` +
    `<p>Outro prose.</p>`;
  const text = storageToText(storage);
  assert.ok(text.includes(body), 'code body must be byte-equal to the CDATA payload');
  assert.ok(text.includes('Intro prose.'));
  assert.ok(text.includes('Outro prose.'));
});

test('storageToText: tables become row-per-line, cells pipe-joined', () => {
  const text = storageToText(
    `<table><tr><th>Service</th><th>Owner</th></tr><tr><td>svc-a</td><td><b>team-1</b></td></tr></table>`,
  );
  assert.ok(text.includes('Service | Owner'));
  assert.ok(text.includes('svc-a | team-1'));
});

test('storageToText: links become "title (url)"; page links keep titles', () => {
  assert.ok(
    storageToText(`<p>See <a href="https://x.example/doc">the doc</a>.</p>`).includes('the doc (https://x.example/doc)'),
  );
  assert.ok(
    storageToText(`<p>See <ac:link><ri:page ri:content-title="Runbook 7"/></ac:link>.</p>`).includes('Runbook 7'),
  );
});

test('storageToText: entities decode, tags strip, whitespace collapses', () => {
  const text = storageToText(`<h1>A &amp; B</h1><p>x &lt; y &gt; z&nbsp;&quot;q&quot;</p>`);
  assert.ok(text.includes('A & B'));
  assert.ok(text.includes('x < y > z "q"'));
  assert.ok(!text.includes('<p>'));
});

// ---- confluence connector against the fixture server ----------------------

const dir = mkdtempSync(join(tmpdir(), 'sme-conn-'));
const server = new FixtureConfluenceServer(buildFixtureSite());
const baseUrl = await server.start();
const org = await FederatedEngine.open({ rootDir: join(dir, 'org') });

after(async () => {
  await org.close();
  await server.stop();
  rmSync(dir, { recursive: true, force: true });
});

function connector(): ConfluenceConnector {
  // high rate so unit tests stay fast; gates use the 8 req/s default
  return new ConfluenceConnector({ baseUrl, ratePerSec: 1000, batchSize: 10 });
}

test('confluence: discoverShards maps spaces → cf: shards with page-tree clusters', async () => {
  const shards: ShardDescriptor[] = [];
  for await (const s of connector().discoverShards()) shards.push(s);
  assert.deepEqual(shards.map((s) => s.shardKey).sort(), ['cf:ENG', 'cf:PROD', 'cf:SEC']);
  const eng = shards.find((s) => s.shardKey === 'cf:ENG')!;
  assert.ok(eng.clusters!.length >= 3, 'top-level pages became clusters');
  assert.ok(eng.clusters!.some((c) => c.name.includes('deployment')));
});

test('confluence: full crawl ingests, code macros retrievable verbatim, checkpoint durable', async () => {
  const c = connector();
  const eng: ShardDescriptor = { shardKey: 'cf:ENG', kind: 'space', displayName: 'Engineering' };
  const report = await runCrawl(org, c, eng, { mode: 'full' });
  assert.equal(report.mode, 'full');
  assert.equal(report.docs, 39, '3 roots + 36 children');
  assert.ok(report.atoms > 0);
  assert.ok(report.cursor, 'final cursor persisted');
  assert.equal(org.catalog.getCheckpoint('cf:ENG', 'confluence'), report.cursor);

  // exact-match pillar: a token that only exists inside a code macro
  const hits = await org.search('engHelper_1003', { shard: 'cf:ENG', strict: true });
  assert.ok(hits.hits.length > 0, 'code-macro content findable verbatim');
});

test('confluence: 429 storm absorbed via Retry-After (token bucket + retries)', async () => {
  const c = connector();
  const prod: ShardDescriptor = { shardKey: 'cf:PROD', kind: 'space', displayName: 'Product' };
  server.injectRateLimits(4); // consecutive 429s land on one request — stay within maxRetries
  const before429 = server.served429;
  const report = await runCrawl(org, c, prod, { mode: 'full' });
  assert.ok(report.docs > 0, 'crawl completed through the storm');
  assert.equal(server.served429 - before429, 4, 'all injected 429s were consumed');
  assert.equal(c.rateLimited, 4, 'connector saw and absorbed each 429');
});

test('confluence: a 429 storm deeper than maxRetries fails loudly, not silently', async () => {
  const c = new ConfluenceConnector({ baseUrl, ratePerSec: 1000, batchSize: 10, maxRetries: 2 });
  server.injectRateLimits(5);
  const prod: ShardDescriptor = { shardKey: 'cf:PROD', kind: 'space', displayName: 'Product' };
  await assert.rejects(() => runCrawl(org, c, prod, { mode: 'full' }), /429 storm/);
  server.clearFaults(); // leftovers must not poison later tests
});

test('confluence: delta crawl picks up edits, trashed sweep deletes', async () => {
  const c = connector();
  const eng: ShardDescriptor = { shardKey: 'cf:ENG', kind: 'space', displayName: 'Engineering' };
  // far-future timestamps: the full-crawl watermark is the real clock,
  // so delta-visible edits must sort after it
  server.editPage('ENG', '1101', `<p>Edited body with freshEditToken_77.</p>`, '2099-01-01T00:00:00.000Z');
  server.trashPage('ENG', '1102', '2099-01-01T00:00:01.000Z');

  const report = await runCrawl(org, c, eng, { mode: 'auto' });
  assert.equal(report.mode, 'delta', 'checkpoint existed → delta');
  assert.ok(report.docs >= 1);
  assert.equal(report.deletedDocs, 1);

  assert.ok((await org.search('freshEditToken_77', { shard: 'cf:ENG', strict: true })).hits.length > 0);
  const engEngine = await org.engine('cf:ENG');
  assert.equal(await engEngine.getDocument('1102'), null, 'trashed page document gone');
  org.releaseEngine('cf:ENG');
});

test('confluence: crash between batch commit and checkpoint replays one idempotent batch', async () => {
  const c = connector();
  const sec: ShardDescriptor = { shardKey: 'cf:SEC', kind: 'space', displayName: 'Security' };
  // crash after the first committed batch of the FULL crawl — no cursor
  // was written, so the resume re-runs the full crawl
  await assert.rejects(
    () => runCrawl(org, c, sec, { mode: 'full', crashAfterBatches: 1 }),
    /__crash-injection__/,
  );
  assert.equal(org.catalog.getCheckpoint('cf:SEC', 'confluence'), null, 'no checkpoint before commit');

  const resumed = await runCrawl(org, connector(), sec, { mode: 'auto' });
  assert.equal(resumed.mode, 'full');
  // the batch ingested before the crash re-crosses replaceDocument as
  // content_hash no-ops — idempotent, zero duplicates
  assert.equal(resumed.skippedDocs, 10, 'first batch (batchSize=10) skipped via hash');
  const secEngine = await org.engine('cf:SEC');
  const stats = await secEngine.stats();
  assert.equal(stats.documents, 39, 'no duplicate documents after replay');
  org.releaseEngine('cf:SEC');
});

// ---- git-org connector ------------------------------------------------------

const gitRoot = join(dir, 'repos');
mkdirSync(gitRoot, { recursive: true });

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
    },
  });
}

function makeRepo(name: string, files: Record<string, string>): string {
  const repoDir = join(gitRoot, name);
  mkdirSync(repoDir, { recursive: true });
  git(['init', '-q', '-b', 'main'], repoDir);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(repoDir, path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '.'), { recursive: true });
    writeFileSync(join(repoDir, path), content);
  }
  git(['add', '-A'], repoDir);
  git(['commit', '-q', '-m', 'init'], repoDir);
  return repoDir;
}

const repoA = makeRepo('alpha', {
  'src/main.ts': 'export function alphaMain() { return alphaToken_1; }\n',
  'src/util.ts': 'export const alphaUtil = 42; // alphaUtilToken\n',
  'docs/readme.md': '# Alpha\nDocs with alphaDocToken inside.\n',
});

test('git-org: full crawl — clusters from top-level dirs, blob shas as content hashes', async () => {
  const c = new GitOrgConnector({
    org: 'acme',
    repos: [{ name: 'alpha', cloneUrl: repoA }],
    cacheDir: join(dir, 'clones'),
  });
  const shard: ShardDescriptor = { shardKey: 'gh:acme/alpha', kind: 'repo', displayName: 'acme/alpha' };
  const report = await runCrawl(org, c, shard, { mode: 'full' });
  assert.equal(report.docs, 3);
  assert.equal(c.clonesPerformed, 1);

  const row = org.catalog.getShard('gh:acme/alpha')!;
  assert.deepEqual(row.clusters.map((cl) => cl.name).sort(), ['docs', 'src']);

  const engine = await org.engine('gh:acme/alpha');
  const doc = await engine.getDocument('src/main.ts');
  assert.ok(doc);
  assert.match(doc.contentHash, /^[0-9a-f]{40,64}$/, 'contentHash is the git blob sha');
  assert.equal(doc.sourceVersion, report.cursor, 'sourceVersion = HEAD sha');
  org.releaseEngine('gh:acme/alpha');

  assert.ok((await org.search('alphaDocToken', { shard: 'gh:acme/alpha', strict: true })).hits.length > 0);
});

test('git-org: delta crawl — modify/add/delete/rename produce exact path sets', async () => {
  // mutate the source repo: M src/main.ts, A src/new.ts, D docs/readme.md, R src/util.ts → src/util2.ts
  writeFileSync(join(repoA, 'src/main.ts'), 'export function alphaMain() { return alphaToken_2; }\n');
  writeFileSync(join(repoA, 'src/new.ts'), 'export const brandNew = true; // brandNewToken\n');
  git(['rm', '-q', 'docs/readme.md'], repoA);
  git(['mv', 'src/util.ts', 'src/util2.ts'], repoA);
  git(['add', '-A'], repoA);
  git(['commit', '-q', '-m', 'delta'], repoA);

  const c = new GitOrgConnector({
    org: 'acme',
    repos: [{ name: 'alpha', cloneUrl: repoA }],
    cacheDir: join(dir, 'clones'),
  });
  const shard: ShardDescriptor = { shardKey: 'gh:acme/alpha', kind: 'repo', displayName: 'acme/alpha' };
  const report = await runCrawl(org, c, shard, { mode: 'auto' });
  assert.equal(report.mode, 'delta');
  assert.equal(c.fetchesPerformed, 1, 'cache reused — fetch, not clone');
  assert.equal(report.docs, 3, 'M + A + renamed-new re-crossed replaceDocument');
  assert.equal(report.deletedDocs, 2, 'deleted + rename-old removed');

  const engine = await org.engine('gh:acme/alpha');
  assert.ok(await engine.getDocument('src/new.ts'));
  assert.ok(await engine.getDocument('src/util2.ts'));
  assert.equal(await engine.getDocument('src/util.ts'), null, 'rename-old gone');
  assert.equal(await engine.getDocument('docs/readme.md'), null, 'deleted path gone');
  org.releaseEngine('gh:acme/alpha');

  assert.ok((await org.search('alphaToken_2', { shard: 'gh:acme/alpha', strict: true })).hits.length > 0);
  assert.equal((await org.search('alphaToken_1', { shard: 'gh:acme/alpha', strict: true })).hits.length, 0, 'old content gone');
  assert.equal((await org.search('alphaDocToken', { shard: 'gh:acme/alpha', strict: true })).hits.length, 0);
});

test('git-org: no-change delta is a cursor-only no-op', async () => {
  const c = new GitOrgConnector({
    org: 'acme',
    repos: [{ name: 'alpha', cloneUrl: repoA }],
    cacheDir: join(dir, 'clones'),
  });
  const shard: ShardDescriptor = { shardKey: 'gh:acme/alpha', kind: 'repo', displayName: 'acme/alpha' };
  const report = await runCrawl(org, c, shard, { mode: 'auto' });
  assert.equal(report.docs, 0);
  assert.equal(report.deletedDocs, 0);
});
