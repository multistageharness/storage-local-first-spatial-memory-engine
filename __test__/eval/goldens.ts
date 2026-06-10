/**
 * Synthetic golden generation — the guide's four-stage data evolution
 * pipeline (DeepEval Synthesizer architecture), implemented as a
 * deterministic, seeded, local-first synthesizer over a document corpus:
 *
 *   1. Input Generation — candidate inputs grounded strictly in extracted
 *      document contexts (no invented facts).
 *   2. Filtration — a critic scores each candidate on self-containment and
 *      clarity; sub-threshold candidates are rejected (bounded retries).
 *   3. Evolution — survivors are mutated for complexity: multi-context
 *      (spanning two source documents) and concretizing (anchoring to the
 *      origin file), sampled from a seeded probability distribution.
 *   4. Styling — inputs are normalized into a consistent question format
 *      and tagged with their evolution lineage.
 *
 * Goldens hold static inputs + expected outputs only. Actual outputs and
 * retrieval contexts are NEVER pre-computed here — the harness fetches
 * them dynamically at test time (the guide's foundational rule).
 */
import { tokenize } from './metrics.js';

export interface CorpusDoc {
  title: string;
  text: string;
  originFile?: string;
}

export interface Golden {
  /** static test input (the question) */
  input: string;
  /** ground-truth expected output, extracted verbatim from the corpus */
  expectedOutput: string;
  /** source context(s) the golden was synthesized from */
  sourceContexts: string[];
  /** evolution lineage applied in stage 3, e.g. ["multi-context"] */
  evolutions: string[];
  /** critic scores recorded at filtration time */
  quality: { selfContainment: number; clarity: number };
}

export interface SynthesizerOptions {
  /** PRNG seed — identical seeds synthesize identical goldens */
  seed?: number;
  /** maximum goldens to emit */
  maxGoldens?: number;
  /** critic acceptance floor for both quality criteria */
  qualityThreshold?: number;
  /** candidate regeneration attempts per context before giving up */
  maxRetries?: number;
  /** probability that an accepted golden is evolved (per technique) */
  evolutionRate?: number;
}

/** mulberry32 — seeded PRNG so every run synthesizes the identical dataset. */
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

// ---- stage 1: input generation -------------------------------------------

/** Identifiers (camelCase / PascalCase / snake_case) are the corpus's "needles". */
function extractIdentifiers(text: string): string[] {
  const matches = text.match(/\b[a-zA-Z_][a-zA-Z0-9_]{5,}\b/g) ?? [];
  return [...new Set(matches.filter((m) => /[A-Z_]/.test(m.slice(1))))];
}

interface Candidate {
  input: string;
  expectedOutput: string;
  sourceContext: string;
  doc: CorpusDoc;
}

/** Sentence(s) of a document that mention the identifier — extractive ground truth. */
function evidenceFor(doc: CorpusDoc, identifier: string): string {
  return doc.text
    .split(/(?<=[.!?;])\s+|\n+/)
    .filter((s) => s.includes(identifier))
    .join(' ')
    .trim();
}

function generateCandidates(doc: CorpusDoc): Candidate[] {
  const candidates: Candidate[] = [];
  for (const id of extractIdentifiers(doc.text)) {
    const evidence = evidenceFor(doc, id);
    if (!evidence) continue;
    candidates.push({
      input: `What does ${id} do in ${doc.title}?`,
      expectedOutput: evidence,
      sourceContext: evidence,
      doc,
    });
  }
  return candidates;
}

// ---- stage 2: filtration (critic) ----------------------------------------

export interface CriticVerdict {
  selfContainment: number;
  clarity: number;
}

/**
 * Critic — qualitative gatekeeper scoring the two non-negotiable criteria.
 * Self-containment: the input must be understandable without external
 * reference (penalizes dangling pronouns, missing subjects). Clarity: the
 * intent must be unambiguous (penalizes fragments and run-ons).
 */
export function critiqueInput(input: string): CriticVerdict {
  const tokens = tokenize(input);
  let selfContainment = 1;
  if (/^\s*(it|this|that|they|these|those)\b/i.test(input)) selfContainment -= 0.5;
  if (!/[A-Za-z_][A-Za-z0-9_]{4,}/.test(input)) selfContainment -= 0.3; // no concrete subject
  let clarity = 1;
  if (!/\?\s*$/.test(input)) clarity -= 0.3; // not phrased as a question
  if (tokens.length < 3) clarity -= 0.5; // fragment
  if (tokens.length > 40) clarity -= 0.4; // run-on
  return {
    selfContainment: Math.max(0, selfContainment),
    clarity: Math.max(0, clarity),
  };
}

// ---- stage 3 + 4: evolution and styling ------------------------------------

function evolveMultiContext(a: Golden, b: Golden): Golden {
  return {
    input: `${a.input.replace(/\?\s*$/, '')}, and ${b.input.replace(/^What/, 'what')}`,
    expectedOutput: `${a.expectedOutput} ${b.expectedOutput}`.trim(),
    sourceContexts: [...a.sourceContexts, ...b.sourceContexts],
    evolutions: [...a.evolutions, 'multi-context'],
    quality: {
      selfContainment: Math.min(a.quality.selfContainment, b.quality.selfContainment),
      clarity: Math.min(a.quality.clarity, b.quality.clarity),
    },
  };
}

function evolveConcretizing(g: Golden, originFile: string): Golden {
  return {
    ...g,
    input: g.input.replace(/\?\s*$/, `, as implemented in ${originFile}?`),
    evolutions: [...g.evolutions, 'concretizing'],
  };
}

/** Stage 4 — normalize the final input shape (capitalized, single '?'). */
function style(g: Golden): Golden {
  const flat = g.input.replace(/\s+/g, ' ').replace(/\?+\s*$/, '').trim();
  return { ...g, input: `${flat.charAt(0).toUpperCase()}${flat.slice(1)}?` };
}

// ---- the synthesizer -------------------------------------------------------

export function synthesizeGoldens(corpus: CorpusDoc[], opts: SynthesizerOptions = {}): Golden[] {
  const rand = mulberry32(opts.seed ?? 42);
  const maxGoldens = opts.maxGoldens ?? 24;
  const qualityThreshold = opts.qualityThreshold ?? 0.6;
  const maxRetries = opts.maxRetries ?? 3;
  const evolutionRate = opts.evolutionRate ?? 0.3;

  const accepted: Golden[] = [];
  for (const doc of corpus) {
    if (accepted.length >= maxGoldens) break;
    // stage 1: grounded candidates for this document
    const pool = generateCandidates(doc);
    if (pool.length === 0) continue;
    // stage 2: filtration with bounded regeneration — a rejected candidate
    // is replaced by the next one from the pool, up to maxRetries draws
    let golden: Golden | null = null;
    for (let attempt = 0; attempt < Math.min(maxRetries, pool.length); attempt++) {
      const candidate = pool[Math.floor(rand() * pool.length)];
      const verdict = critiqueInput(candidate.input);
      if (verdict.selfContainment >= qualityThreshold && verdict.clarity >= qualityThreshold) {
        golden = {
          input: candidate.input,
          expectedOutput: candidate.expectedOutput,
          sourceContexts: [candidate.sourceContext],
          evolutions: [],
          quality: verdict,
        };
        break;
      }
    }
    if (!golden) continue;
    // stage 3: seeded evolution
    if (rand() < evolutionRate && accepted.length > 0) {
      const partner = accepted[Math.floor(rand() * accepted.length)];
      // multi-context only across distinct source documents
      if (partner.sourceContexts[0] !== golden.sourceContexts[0]) {
        golden = evolveMultiContext(golden, partner);
      }
    }
    if (rand() < evolutionRate && doc.originFile) {
      golden = evolveConcretizing(golden, doc.originFile);
    }
    // stage 4: styling
    accepted.push(style(golden));
  }
  return accepted;
}
