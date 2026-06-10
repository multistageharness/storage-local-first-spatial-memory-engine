/**
 * IDEA.v2 §5.2 — the Embedder seam for the optional vector lane.
 *
 * Same philosophy as the eval stack's Judge interface (DEMO001 §8.2): a
 * deterministic implementation ships and gates CI offline, a
 * network-backed implementation plugs into the identical interface for
 * real deployments.
 *
 *   - HashingEmbedder: char-trigram feature hashing → fixed-dim float32,
 *     zero-network, seeded by construction (pure function of the text).
 *     This is what every gate runs.
 *   - OllamaEmbedder: live local-model embeddings via the Ollama HTTP
 *     API. Never used in CI (IDEA.v2 §11 — no GPU runner); behind the
 *     same interface so swapping is a config change.
 *
 * All embedders L2-normalize, so cosine similarity reduces to a dot
 * product downstream.
 */

export interface Embedder {
  readonly dims: number;
  /** May be sync (hashing) or async (network) — callers always await. */
  embed(text: string): Float32Array | Promise<Float32Array>;
}

export const DEFAULT_EMBEDDING_DIMS = 384;

/** FNV-1a 32-bit — tiny, fast, deterministic. */
function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export class HashingEmbedder implements Embedder {
  constructor(readonly dims: number = DEFAULT_EMBEDDING_DIMS) {}

  embed(text: string): Float32Array {
    const v = new Float32Array(this.dims);
    const t = text.toLowerCase();
    // char trigrams mirror the FTS5 trigram tokenizer's unit of meaning
    for (let i = 0; i + 3 <= t.length; i++) {
      const h = fnv1a(t.slice(i, i + 3));
      const bucket = h % this.dims;
      const sign = (h & 0x80000000) !== 0 ? -1 : 1; // signed hashing kills bias
      v[bucket] += sign;
    }
    return l2normalize(v);
  }
}

export interface OllamaEmbedderOptions {
  baseUrl?: string;
  model?: string;
}

/** Live-only (IDEA.v1 "Localized RRF"); requires a running Ollama daemon. */
export class OllamaEmbedder implements Embedder {
  readonly dims: number;
  private readonly baseUrl: string;
  private readonly model: string;

  constructor(dims: number = DEFAULT_EMBEDDING_DIMS, opts: OllamaEmbedderOptions = {}) {
    this.dims = dims;
    this.baseUrl = opts.baseUrl ?? 'http://127.0.0.1:11434';
    this.model = opts.model ?? 'nomic-embed-text';
  }

  async embed(text: string): Promise<Float32Array> {
    const res = await fetch(`${this.baseUrl}/api/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.model, prompt: text }),
    });
    if (!res.ok) throw new Error(`OllamaEmbedder: HTTP ${res.status}`);
    const { embedding } = (await res.json()) as { embedding: number[] };
    // pad / truncate to the configured store dimensionality
    const v = new Float32Array(this.dims);
    for (let i = 0; i < Math.min(this.dims, embedding.length); i++) v[i] = embedding[i];
    return l2normalize(v);
  }
}

export function l2normalize(v: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  const norm = Math.sqrt(sum);
  if (norm > 0) for (let i = 0; i < v.length; i++) v[i] /= norm;
  return v;
}

/** Dot product — cosine similarity for L2-normalized vectors. */
export function dot(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

/** float32 BLOB codecs for the nodes_vec side-table. */
export function embeddingToBuffer(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

export function bufferToEmbedding(buf: Buffer): Float32Array {
  // copy: SQLite buffers may be views over a shared allocation
  return new Float32Array(new Uint8Array(buf).buffer, 0, Math.floor(buf.byteLength / 4));
}
