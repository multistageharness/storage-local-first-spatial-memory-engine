/**
 * Phase 3 / Feature 3.2 — FTS5 query generation.
 *
 * The trigram tokenizer indexes every 3-char sequence, which is what buys
 * substring + camelCase tolerance ("Price" hits "calculateTotalPrice").
 * Two consequences handled here:
 *   - terms shorter than 3 chars can never match → dropped;
 *   - user text must be quoted as FTS5 string literals so identifiers
 *     like "foo.bar(x)" don't get parsed as MATCH syntax.
 */

export interface SearchFilter {
  graphId?: number;
  clusterId?: number;
}

export interface SearchWeights {
  /** Task 3.2.3 — title gets double weight by default. */
  title: number;
  body: number;
}

export const DEFAULT_WEIGHTS: SearchWeights = { title: 2.0, body: 1.0 };

/**
 * Sanitize raw user text into a safe FTS5 MATCH expression.
 * Each whitespace-separated term becomes a quoted string literal
 * (implicit AND between terms). Returns null if nothing survives —
 * trigram cannot match terms under 3 chars.
 */
export function sanitizeFtsQuery(raw: string): string | null {
  const terms = raw
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3)
    .map((t) => `"${t.replaceAll('"', '""')}"`);
  return terms.length > 0 ? terms.join(' ') : null;
}

/**
 * Task 3.2.2 — bm25() auxiliary-function sort. bm25 returns more-negative
 * values for better matches, so ORDER BY ascending puts best hits first.
 * Weight params are positional per FTS5 column order (title, body).
 */
export function buildSearchSql(filter: SearchFilter): string {
  return buildFtsSearchSql('nodes_fts', filter);
}

/**
 * IDEA.v2 §5.2 — same query shape over the word-level unicode61 index.
 * Identical SELECT list so trigram and word hits fuse without reshaping.
 */
export function buildWordSearchSql(filter: SearchFilter): string {
  return buildFtsSearchSql('nodes_fts_words', filter);
}

function buildFtsSearchSql(ftsTable: 'nodes_fts' | 'nodes_fts_words', filter: SearchFilter): string {
  const where: string[] = [`${ftsTable} MATCH @match`];
  if (filter.graphId != null) where.push(`n.graph_id = @graphId`);
  if (filter.clusterId != null) where.push(`n.cluster_id = @clusterId`);
  return `
    SELECT
      n.id            AS id,
      n.graph_id      AS graphId,
      n.cluster_id    AS clusterId,
      c.name          AS cluster,
      n.title         AS title,
      n.origin_file   AS originFile,
      n.chunk_index   AS chunkIndex,
      bm25(${ftsTable}, @titleWeight, @bodyWeight) AS score,
      snippet(${ftsTable}, 1, '「', '」', '…', 16) AS snippet,
      n.body          AS body
    FROM ${ftsTable}
    JOIN nodes n     ON n.id = ${ftsTable}.rowid
    JOIN clusters c  ON c.id = n.cluster_id
    WHERE ${where.join(' AND ')}
    ORDER BY score ASC
    LIMIT @limit
  `;
}

/**
 * IDEA.v2 §5.2 — sanitizer variant for the unicode61 word index.
 * Differences from the trigram sanitizer: the <3-char drop rule goes away
 * (unicode61 matches whole words of any length), and terms of ≥ 4 chars
 * gain a prefix star ("term"*) so e.g. `paginat` still hits `pagination`.
 * unicode61 ignores punctuation other than the tokenchars '_'/'$', so the
 * quoted-literal discipline carries over unchanged.
 */
export function sanitizeWordFtsQuery(raw: string): string | null {
  const terms = raw
    .split(/\s+/)
    .map((t) => t.trim())
    // strip characters unicode61 treats as separators at the edges, so a
    // term like "login()" still prefix-expands on its token "login"
    .map((t) => t.replace(/^[^\p{L}\p{N}_$]+|[^\p{L}\p{N}_$]+$/gu, ''))
    .filter((t) => t.length > 0)
    .map((t) => {
      const quoted = `"${t.replaceAll('"', '""')}"`;
      return t.length >= 4 ? `${quoted} *` : quoted;
    });
  return terms.length > 0 ? terms.join(' ') : null;
}
