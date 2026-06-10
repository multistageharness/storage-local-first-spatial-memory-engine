/**
 * IDEA.v2 §7.2 — GitOrgConnector: repos → shards.
 *
 *   - discoverShards: org repo list (fixture-served array in CI, `gh
 *     api` behind --live) → one shard per repo ('gh:<org>/<repo>');
 *   - fullCrawl: shallow clone (--depth 1) into a content-addressed
 *     cache (reused across runs — fetch instead of re-clone), walk with
 *     include/exclude/maxBytes filters; contentHash = git blob sha
 *     (free via ls-tree), sourceVersion = HEAD sha; top-level
 *     directories → ClusterDef routing scopes;
 *   - deltaCrawl: `git fetch` + `git diff --raw -M <cursor>..<head>` —
 *     only changed/deleted/renamed paths re-cross replaceDocument /
 *     deleteDocument; cost ∝ change set, not corpus (what makes a
 *     2,000-repo nightly refresh feasible).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Connector, CrawlEvent, ShardDescriptor, SourceDocument } from './types.js';
import type { ClusterDef } from '../workers/protocol.js';

export interface GitRepoRef {
  name: string;
  cloneUrl: string;
  displayName?: string;
}

export interface GitOrgConnectorOptions {
  org: string;
  /** fixture-served list in CI; a live lister can be plugged in */
  repos: GitRepoRef[];
  /** clone cache root (content-addressed by repo name; reused across runs) */
  cacheDir: string;
  include?: RegExp;
  exclude?: RegExp;
  maxBytesPerFile?: number;
  batchSize?: number;
}

const DEFAULT_INCLUDE = /\.(js|jsx|ts|tsx|md|py|go|rs|java|rb|sql|sh|json|yml|yaml|txt)$/;
const DEFAULT_EXCLUDE = /(^|\/)(node_modules|\.git|dist|build|vendor)(\/|$)/;

export class GitOrgConnector implements Connector {
  readonly name = 'git-org';
  /** telemetry asserted by gates: cache reuse means fetches, not clones */
  clonesPerformed = 0;
  fetchesPerformed = 0;

  constructor(private readonly opts: GitOrgConnectorOptions) {}

  private git(args: string[], cwd?: string): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  }

  private repoDir(name: string): string {
    return join(this.opts.cacheDir, this.opts.org, name);
  }

  /** clone on first touch, fetch+reset on later runs (cache reuse) */
  private ensureClone(repo: GitRepoRef): string {
    const dir = this.repoDir(repo.name);
    if (existsSync(join(dir, '.git'))) {
      this.git(['fetch', '--depth', '1', 'origin', 'HEAD'], dir);
      this.git(['reset', '--hard', 'FETCH_HEAD'], dir);
      this.fetchesPerformed++;
    } else {
      mkdirSync(dir, { recursive: true });
      this.git(['clone', '--depth', '1', repo.cloneUrl, dir]);
      this.clonesPerformed++;
    }
    return dir;
  }

  private listFiles(dir: string, ref: string): { sha: string; path: string; bytes: number }[] {
    const include = this.opts.include ?? DEFAULT_INCLUDE;
    const exclude = this.opts.exclude ?? DEFAULT_EXCLUDE;
    const maxBytes = this.opts.maxBytesPerFile ?? 131072;
    const out = this.git(['ls-tree', '-r', '--long', ref], dir);
    const files: { sha: string; path: string; bytes: number }[] = [];
    for (const line of out.split('\n')) {
      if (!line) continue;
      // <mode> blob <sha> <size>\t<path>
      const m = line.match(/^\d+ blob ([0-9a-f]{40,64})\s+(\d+)\t(.+)$/);
      if (!m) continue;
      const [, sha, size, path] = m;
      const bytes = Number(size);
      if (!include.test(path) || exclude.test(path) || bytes === 0 || bytes > maxBytes) continue;
      files.push({ sha, path, bytes });
    }
    files.sort((a, b) => (a.path < b.path ? -1 : 1)); // deterministic walk
    return files;
  }

  private toDocument(dir: string, file: { sha: string; path: string }, head: string): SourceDocument {
    return {
      sourceKey: file.path,
      title: file.path,
      text: readFileSync(join(dir, file.path), 'utf8'), // verbatim — no normalization
      contentHash: file.sha, // git blob sha, free
      sourceVersion: head,
      originFile: file.path,
    };
  }

  private clustersFor(paths: string[]): ClusterDef[] {
    const dirs = new Set<string>();
    for (const p of paths) {
      const top = p.includes('/') ? p.slice(0, p.indexOf('/')) : 'root';
      dirs.add(top);
    }
    return [...dirs].sort().map((d) => ({ name: d, keywords: [d] }));
  }

  async *discoverShards(): AsyncIterable<ShardDescriptor> {
    for (const repo of this.opts.repos) {
      yield {
        shardKey: `gh:${this.opts.org}/${repo.name}`,
        kind: 'repo',
        displayName: repo.displayName ?? `${this.opts.org}/${repo.name}`,
      };
    }
  }

  private repoByShard(shard: ShardDescriptor): GitRepoRef {
    const name = shard.shardKey.replace(`gh:${this.opts.org}/`, '');
    const repo = this.opts.repos.find((r) => r.name === name);
    if (!repo) throw new Error(`git-org: unknown repo for ${shard.shardKey}`);
    return repo;
  }

  async *fullCrawl(shard: ShardDescriptor): AsyncIterable<CrawlEvent> {
    const repo = this.repoByShard(shard);
    const dir = this.ensureClone(repo);
    const head = this.git(['rev-parse', 'HEAD'], dir).trim();
    const files = this.listFiles(dir, 'HEAD');

    // top-level directories → routing scopes (DEMO001 §4.2 / codebase-rag)
    yield { clusters: this.clustersFor(files.map((f) => f.path)) };

    const batchSize = this.opts.batchSize ?? 50;
    for (let i = 0; i < files.length; i += batchSize) {
      yield { batch: files.slice(i, i + batchSize).map((f) => this.toDocument(dir, f, head)) };
    }
    yield { cursor: head };
  }

  async *deltaCrawl(shard: ShardDescriptor, cursor: string): AsyncIterable<CrawlEvent> {
    const repo = this.repoByShard(shard);
    const dir = this.ensureClone(repo); // fetch + reset to new HEAD
    const head = this.git(['rev-parse', 'HEAD'], dir).trim();
    if (head === cursor) {
      yield { cursor }; // nothing changed
      return;
    }

    // --raw -M: status + new blob sha per change; renames split into
    // delete(old) + add(new)
    const include = this.opts.include ?? DEFAULT_INCLUDE;
    const exclude = this.opts.exclude ?? DEFAULT_EXCLUDE;
    // --no-abbrev: full blob shas so delta-ingested contentHashes equal
    // a later full crawl's ls-tree shas (hash-skip stays exact)
    const raw = this.git(['diff', '--raw', '-M', '--no-abbrev', `${cursor}..${head}`], dir);
    const changed: { sha: string; path: string }[] = [];
    const deletes: string[] = [];
    for (const line of raw.split('\n')) {
      if (!line) continue;
      // :oldmode newmode oldsha newsha STATUS\tpath[\tnewpath]
      const m = line.match(/^:\d+ \d+ ([0-9a-f]+)\.* ([0-9a-f]+)\.*\s+([A-Z])(\d+)?\t([^\t]+)(?:\t(.+))?$/);
      if (!m) continue;
      const [, , newSha, status, , path, newPath] = m;
      const wanted = (p: string) => include.test(p) && !exclude.test(p);
      if (status === 'D') {
        if (wanted(path)) deletes.push(path);
      } else if (status === 'R') {
        if (wanted(path)) deletes.push(path);
        if (newPath && wanted(newPath)) changed.push({ sha: newSha, path: newPath });
      } else if (status === 'A' || status === 'M') {
        if (wanted(path)) changed.push({ sha: newSha, path });
      }
    }

    const batchSize = this.opts.batchSize ?? 50;
    for (let i = 0; i < changed.length; i += batchSize) {
      yield { batch: changed.slice(i, i + batchSize).map((f) => this.toDocument(dir, f, head)) };
    }
    if (deletes.length > 0) yield { deletes };
    yield { cursor: head };
  }
}
