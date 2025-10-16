// ingest/utils/chunk.js
export function chunkText(text, { maxChars = 2000, overlap = 200 } = {}) {
  const chunks = [];
  let i = 0;
  while (i < text.length) {
    const end = Math.min(i + maxChars, text.length);
    const slice = text.slice(i, end);
    chunks.push(slice);
    if (end >= text.length) break;
    i = end - overlap;
  }
  return chunks;
}
