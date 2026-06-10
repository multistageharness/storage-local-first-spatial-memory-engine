/**
 * Integration use case 4 — "agent memory over a foreign repo".
 *
 * Downloads https://github.com/mui/material-ui (sparse, shallow — only
 * packages/mui-material/src is materialized) into ./repo, ingests every
 * source file verbatim, routes chunks into topical clusters by keyword
 * density, then answers real identifier lookups an autonomous coding
 * agent would issue against an unfamiliar third-party codebase.
 *
 * Self-verifying: each query has a ground-truth path fragment that must
 * appear in the top-10 hits' origin files, or the script exits non-zero.
 * Requires network on first run; the clone is cached and reused after.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryEngine } from '../dist/src/engine.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..'); // integration/ → project root (run as source via tsx)
const REPO_URL = 'https://github.com/mui/material-ui.git';
const REPO_DIR = join(ROOT, 'integration', 'repo');
const CLONE_DIR = join(REPO_DIR, 'material-ui');
const SPARSE_PATH = 'packages/mui-material/src'; // only this subtree is materialized
const DB_PATH = join(ROOT, '.data', 'integration-repo.db');
const MAX_FILE_BYTES = 256 * 1024; // skip generated monsters

// Optional include/ignore filters, layered on top of the built-in
// extension + test/.d.ts + size rules. Both default to EMPTY (no-op), so the
// out-of-the-box behavior is unchanged; supply either to narrow the ingest:
//   --filter <re>   keep ONLY files whose clone-relative path matches <re>
//   --ignore <re>   DROP files whose clone-relative path matches <re>
// <re> is a JS regular expression tested against the forward-slashed path that
// also becomes each atom's originFile (e.g.
// 'material-ui/packages/mui-material/src/Button/Button.tsx'). Env fallbacks:
// FILTER, IGNORE.  Examples:
//   --ignore '/(Unstable_|legacy)/'      drop unstable/legacy subtrees
//   --filter '/Button/'                  ingest only the Button family
function flag(name: string): string {
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  const next = process.argv[i + 1];
  return i >= 0 && next && !next.startsWith('--') ? next : '';
}
function compileFilter(label: string, src: string): RegExp | undefined {
  if (!src) return undefined;
  try {
    return new RegExp(src);
  } catch (e) {
    console.error(`repo.ts: invalid --${label} regex ${JSON.stringify(src)}: ${(e as Error).message}`);
    process.exit(2);
  }
}
const FILTER = flag('filter') || process.env.FILTER || '';
const IGNORE = flag('ignore') || process.env.IGNORE || '';
const filterRe = compileFilter('filter', FILTER);
const ignoreRe = compileFilter('ignore', IGNORE);

function freshDb(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  for (const f of [path, `${path}-wal`, `${path}-shm`]) if (existsSync(f)) rmSync(f);
}

function git(args: string[], cwd?: string): void {
  execFileSync('git', args, { cwd, stdio: ['ignore', 'inherit', 'inherit'] });
}

/** Idempotent download: reuse a cached clone, else sparse+shallow clone (full shallow as fallback). */
function ensureRepo(): void {
  if (existsSync(join(CLONE_DIR, '.git'))) {
    console.log(`[repo] reusing cached clone at ${relative(ROOT, CLONE_DIR)}`);
    return;
  }
  mkdirSync(REPO_DIR, { recursive: true });
  console.log(`[repo] cloning ${REPO_URL} (sparse: ${SPARSE_PATH}) …`);
  try {
    git(['clone', '--depth', '1', '--filter=blob:none', '--sparse', REPO_URL, CLONE_DIR]);
    git(['sparse-checkout', 'set', SPARSE_PATH], CLONE_DIR);
  } catch {
    console.log('[repo] sparse clone unsupported — falling back to full shallow clone');
    rmSync(CLONE_DIR, { recursive: true, force: true });
    git(['clone', '--depth', '1', REPO_URL, CLONE_DIR]);
  }
}

function collectSourceFiles(): string[] {
  const base = join(CLONE_DIR, SPARSE_PATH);
  return readdirSync(base, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && /\.(ts|tsx|js|jsx)$/.test(e.name))
    .filter((e) => !/\.(test|spec)\.|\.d\.ts$/.test(e.name))
    .map((e) => join(e.parentPath, e.name))
    .filter((f) => statSync(f).size <= MAX_FILE_BYTES)
    .filter((f) => {
      const rel = relative(CLONE_DIR, f).split('\\').join('/'); // forward-slashed, == originFile
      if (filterRe && !filterRe.test(rel)) return false; // --filter: keep only matches
      if (ignoreRe && ignoreRe.test(rel)) return false; //  --ignore: drop matches
      return true;
    })
    .sort();
}

async function main(): Promise<void> {
  console.log('\n=== integration: RAG over a downloaded foreign repo (mui/material-ui) ===\n');
  ensureRepo();
  freshDb(DB_PATH);

  const engine = await MemoryEngine.open({
    dbPath: DB_PATH,
    graph: 'material-ui',
    clusters: [
      { name: 'styling', keywords: ['theme', 'palette', 'styled', 'typography', 'breakpoint', 'css'] },
      { name: 'components', keywords: ['forwardRef', 'className', 'ownerState', 'slotProps', 'render'] },
      { name: 'hooks', keywords: ['useState', 'useEffect', 'useCallback', 'useRef', 'useMemo'] },
      { name: 'a11y', keywords: ['aria-', 'role=', 'keyboard', 'focusVisible', 'tabIndex'] },
    ],
  });

  // -- ingest every source file in the sparse subtree verbatim ---------------
  if (filterRe || ignoreRe) console.log(`[repo] filters applied → filter=${FILTER || '∅'} ignore=${IGNORE || '∅'}`);
  const files = collectSourceFiles();
  if (files.length === 0) {
    console.error(`\nFAIL: no source files to ingest${filterRe || ignoreRe ? ' — filter/ignore excluded everything' : ''}`);
    process.exit(1);
  }
  let atoms = 0;
  const clusterTotals: Record<string, number> = {};
  for (const [i, file] of files.entries()) {
    const rel = relative(CLONE_DIR, file);
    const res = await engine.ingestDocument({
      title: rel,
      text: readFileSync(file, 'utf8'),
      originFile: rel,
    });
    atoms += res.chunks;
    for (const [c, n] of Object.entries(res.clusters)) clusterTotals[c] = (clusterTotals[c] ?? 0) + n;
    if ((i + 1) % 500 === 0) console.log(`[ingest] ${i + 1}/${files.length} files …`);
  }
  console.log(`[ingest] ${files.length} source files → ${atoms} verbatim atoms`);
  console.log(`[ingest] cluster spread: ${Object.entries(clusterTotals).map(([c, n]) => `${c}=${n}`).join(' ')}`);

  // -- agent-style identifier lookups with ground truth ----------------------
  // expect = path fragment that must appear in a top-10 hit's originFile
  // (fragment-based so the assertion survives upstream file moves/renames)
  const lookups: { query: string; expect: string; note: string }[] = [
    { query: 'useMediaQuery', expect: 'useMediaQuery', note: 'exported hook' },
    { query: 'createTheme', expect: 'createTheme', note: 'theme factory' },
    { query: 'ButtonBase', expect: 'ButtonBase', note: 'foundational component' },
    { query: 'TouchRipple', expect: 'TouchRipple', note: 'internal sub-component' },
    { query: 'CircularProgress', expect: 'CircularProgress', note: 'camelCase identifier' },
    { query: 'Autocomplete', expect: 'Autocomplete', note: 'SUBSTRING of useAutocomplete too' },
  ];

  let failures = 0;
  for (const { query, expect, note } of lookups) {
    const hits = await engine.search(query, { limit: 10 });
    const found = hits.some((h) => (h.originFile ?? '').includes(expect));
    const status = found ? 'ok ' : 'MISS';
    console.log(`[query] ${status} "${query}" (${note}) → top: ${hits[0]?.originFile ?? '∅'} [${hits[0]?.cluster ?? '-'}]`);
    if (!found) failures++;
  }

  // -- assemble a RAG context block -------------------------------------------
  const question = 'How does Material UI decide a palette contrast text color?';
  const ctx = await engine.search('contrastText getContrastRatio', { limit: 3 });
  console.log(`\n[rag] question: "${question}"`);
  console.log(`[rag] context (${ctx.length} verbatim atoms):`);
  for (const h of ctx) {
    console.log(`  ── ${h.originFile} #${h.chunkIndex} [${h.cluster}, bm25 ${h.score.toFixed(2)}]`);
  }

  await engine.syncNow();
  const stats = await engine.stats();
  console.log(`\n[stats] nodes=${stats.nodes} ftsRows=${stats.ftsRows} outboxDirty=${stats.outboxDirty}`);

  await engine.close();
  if (failures > 0) {
    console.error(`\nFAIL: ${failures}/${lookups.length} ground-truth lookups missed`);
    process.exit(1);
  }
  console.log(`\nPASS: ${lookups.length}/${lookups.length} ground-truth lookups hit — foreign-repo RAG verified.\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
