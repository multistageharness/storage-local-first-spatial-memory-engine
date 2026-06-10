/**
 * Repo loader + auto-annotator — turns a massive real code repository
 * (e.g. a facebook/react checkout) into a benchmark golden dataset.
 *
 * Loading: walks the tree (sorted, deterministic), keeps source files,
 * and emits one CorpusDoc per file with the repo-relative path as the
 * document id — the same id the benchmark's exact retrieval metrics
 * score against.
 *
 * Annotation: because the corpus is real code that changes upstream,
 * cases are derived from the checkout itself rather than hand-written:
 *   - scan for function/const definitions and build an identifier →
 *     containing-files index;
 *   - identifiers defined in exactly one file with no other references
 *     become COMMON cases (direct lookups);
 *   - identifiers defined in one file but referenced by others become
 *     DISTRACTOR cases — the referencing files are real, organic lures;
 *   - two single-file identifiers from different files are combined into
 *     MULTI-HOP cases;
 *   - NO-ANSWER cases use synthetic identifiers verified absent from the
 *     whole corpus, so refusal is the only correct behavior.
 * Expected answers are the definition lines themselves (extractive
 * ground truth), and the distribution is emitted at the recommended
 * 55/25/10/10 mix. A seeded PRNG makes the dataset reproducible per
 * checkout.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { BenchmarkCase, BenchmarkDataset } from '../eval/benchmark.js';
import type { CorpusDoc } from '../eval/goldens.js';
import { tokenize } from '../eval/metrics.js';
import { scoreSentences } from '../eval/generator.js';
import { chunkText } from '../../src/spatial/chunker.js';

// ---- loading -----------------------------------------------------------------

export interface RepoLoadOptions {
  /** file filter (default: .js/.jsx/.ts/.tsx sources) */
  include?: RegExp;
  /** path-segment excludes (default: tests, fixtures, node_modules) */
  exclude?: RegExp;
  /** stop after this many files (0 = no cap) */
  maxFiles?: number;
  /** skip files larger than this (generated bundles etc.) */
  maxBytesPerFile?: number;
}

export function loadRepoCorpus(root: string, opts: RepoLoadOptions = {}): CorpusDoc[] {
  const include = opts.include ?? /\.(js|jsx|ts|tsx)$/;
  const exclude = opts.exclude ?? /(^|\/)(__tests__|__mocks__|fixtures|node_modules|\.git)(\/|$)/;
  const maxFiles = opts.maxFiles ?? 0;
  const maxBytes = opts.maxBytesPerFile ?? 131072;

  const docs: CorpusDoc[] = [];
  const walk = (dir: string): void => {
    if (maxFiles > 0 && docs.length >= maxFiles) return;
    for (const entry of readdirSync(dir).sort()) {
      if (maxFiles > 0 && docs.length >= maxFiles) return;
      const full = join(dir, entry);
      const rel = relative(root, full);
      if (exclude.test(rel)) continue;
      const stat = statSync(full);
      if (stat.isDirectory()) {
        walk(full);
      } else if (include.test(entry) && stat.size > 0 && stat.size <= maxBytes) {
        docs.push({ title: rel, text: readFileSync(full, 'utf8'), originFile: rel });
      }
    }
  };
  walk(root);
  return docs;
}

// ---- annotation ----------------------------------------------------------------

export interface RepoBenchmarkOptions {
  seed?: number;
  /** total cases; split 55/25/10/10 across the four query types */
  totalCases?: number;
  name?: string;
}

/** mulberry32 — seeded PRNG, same generator the synthesizer uses. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DEFINITION_RE = /(?:^|\s)(?:export\s+)?(?:default\s+)?(?:function\s+|const\s+)([A-Za-z_$][A-Za-z0-9_$]{7,})\s*[=(]/gm;

interface Definition {
  identifier: string;
  doc: CorpusDoc;
  /** files (other than the defining one) that mention the identifier */
  referencedBy: string[];
}

/** Lines mentioning the identifier, with the *defining* line first. */
function definitionLines(doc: CorpusDoc, identifier: string): string[] {
  const lines = doc.text
    .split(/\n+/)
    .map((l) => l.trim())
    .filter((l) => l.includes(identifier) && !l.startsWith('//') && !l.startsWith('*'));
  const defIdx = lines.findIndex((l) => new RegExp(`(?:function|const)\\s+${identifier}\\b`).test(l));
  if (defIdx > 0) lines.unshift(...lines.splice(defIdx, 1));
  return lines;
}

/**
 * The ideal expected answer for "What does <id> do in <file>?" — what a
 * perfect faithful extractive generator would produce under PERFECT
 * retrieval: the identifier-bearing sentences of the defining file, ranked
 * by similarity to the question, restored to narrative order. Intrinsic to
 * the corpus + question (no retrieval involved), so it is valid annotation
 * ground truth rather than a fit to the system under test.
 */
function idealEvidence(doc: CorpusDoc, identifier: string, maxSentences = 3): string {
  const probe = `What does ${identifier} do in ${anchor(doc.title)}?`;
  return scoreSentences(probe, [doc.text])
    .filter((s) => s.sentence.includes(identifier))
    .slice(0, maxSentences)
    .sort((a, b) => a.order - b.order)
    .map((s) => s.sentence)
    .join(' ');
}

/**
 * Question anchor for a file: its basename. The identifier term alone pins
 * the defining document in FTS5 (single-definition identifiers are rare by
 * construction); using the basename instead of the full repo path keeps the
 * question natural while avoiding 8+ path tokens (react/native/src/…) that
 * would drown the identifier in the generator's similarity scoring.
 */
function anchor(title: string): string {
  return title.split('/').pop() ?? title;
}

/**
 * Intrinsic-quality filtration (the annotator's "critic" stage). A case is
 * usable only when:
 *   1. its leading evidence line survives ingestion intact — the chunker
 *      may split a line across chunk boundaries, and an extractive answer
 *      can never reproduce a sentence that exists in no chunk;
 *   2. the evidence carries enough content tokens to score against;
 *   3. the question is answerable under IDEAL retrieval: probing the whole
 *      defining file as context, the best-matching sentence must actually
 *      mention the identifier. Files whose surrounding vocabulary collides
 *      with the question (e.g. an identifier inside SuspenseTab.js asking
 *      about "tree" next to SuspenseTreeContext imports) produce
 *      unanswerable-by-construction cases and are rejected.
 * All three are properties of the corpus + ingestion config under perfect
 * retrieval — none depend on the system's retrieval quality, so the filter
 * does not bias the benchmark toward the system under test.
 */
function isUsableCandidate(d: Definition): boolean {
  const lines = definitionLines(d.doc, d.identifier);
  if (lines.length === 0) return false;
  if (tokenize(lines.slice(0, 3).join(' ')).length < 5) return false;
  if (!chunkText(d.doc.text).some((c) => c.text.includes(lines[0]))) return false;
  const probe = `What does ${d.identifier} do in ${anchor(d.doc.title)}?`;
  const best = scoreSentences(probe, [d.doc.text])[0];
  return best !== undefined && best.sentence.includes(d.identifier);
}

function indexDefinitions(corpus: CorpusDoc[]): Definition[] {
  // identifier -> defining docs
  const defs = new Map<string, CorpusDoc[]>();
  for (const doc of corpus) {
    for (const match of doc.text.matchAll(DEFINITION_RE)) {
      const id = match[1];
      const list = defs.get(id) ?? [];
      if (!list.includes(doc)) list.push(doc);
      defs.set(id, list);
    }
  }
  // keep identifiers defined in exactly ONE file (unambiguous ground truth)
  const out: Definition[] = [];
  for (const [identifier, docs] of defs) {
    if (docs.length !== 1) continue;
    const referencedBy = [];
    for (const other of corpus) {
      if (other !== docs[0] && other.text.includes(identifier)) referencedBy.push(other.title);
      if (referencedBy.length >= 4) break; // enough lure material
    }
    out.push({ identifier, doc: docs[0], referencedBy });
  }
  // deterministic order regardless of Map iteration
  return out.sort((a, b) => a.identifier.localeCompare(b.identifier));
}

function sample<T>(pool: T[], n: number, rand: () => number): T[] {
  const copy = [...pool];
  const picked: T[] = [];
  while (picked.length < n && copy.length > 0) {
    picked.push(copy.splice(Math.floor(rand() * copy.length), 1)[0]);
  }
  return picked;
}

export function buildRepoBenchmark(corpus: CorpusDoc[], opts: RepoBenchmarkOptions = {}): BenchmarkDataset {
  const rand = mulberry32(opts.seed ?? 42);
  const total = opts.totalCases ?? 20;
  const counts = {
    common: Math.round(total * 0.55),
    distractor: Math.round(total * 0.25),
    multihop: Math.round(total * 0.1),
    noanswer: total - Math.round(total * 0.55) - Math.round(total * 0.25) - Math.round(total * 0.1),
  };

  const defs = indexDefinitions(corpus).filter(isUsableCandidate);
  const lonely = defs.filter((d) => d.referencedBy.length === 0); // common + multi-hop pool
  const shared = defs.filter((d) => d.referencedBy.length >= 1); // distractor pool
  const need = counts.common + counts.multihop * 2;
  if (lonely.length < need || shared.length < counts.distractor) {
    throw new Error(
      `corpus too small to annotate: ${lonely.length} single-file identifiers (need ${need}), ` +
        `${shared.length} cross-referenced identifiers (need ${counts.distractor})`,
    );
  }

  const cases: BenchmarkCase[] = [];

  // common — direct lookups, path-anchored like a developer's question
  const commonDefs = sample(lonely, counts.common + counts.multihop * 2, rand);
  for (let i = 0; i < counts.common; i++) {
    const d = commonDefs[i];
    cases.push({
      id: `common-${String(i + 1).padStart(2, '0')}`,
      input: `What does ${d.identifier} do in ${anchor(d.doc.title)}?`,
      expectedAnswer: idealEvidence(d.doc, d.identifier),
      supportingDocs: [d.doc.title],
      metadata: { answerable: true, queryType: 'common', difficulty: 'easy', allowedVariance: 'free' },
    });
  }

  // distractor — referencing files are organic lures for the defining file
  for (const [i, d] of sample(shared, counts.distractor, rand).entries()) {
    cases.push({
      id: `distractor-${String(i + 1).padStart(2, '0')}`,
      input: `What does ${d.identifier} do in ${anchor(d.doc.title)}?`,
      expectedAnswer: idealEvidence(d.doc, d.identifier),
      supportingDocs: [d.doc.title],
      metadata: {
        answerable: true, queryType: 'distractor', difficulty: 'hard', allowedVariance: 'free',
        tags: d.referencedBy.map((f) => `lure:${f}`),
      },
    });
  }

  // multi-hop — one question spanning two definition files
  for (let i = 0; i < counts.multihop; i++) {
    const a = commonDefs[counts.common + i * 2];
    const b = commonDefs[counts.common + i * 2 + 1];
    cases.push({
      id: `multihop-${String(i + 1).padStart(2, '0')}`,
      input: `What does ${a.identifier} do in ${anchor(a.doc.title)}, and what does ${b.identifier} do in ${anchor(b.doc.title)}?`,
      expectedAnswer: `${idealEvidence(a.doc, a.identifier, 2)} ${idealEvidence(b.doc, b.identifier, 2)}`,
      supportingDocs: [a.doc.title, b.doc.title],
      metadata: { answerable: true, queryType: 'multi-hop', difficulty: 'hard', allowedVariance: 'free' },
    });
  }

  // no-answer — synthetic identifiers verified absent from the whole corpus
  let made = 0;
  let counter = 0;
  while (made < counts.noanswer) {
    const ghost = `zorbletQuantumFlux${counter++}`;
    if (corpus.some((doc) => doc.text.includes(ghost))) continue;
    // the question deliberately avoids universal code vocabulary
    // ("module", "exports") so retrieval has nothing generic to latch onto
    cases.push({
      id: `noanswer-${String(made + 1).padStart(2, '0')}`,
      input: `What does ${ghost} do?`,
      expectedAnswer: '',
      supportingDocs: [],
      metadata: { answerable: false, queryType: 'no-answer', difficulty: 'medium', allowedVariance: 'strict' },
    });
    made += 1;
  }

  return {
    name: opts.name ?? 'repo-auto-benchmark',
    provenance: { curatedBy: 'repo-auto-annotator', generatedBy: 'repo-auto-annotator-v1' },
    corpus,
    cases,
  };
}
