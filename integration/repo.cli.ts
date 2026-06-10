/**
 * repo.cli.ts — interactive front-end for the integration/repo.ts flow.
 *
 * The non-interactive repo.ts hard-codes mui/material-ui + a fixed sparse
 * subtree, rebuilds the DB every run, and asserts a canned lookup list.
 * This wraps the same machinery (sparse/shallow clone → verbatim ingest →
 * BM25 search over a MemoryEngine) behind a @clack/prompts session so a
 * user can:
 *
 *   1. point it at ANY git repo + sparse subtree (or accept the defaults);
 *   2. reuse a previously-built DB instead of re-cloning + re-ingesting
 *      (the DB path is keyed by repo+subtree, so each target gets its own);
 *   3. run free-form searches in a REPL until they quit.
 *
 * Defaults are read from .env (REPO_URL, SPARSE_PATH, GRAPH, FILTER, IGNORE)
 * via dotenv, so `cp .env.example .env` lets you change targets without flags.
 * FILTER/IGNORE are optional include/exclude regexes (empty = ingest the whole
 * subtree); each distinct filter set gets its own DB.
 *
 * Build + run:  npm run cli:repo   (npm run build && tsx integration/repo.cli.ts)
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { dirname, join, relative, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as p from '@clack/prompts';
import chalk from 'chalk';
import dotenv from 'dotenv';
import { MemoryEngine, sha256Hex } from '../dist/src/engine.js';
import type { SearchHit, HybridSearchHit } from '../dist/src/workers/protocol.js';

dotenv.config({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '.env'), quiet: true });

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..'); // integration/ → project root (run as source via tsx)
const REPO_DIR = join(ROOT, 'integration', 'repo'); // shared cache with repo.ts
const MAX_FILE_BYTES = 256 * 1024; // skip generated monsters

// Same topical clusters repo.ts routes into — keyword density decides each atom's home.
const CLUSTERS = [
  { name: 'styling', keywords: ['theme', 'palette', 'styled', 'typography', 'breakpoint', 'css'] },
  { name: 'components', keywords: ['forwardRef', 'className', 'ownerState', 'slotProps', 'render'] },
  { name: 'hooks', keywords: ['useState', 'useEffect', 'useCallback', 'useRef', 'useMemo'] },
  { name: 'a11y', keywords: ['aria-', 'role=', 'keyboard', 'focusVisible', 'tabIndex'] },
];

const DEFAULTS = {
  repoUrl: process.env.REPO_URL ?? 'https://github.com/mui/material-ui.git',
  sparsePath: process.env.SPARSE_PATH ?? 'packages/mui-material/src',
  graph: process.env.GRAPH ?? 'material-ui',
  filter: process.env.FILTER ?? '', // include regex — empty = keep all source files
  ignore: process.env.IGNORE ?? '', // exclude regex — empty = ignore nothing
};

interface Target {
  repoUrl: string;
  sparsePath: string;
  graph: string;
  filter: string; // include regex source ('' = no include filter)
  ignore: string; // exclude regex source ('' = no ignore filter)
  cloneDir: string;
  dbPath: string;
}

/** Validate an OPTIONAL regex string for a @clack text prompt (empty is OK). */
function validateRegex(v?: string): string | undefined {
  const s = (v ?? '').trim();
  if (!s) return undefined;
  try {
    new RegExp(s);
    return undefined;
  } catch (e) {
    return `Invalid regex: ${(e as Error).message}`;
  }
}

/** Human-readable repo slug ("material-ui") from a clone URL. */
function repoSlug(url: string): string {
  const tail = url.replace(/\.git$/, '').replace(/\/+$/, '').split('/').pop() ?? 'repo';
  return tail.replace(/[^a-zA-Z0-9._-]/g, '-') || 'repo';
}

/** A DB path unique to (repo, subtree, filter, ignore) so distinct targets —
 *  including the same subtree narrowed by a different filter — never collide.
 *  The filter/ignore segment is appended only when set, so the default
 *  (empty filters) keeps the original (repo, subtree) DB path stable. */
function resolveTarget(repoUrl: string, sparsePath: string, graph: string, filter: string, ignore: string): Target {
  const slug = repoSlug(repoUrl);
  const filterKey = filter || ignore ? `::${filter}::${ignore}` : '';
  const fingerprint = sha256Hex(`${repoUrl}::${sparsePath}${filterKey}`).slice(0, 8);
  return {
    repoUrl,
    sparsePath,
    graph,
    filter,
    ignore,
    cloneDir: join(REPO_DIR, slug),
    dbPath: join(ROOT, '.data', `cli-${slug}-${fingerprint}.db`),
  };
}

function freshDb(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  for (const f of [path, `${path}-wal`, `${path}-shm`]) if (existsSync(f)) rmSync(f);
}

function git(args: string[], cwd?: string): void {
  execFileSync('git', args, { cwd, stdio: ['ignore', 'inherit', 'inherit'] });
}

/** Idempotent download: reuse a cached clone, else sparse+shallow clone (full shallow as fallback). */
function ensureRepo(t: Target): void {
  if (existsSync(join(t.cloneDir, '.git'))) return; // cached clone reused
  mkdirSync(REPO_DIR, { recursive: true });
  try {
    git(['clone', '--depth', '1', '--filter=blob:none', '--sparse', t.repoUrl, t.cloneDir]);
    git(['sparse-checkout', 'set', t.sparsePath], t.cloneDir);
  } catch {
    rmSync(t.cloneDir, { recursive: true, force: true });
    git(['clone', '--depth', '1', t.repoUrl, t.cloneDir]);
  }
}

function collectSourceFiles(t: Target): string[] {
  const base = join(t.cloneDir, t.sparsePath);
  if (!existsSync(base)) return [];
  const filterRe = t.filter ? new RegExp(t.filter) : undefined; // validated at prompt time
  const ignoreRe = t.ignore ? new RegExp(t.ignore) : undefined;
  return readdirSync(base, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && /\.(ts|tsx|js|jsx)$/.test(e.name))
    .filter((e) => !/\.(test|spec)\.|\.d\.ts$/.test(e.name))
    .map((e) => join(e.parentPath, e.name))
    .filter((f) => statSync(f).size <= MAX_FILE_BYTES)
    .filter((f) => {
      const rel = relative(t.cloneDir, f).split('\\').join('/'); // forward-slashed, == originFile
      if (filterRe && !filterRe.test(rel)) return false; // FILTER: keep only matches
      if (ignoreRe && ignoreRe.test(rel)) return false; //  IGNORE: drop matches
      return true;
    })
    .sort();
}

/** Clone (if needed), wipe any stale DB, ingest the whole sparse subtree verbatim. */
async function buildDb(engine: MemoryEngine, t: Target): Promise<void> {
  const s = p.spinner();
  s.start(`Cloning ${chalk.cyan(t.repoUrl)} (sparse: ${chalk.cyan(t.sparsePath)})`);
  ensureRepo(t);
  const files = collectSourceFiles(t);
  if (files.length === 0) {
    s.stop(chalk.red('No source files found'));
    throw new Error(
      `No .ts/.tsx/.js/.jsx files under ${join(t.sparsePath)} — check the sparse path.`,
    );
  }
  s.message(`Ingesting ${files.length} source files`);

  let atoms = 0;
  const clusterTotals: Record<string, number> = {};
  for (const [i, file] of files.entries()) {
    const rel = relative(t.cloneDir, file);
    const res = await engine.ingestDocument({
      title: rel,
      text: readFileSync(file, 'utf8'),
      originFile: rel,
    });
    atoms += res.chunks;
    for (const [c, n] of Object.entries(res.clusters)) clusterTotals[c] = (clusterTotals[c] ?? 0) + n;
    if ((i + 1) % 100 === 0 || i + 1 === files.length) {
      s.message(`Ingesting ${chalk.bold(`${i + 1}/${files.length}`)} files → ${atoms} atoms`);
    }
  }
  await engine.syncNow();
  s.stop(`Ingested ${chalk.bold(String(files.length))} files → ${chalk.bold(String(atoms))} verbatim atoms`);

  const spread = Object.entries(clusterTotals)
    .sort((a, b) => b[1] - a[1])
    .map(([c, n]) => `${chalk.magenta(c)} ${n}`)
    .join('   ');
  const stats = await engine.stats();
  const filterLine = t.filter || t.ignore ? `\n${chalk.dim(`filter=${t.filter || '∅'}  ignore=${t.ignore || '∅'}`)}` : '';
  p.note(
    `${spread}\n\n${chalk.dim(`nodes=${stats.nodes}  ftsRows=${stats.ftsRows}  db=${relative(ROOT, t.dbPath)}`)}${filterLine}`,
    'Cluster spread',
  );
}

type Mode = 'exact' | 'hybrid';

function renderHits(query: string, mode: Mode, hits: SearchHit[]): void {
  if (hits.length === 0) {
    p.log.warn(`${chalk.dim('no hits for')} "${query}"`);
    return;
  }
  const lines = hits.map((h, i) => {
    const rank = chalk.dim(String(i + 1).padStart(2));
    const file = chalk.cyan(h.originFile ?? h.title);
    const cluster = chalk.magenta(`[${h.cluster}]`);
    const score =
      mode === 'hybrid'
        ? chalk.yellow(`rrf ${(h as HybridSearchHit).rrfScore.toFixed(4)}`)
        : chalk.yellow(`bm25 ${h.score.toFixed(2)}`);
    const lanes =
      mode === 'hybrid' ? chalk.dim(` {${(h as HybridSearchHit).sources.join(',')}}`) : '';
    const snippet = chalk.dim(h.snippet.replace(/\s+/g, ' ').trim().slice(0, 100));
    return `${rank} ${file} #${h.chunkIndex} ${cluster} ${score}${lanes}\n   ${snippet}`;
  });
  p.note(lines.join('\n'), `${hits.length} hit${hits.length === 1 ? '' : 's'} for "${query}"`);
}

/** REPL: prompt → search → render, until the user quits. */
async function searchLoop(engine: MemoryEngine, mode: Mode): Promise<void> {
  for (;;) {
    const query = await p.text({
      message: 'Search',
      placeholder: 'identifier or phrase — empty / Esc to quit',
    });
    if (p.isCancel(query) || !query || !String(query).trim()) return;
    const q = String(query).trim();
    const hits =
      mode === 'hybrid'
        ? await engine.hybridSearch(q, { limit: 10 })
        : await engine.search(q, { limit: 10 });
    renderHits(q, mode, hits);
  }
}

async function main(): Promise<void> {
  console.clear();
  p.intro(chalk.bgCyan(chalk.black(' spatial-memory · repo RAG CLI ')));

  // -- target: repo + sparse subtree (defaults from .env) --------------------
  const repoUrl = await p.text({
    message: 'Git repo URL to ingest',
    placeholder: DEFAULTS.repoUrl,
    defaultValue: DEFAULTS.repoUrl,
    initialValue: DEFAULTS.repoUrl,
    validate: (v) => (/^(https?:\/\/|git@).+/.test((v ?? '').trim()) ? undefined : 'Expected an http(s) or git@ URL'),
  });
  if (p.isCancel(repoUrl)) return p.cancel('Cancelled.');

  const sparsePath = await p.text({
    message: 'SPARSE_PATH — subtree to materialize & ingest',
    placeholder: DEFAULTS.sparsePath,
    defaultValue: DEFAULTS.sparsePath,
    initialValue: DEFAULTS.sparsePath,
    validate: (v) => ((v ?? '').trim().startsWith('/') ? 'Use a repo-relative path, not absolute' : undefined),
  });
  if (p.isCancel(sparsePath)) return p.cancel('Cancelled.');

  // -- optional include/ignore regexes (empty = ingest the whole subtree) -----
  const filter = await p.text({
    message: 'FILTER — include only paths matching this regex',
    placeholder: DEFAULTS.filter || 'e.g. /Button/   (empty = keep all source files)',
    defaultValue: DEFAULTS.filter,
    initialValue: DEFAULTS.filter,
    validate: validateRegex,
  });
  if (p.isCancel(filter)) return p.cancel('Cancelled.');

  const ignore = await p.text({
    message: 'IGNORE — drop paths matching this regex',
    placeholder: DEFAULTS.ignore || 'e.g. /(Unstable_|legacy)/   (empty = ignore nothing)',
    defaultValue: DEFAULTS.ignore,
    initialValue: DEFAULTS.ignore,
    validate: validateRegex,
  });
  if (p.isCancel(ignore)) return p.cancel('Cancelled.');

  const target = resolveTarget(
    String(repoUrl).trim(),
    String(sparsePath).trim(),
    DEFAULTS.graph,
    String(filter).trim(),
    String(ignore).trim(),
  );

  // -- reuse an already-built DB, or (re)build it ----------------------------
  const dbExists = existsSync(target.dbPath);
  let action: 'reuse' | 'rebuild' = 'rebuild';
  if (dbExists) {
    const choice = await p.select({
      message: `A DB for this target already exists (${chalk.dim(basename(target.dbPath))})`,
      options: [
        { value: 'reuse', label: 'Reuse it', hint: 'skip clone + ingest, search immediately' },
        { value: 'rebuild', label: 'Rebuild from scratch', hint: 're-clone if needed, wipe + re-ingest' },
      ],
    });
    if (p.isCancel(choice)) return p.cancel('Cancelled.');
    action = choice as 'reuse' | 'rebuild';
  }

  if (action === 'rebuild') freshDb(target.dbPath);

  const engine = await MemoryEngine.open({
    dbPath: target.dbPath,
    graph: target.graph,
    clusters: CLUSTERS,
  });

  try {
    if (action === 'rebuild') {
      await buildDb(engine, target);
    } else {
      const stats = await engine.stats();
      p.log.success(
        `Reusing ${chalk.cyan(relative(ROOT, target.dbPath))} — ${chalk.bold(String(stats.nodes))} atoms, ${stats.ftsRows} FTS rows`,
      );
    }

    // -- search mode, then REPL ----------------------------------------------
    const mode = await p.select({
      message: 'Search mode',
      options: [
        { value: 'exact', label: 'Exact (BM25 trigram)', hint: 'repo.ts default — identifier lookups' },
        { value: 'hybrid', label: 'Hybrid (trigram + word + RRF)', hint: 'natural-language phrasing, lane provenance' },
      ],
    });
    if (p.isCancel(mode)) return p.cancel('Cancelled.');

    p.log.step(chalk.dim('Enter a query and hit return. Empty input or Esc exits.'));
    await searchLoop(engine, mode as Mode);
  } finally {
    await engine.close();
  }

  p.outro(chalk.green('Done.'));
}

main().catch((err) => {
  p.log.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
