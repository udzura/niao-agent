import { ApiError } from "./validation";

export const EMBEDDING_MODEL = "@cf/qwen/qwen3-embedding-0.6b";
export const EMBEDDING_DIMENSIONS = 1024;
// Change this namespace and reindex when changing model/chunking policy.
export const INDEX_VERSION = "qwen3-06b-1024-c1200-o150-v1";
export const CHUNK_SIZE = 1200;
export const CHUNK_OVERLAP = 150;
export const EMBEDDING_BATCH = 8;
export type Chunk = {index: number; start: number; end: number; text: string};
export function chunkDocument(title: string, body: string): Chunk[] {
  const chars = [...body], heading = [...title].slice(0, 200).join("");
  const chunks: Chunk[] = [];
  for (let start = 0; start < chars.length; start += CHUNK_SIZE - CHUNK_OVERLAP) {
    const end = Math.min(chars.length, start + CHUNK_SIZE);
    chunks.push({index: chunks.length, start, end, text: heading + "\n\n" + chars.slice(start, end).join("")});
    if (end === chars.length) break;
  }
  return chunks;
}
export async function vectorId(documentId: string, revision: string, index: number): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([INDEX_VERSION, documentId, revision, index])));
  // Vectorize IDs are limited to 64 bytes; public doc_ + SHA-256 IDs are longer.
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, "0")).join("");
}
export class Embeddings {
  constructor(private ai: Ai) {}
  async embed(texts: string[], kind: "document" | "query", signal: AbortSignal): Promise<number[][]> {
    const start = Date.now();
    try {
      const input = kind === "document" ? {documents: texts} : {queries: texts,
        instruction: "Retrieve the user's historical technical notes and diary passages relevant to the query."};
      const result = await this.ai.run(EMBEDDING_MODEL, input, {signal});
      const data = result.data;
      if (!Array.isArray(data) || data.length !== texts.length ||
        data.some(vector => !Array.isArray(vector) || vector.length !== EMBEDDING_DIMENSIONS ||
          vector.some(n => typeof n !== "number" || !Number.isFinite(n)) || !vector.some(n => n !== 0))) {
        throw new ApiError(502, "invalid_embedding", "Embedding response has invalid dimensions or values");
      }
      console.log(JSON.stringify({event: "past_logs.embedding", model: EMBEDDING_MODEL, kind, count: texts.length,
        durationMs: Date.now() - start}));
      return data;
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof ApiError) throw error;
      throw new ApiError(503, "embedding_unavailable", "Embedding service unavailable");
    }
  }
}
