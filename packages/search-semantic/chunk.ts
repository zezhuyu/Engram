export interface Chunk { index: number; text: string; lineStart: number; lineEnd: number }
export const CHUNKER_VERSION = 1, MAX_CHUNKS = 24, TARGET_CHARS = 1000, HARD_CHARS = 1600;
/**
 * Deterministic chunking of a document body: paragraphs are packed up to about 1000 characters (long paragraphs are cut at line or word boundaries), each chunk is
 * prefixed with the title so it embeds with its context, and at most 24 chunks per document are indexed (the rest of a very long document is not embedded; keyword
 * and grep still see all of it). Line numbers are body-relative and 1-based. The same function recreates a chunk's text at query time, so no content is stored with the vectors.
 */
export function chunkDocument(title: string, body: string): Chunk[] {
  const lines = body.split('\n'); const chunks: Chunk[] = []; let buf: string[] = [], start = 1, size = 0;
  const flush = (end: number) => { const text = buf.join('\n').trim(); if (text && chunks.length < MAX_CHUNKS) chunks.push({ index: chunks.length, text: `${title}\n${text}`, lineStart: start, lineEnd: end }); buf = []; size = 0; };
  for (let i = 0; i < lines.length && chunks.length < MAX_CHUNKS; i++) {
    let line = lines[i]!;
    while (line.length > HARD_CHARS) { const cut = line.lastIndexOf(' ', HARD_CHARS) > HARD_CHARS / 2 ? line.lastIndexOf(' ', HARD_CHARS) : HARD_CHARS; if (!buf.length) start = i + 1; buf.push(line.slice(0, cut)); size += cut; flush(i + 1); line = line.slice(cut).trimStart(); }
    if (!buf.length) start = i + 1;
    const blank = line.trim() === ''; buf.push(line); size += line.length + 1;
    if ((blank && size >= TARGET_CHARS / 2) || size >= TARGET_CHARS) flush(i + 1);
  }
  if (buf.length) flush(lines.length);
  if (!chunks.length) chunks.push({ index: 0, text: title, lineStart: 1, lineEnd: 1 }); // a title-only document is still findable
  return chunks;
}
