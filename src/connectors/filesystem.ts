/**
 * IDEA.v2 §7.3 — FilesystemConnector: local directory trees → shards.
 *
 * The sibling of GitOrgConnector for content that lives on disk rather
 * than behind a git remote — a checked-out worktree, a docs folder, a
 * mounted share, or (see integration/codebase-fs.ts) a repo someone
 * else already cloned for us. The crawl semantics mirror codebase-rag.ts
 * (walk a tree, ingest each file verbatim, top-level dirs → routing
 * clusters) but wrapped in the connector contract so the runner's
 * checkpoint-after-commit discipline and the FederatedEngine's shard
 * fan-out apply unchanged.
 *
 *   - discoverShards: one shard per configured root ('fs:<name>');
 *     top-level directory names → ClusterDef routing scopes;
 *   - fullCrawl: deterministic recursive walk with include/exclude/
 *     maxBytes filters; contentHash = sha256 of the file text (there is
 *     no git blob sha to borrow); cursor = a quickcheck manifest;
 *   - deltaCrawl: re-walk, but skip re-hashing any file whose mtime AND
 *     size match the manifest (rsync-style quickcheck) — only changed
 *     files are read and re-ingested, vanished files emit deletes; cost
 *     ∝ change set + a stat() per file, not corpus bytes.
 *
 * The manifest IS the cursor, so it round-trips through the catalog's
 * checkpoint store exactly like any other connector's resume token — no
 * connector-side state, restart-safe by construction.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Connector, CrawlEvent, ShardDescriptor, SourceDocument } from './types.js';
import type { ClusterDef } from '../workers/protocol.js';

export interface FilesystemRootRef {
  /** shard-name segment; the shard key becomes 'fs:<name>' */
  name: string;
  /** root directory to crawl (absolute, or relative to process cwd) */
  path: string;
  displayName?: string;
}

export interface FilesystemConnectorOptions {
  roots: FilesystemRootRef[];
  include?: RegExp;
  exclude?: RegExp;
  maxBytesPerFile?: number;
  batchSize?: number;
}

/** per-file quickcheck entry: content hash + the stat() fields rsync trusts */
interface ManifestEntry {
  h: string;
  m: number;
  s: number;
}
type Manifest = Record<string, ManifestEntry>;

const DEFAULT_INCLUDE = /\.(js|jsx|ts|tsx|md|py|go|rs|java|rb|sql|sh|json|yml|yaml|txt)$/;
const DEFAULT_EXCLUDE = /(^|\/)(node_modules|\.git|dist|build|vendor)(\/|$)/;

interface WalkedFile {
  /** root-relative, forward-slash path — the stable sourceKey */
  path: string;
  bytes: number;
  mtimeMs: number;
}

export class FilesystemConnector implements Connector {
  readonly name = 'filesystem';
  /** telemetry asserted by gates: the quickcheck skips re-hashing unchanged files */
  filesWalked = 0;
  filesHashed = 0;

  constructor(private readonly opts: FilesystemConnectorOptions) {}

  private rootByShard(shard: ShardDescriptor): FilesystemRootRef {
    const name = shard.shardKey.replace(/^fs:/, '');
    const root = this.opts.roots.find((r) => r.name === name);
    if (!root) throw new Error(`filesystem: unknown root for ${shard.shardKey}`);
    return root;
  }

  /** deterministic recursive walk; filters mirror git-org's include/exclude/maxBytes */
  private walk(rootDir: string): WalkedFile[] {
    const include = this.opts.include ?? DEFAULT_INCLUDE;
    const exclude = this.opts.exclude ?? DEFAULT_EXCLUDE;
    const maxBytes = this.opts.maxBytesPerFile ?? 131072;
    const files: WalkedFile[] = [];
    for (const e of readdirSync(rootDir, { recursive: true, withFileTypes: true })) {
      if (!e.isFile()) continue;
      const abs = join(e.parentPath, e.name);
      const path = abs.slice(rootDir.length + 1).split('\\').join('/'); // root-relative, posix
      if (!include.test(path) || exclude.test(path)) continue;
      const st = statSync(abs);
      if (st.size === 0 || st.size > maxBytes) continue;
      files.push({ path, bytes: st.size, mtimeMs: st.mtimeMs });
    }
    files.sort((a, b) => (a.path < b.path ? -1 : 1)); // deterministic walk
    return files;
  }

  private toDocument(rootDir: string, file: WalkedFile, head: string): { doc: SourceDocument; entry: ManifestEntry } {
    const text = readFileSync(join(rootDir, file.path), 'utf8'); // verbatim — no normalization
    this.filesHashed++;
    const hash = createHash('sha256').update(text).digest('hex');
    return {
      doc: {
        sourceKey: file.path,
        title: file.path,
        text,
        contentHash: hash,
        sourceVersion: head,
        originFile: file.path,
      },
      entry: { h: hash, m: file.mtimeMs, s: file.bytes },
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
    for (const root of this.opts.roots) {
      const top = this.clustersFor(this.walk(root.path).map((f) => f.path));
      yield {
        shardKey: `fs:${root.name}`,
        kind: 'tree',
        displayName: root.displayName ?? root.name,
        clusters: top,
      };
    }
  }

  async *fullCrawl(shard: ShardDescriptor): AsyncIterable<CrawlEvent> {
    const root = this.rootByShard(shard);
    const files = this.walk(root.path);
    this.filesWalked += files.length;
    // newest mtime stands in for git's HEAD sha as a version stamp
    const head = String(Math.floor(this.newestMtime(files)));

    yield { clusters: this.clustersFor(files.map((f) => f.path)) };

    const manifest: Manifest = {};
    const batchSize = this.opts.batchSize ?? 50;
    for (let i = 0; i < files.length; i += batchSize) {
      const slice = files.slice(i, i + batchSize).map((f) => this.toDocument(root.path, f, head));
      for (const { doc, entry } of slice) manifest[doc.sourceKey] = entry;
      yield { batch: slice.map((s) => s.doc) };
    }
    // manifest IS the cursor — restart-safe, no connector-side state
    yield { cursor: JSON.stringify(manifest) };
  }

  async *deltaCrawl(shard: ShardDescriptor, cursor: string): AsyncIterable<CrawlEvent> {
    const root = this.rootByShard(shard);
    const prior = JSON.parse(cursor) as Manifest;
    const files = this.walk(root.path);
    this.filesWalked += files.length;
    const head = String(Math.floor(this.newestMtime(files)));

    const next: Manifest = {};
    const changed: SourceDocument[] = [];
    for (const f of files) {
      const was = prior[f.path];
      // rsync quickcheck: identical mtime AND size ⇒ assume unchanged, skip the read+hash
      if (was && was.m === f.mtimeMs && was.s === f.bytes) {
        next[f.path] = was;
        continue;
      }
      const { doc, entry } = this.toDocument(root.path, f, head);
      // content_hash may still match (touch without edit) — let the shard
      // kernel's replaceDocument no-op absorb it; we re-emit regardless so
      // the manifest's mtime is refreshed and future quickchecks stay cheap
      next[f.path] = entry;
      changed.push(doc);
    }
    const deletes = Object.keys(prior).filter((k) => !(k in next));

    const batchSize = this.opts.batchSize ?? 50;
    for (let i = 0; i < changed.length; i += batchSize) {
      yield { batch: changed.slice(i, i + batchSize) };
    }
    if (deletes.length > 0) yield { deletes };
    yield { cursor: JSON.stringify(next) };
  }

  /** newest file mtime in the tree → a monotonic-ish version stamp */
  private newestMtime(files: WalkedFile[]): number {
    let max = 0;
    for (const f of files) if (f.mtimeMs > max) max = f.mtimeMs;
    return max;
  }
}
