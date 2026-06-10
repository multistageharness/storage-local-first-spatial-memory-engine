/**
 * Task 2.2.1 — verbatim chunking. Atoms are stored exactly as written
 * (no paraphrasing, no normalization): 800-char windows with 100-char
 * overlap so identifiers straddling a boundary remain findable.
 */

export interface ChunkOptions {
  chunkSize?: number;
  overlap?: number;
}

export interface Chunk {
  index: number;
  text: string;
  start: number;
  end: number;
}

export const DEFAULT_CHUNK_SIZE = 800;
export const DEFAULT_OVERLAP = 100;

export function chunkText(text: string, opts: ChunkOptions = {}): Chunk[] {
  const size = opts.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const overlap = opts.overlap ?? DEFAULT_OVERLAP;
  if (size <= 0) throw new Error('chunkSize must be > 0');
  if (overlap >= size) throw new Error('overlap must be < chunkSize');

  if (text.length === 0) return [];
  const step = size - overlap;
  const chunks: Chunk[] = [];
  for (let start = 0, index = 0; start < text.length; start += step, index++) {
    const end = Math.min(start + size, text.length);
    chunks.push({ index, text: text.slice(start, end), start, end });
    if (end >= text.length) break;
  }
  return chunks;
}
