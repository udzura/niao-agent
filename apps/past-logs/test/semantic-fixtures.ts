// Explicit offline test doubles. Never imported by a production entry point.
// These verify orchestration/consistency, not real model retrieval quality.
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } from "../src/embeddings";
export class EmbeddingFixture {
  calls: {kind: "query" | "document"; texts: string[]}[] = [];
  fail = false;
  invalid = false;
  beforeReturn?: () => Promise<void>;
  ai = {run: async (model: string, input: any) => {
    if (model !== EMBEDDING_MODEL) throw new Error("Unexpected test model");
    const kind = input.queries ? "query" : "document", texts: string[] = input.queries ?? input.documents;
    if (input.text || (kind === "query" && !input.instruction)) throw new Error("Expected task-specific embedding input");
    this.calls.push({kind, texts});
    if (this.fail) throw new Error("Fixture provider failure; private input must not be logged");
    await this.beforeReturn?.();
    return {data: texts.map(text => {
      const vector = Array(this.invalid ? 3 : EMBEDDING_DIMENSIONS).fill(0);
      if (/JSPI|非同期|中断|async|suspend/i.test(text)) vector[0] = 1;
      else if (/Ruby|ランタイム|Wasm/i.test(text)) vector[1] = 1;
      else vector[2] = 1;
      return vector;
    }), shape: [texts.length, EMBEDDING_DIMENSIONS]};
  }} as unknown as Ai;
}
export class VectorFixture {
  stored = new Map<string, VectorizeVector>();
  pending: (() => void)[] = [];
  upserts: VectorizeVector[][] = [];
  deletes: string[][] = [];
  failUpsert = false;
  failDelete = false;
  failQuery = false;
  queryOptions?: VectorizeQueryOptions;
  binding = {
    upsert: async (vectors: VectorizeVector[]) => {
      this.upserts.push(structuredClone(vectors));
      if (this.failUpsert) throw new Error("Fixture vector failure");
      this.pending.push(() => { for (const vector of vectors) this.stored.set(vector.id, vector); });
      return {mutationId: crypto.randomUUID()};
    },
    deleteByIds: async (ids: string[]) => {
      this.deletes.push(ids);
      if (this.failDelete) throw new Error("Fixture delete failure");
      this.pending.push(() => { for (const id of ids) this.stored.delete(id); });
      return {mutationId: crypto.randomUUID()};
    },
    query: async (vector: number[], options: VectorizeQueryOptions) => {
      if (this.failQuery) throw new Error("Fixture query failure");
      this.queryOptions = options;
      const source = (options.filter?.source as {$eq?: string})?.$eq;
      const matches = [...this.stored.values()].filter(v => v.namespace === options.namespace && (!source || v.metadata?.source === source))
        .map(v => ({id: v.id, score: vector.reduce((n, x, i) => n + x * v.values[i], 0), namespace: v.namespace}))
        .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, options.topK);
      return {matches, count: matches.length};
    },
  } as unknown as Vectorize;
  flush() { for (const operation of this.pending.splice(0)) operation(); }
}
