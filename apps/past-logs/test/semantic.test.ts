import { env, applyD1Migrations, reset, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { DocumentService } from "../src/documents";
import worker, {type Env} from "../src/index";
import { SemanticIndex } from "../src/semantic";
import { CHUNK_SIZE, CHUNK_OVERLAP, INDEX_VERSION, chunkDocument, vectorId } from "../src/embeddings";
import { EmbeddingFixture, VectorFixture } from "./semantic-fixtures";

const bindings = env as unknown as Env & {TEST_MIGRATIONS: any[]};
const docs = () => new DocumentService(bindings.DB);
const input = (extra = {}) => ({source: "manual", source_id: "jspi", url: "https://example.com/jspi",
  title: "JSPIによる実行の中断", body: "Wasmの処理をJSPIで止めて外部処理を待つ設計について書いた。", ...extra});
beforeEach(async () => { await applyD1Migrations(bindings.DB, bindings.TEST_MIGRATIONS); });
afterEach(async () => { await reset(); });
function setup() {
  const embeddings = new EmbeddingFixture(), vectors = new VectorFixture();
  const services = {AI: embeddings.ai, VECTORIZE: vectors.binding};
  return {embeddings, vectors, services, index: new SemanticIndex(bindings.DB, services)};
}
async function fetchWith(services: any, path: string, body?: unknown, reader = false, method = body ? "POST" : "GET") {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request("https://test" + path, {method,
    headers: {Authorization: `Bearer ${reader ? bindings.PAST_LOGS_READ_TOKEN : bindings.PAST_LOGS_ADMIN_TOKEN}`,
      "Content-Type": "application/json", Accept: "application/json, text/event-stream"},
    ...(body ? {body: JSON.stringify(body)} : {})}), {...bindings, ...services}, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}
async function rpc(services: any, name: string, args: unknown) {
  const response = await fetchWith(services, "/mcp", {jsonrpc: "2.0", id: 1, method: "tools/call", params: {name, arguments: args}}, true);
  const text = await response.text();
  return JSON.parse(response.headers.get("Content-Type")?.includes("event-stream") ? text.split("\n").find(l => l.startsWith("data:"))!.slice(5) : text);
}
describe("chunked embeddings and revision-fenced semantic retrieval", () => {
  it("chunks Unicode with overlap and generates deterministic Vectorize-compatible IDs", async () => {
    const body = "日本😀語".repeat(1000), chars = [...body], chunks = chunkDocument("Title", body);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].end).toBe(CHUNK_SIZE);
    expect(chunks[1].start).toBe(CHUNK_SIZE - CHUNK_OVERLAP);
    expect(chunks.at(-1)!.end).toBe(chars.length);
    for (const chunk of chunks) expect(chunk.text).toBe("Title\n\n" + chars.slice(chunk.start, chunk.end).join(""));
    const id = await vectorId("doc", "revision", 0);
    expect(id).toMatch(/^[a-f0-9]{64}$/); expect(await vectorId("doc", "revision", 0)).toBe(id);
    expect(await vectorId("doc", "new-revision", 0)).not.toBe(id);
  });
  it("queues documents atomically, indexes both stores, deduplicates chunks and uses query/document modes", async () => {
    const {index, embeddings, vectors} = setup();
    const doc = await docs().upsert(input({body: "JSPIの設計。".repeat(400)}));
    expect((await index.summary()).pending).toBe(1);
    expect((await index.sync(doc.id)).status).toBe("submitted");
    expect(await index.search({query: "非同期処理で待つ仕組み", min_score: 0.5})).toEqual([]); // Async mutation not visible yet.
    vectors.flush();
    const hits = await index.search({query: "非同期処理で待つ仕組み", min_score: 0.5});
    expect(hits).toHaveLength(1); expect(hits[0].id).toBe(doc.id); expect(hits[0].url).toBe(doc.url);
    expect(hits[0].search_method).toBe("semantic"); expect(hits[0].relevance).toBe(1);
    expect(embeddings.calls[0].kind).toBe("document"); expect(embeddings.calls.at(-1)!.kind).toBe("query");
    expect(vectors.queryOptions?.namespace).toBe(INDEX_VERSION);
    expect(vectors.upserts.flat().length).toBeGreaterThan(1);
    expect((await docs().search({query: "JSPI"}))[0].id).toBe(doc.id);
  });
  it("does not re-embed idempotent imports or metadata edits and hydrates current dates and URLs from D1", async () => {
    const {index, embeddings, vectors} = setup();
    const doc = await docs().upsert(input()); await index.sync(doc.id); vectors.flush();
    await docs().upsert(input()); await index.sync(doc.id);
    await docs().update(doc.id, {url: "https://example.com/new", created_at: "2020-01-01T00:00:00Z"}); await index.sync(doc.id);
    expect(embeddings.calls.filter(c => c.kind === "document")).toHaveLength(1);
    const [hit] = await index.search({query: "非同期"});
    expect(hit.url).toBe("https://example.com/new"); expect(hit.created_at).toBe("2020-01-01T00:00:00.000Z");
  });
  it("hides obsolete and deleted revisions immediately, even while Vectorize mutations are delayed", async () => {
    const {index, vectors} = setup();
    const doc = await docs().upsert(input()); await index.sync(doc.id); vectors.flush();
    const oldIds = [...vectors.stored.keys()];
    await docs().update(doc.id, {title: "Ruby", body: "新しいRubyランタイムの記録"});
    expect(await index.search({query: "非同期", min_score: 0.5})).toEqual([]);
    await index.sync(doc.id); vectors.flush();
    expect(vectors.deletes.flat()).toEqual(expect.arrayContaining(oldIds));
    expect((await index.search({query: "Ruby", min_score: 0.5}))[0].title).toBe("Ruby");
    await docs().delete(doc.id);
    expect(await index.search({query: "Ruby"})).toEqual([]);
    await index.sync(doc.id); vectors.flush(); expect(vectors.stored.size).toBe(0);
    // Reconciliation IDs/tombstones survive deletion, without retaining old article bodies.
    expect((await bindings.DB.prepare("SELECT COUNT(*) AS n FROM semantic_chunks").first<any>()).n).toBeGreaterThan(0);
  });
  it("filters sources, applies a score threshold, and retrieves unchanged canonical references", async () => {
    const {index, vectors} = setup();
    for (const source of ["manual", "hatena"]) {
      const doc = await docs().upsert(input({source})); await index.sync(doc.id);
    }
    vectors.flush();
    const hits = await index.search({query: "非同期", source: "hatena", limit: 1, min_score: 0.5});
    expect(hits).toHaveLength(1); expect(hits[0].source).toBe("hatena");
    expect(vectors.queryOptions!.filter).toEqual({source: {$eq: "hatena"}});
    expect(await index.search({query: "unrelated", min_score: 0.9})).toEqual([]);
  });
});

describe("durable indexing retries and concurrent mutations", () => {
  it("persists provider and vector failures, then repairs without duplicate documents or IDs", async () => {
    const {index, embeddings, vectors} = setup();
    const doc = await docs().upsert(input()); embeddings.fail = true;
    expect((await index.sync(doc.id)).error_code).toBe("embedding_unavailable");
    embeddings.fail = false; vectors.failUpsert = true;
    expect((await index.sync(doc.id)).error_code).toBe("vector_upsert_unavailable");
    const planned = vectors.upserts[0].map(v => v.id);
    vectors.failUpsert = false;
    expect((await index.reindex({})).results[0].status).toBe("submitted"); vectors.flush();
    expect(vectors.upserts.at(-1)!.map(v => v.id)).toEqual(planned);
    expect((await index.summary()).pending).toBe(0);
    expect((await index.search({query: "非同期"}))[0].id).toBe(doc.id);
  });
  it("rejects invalid provider dimensions without inventing embeddings or falling back to lexical results", async () => {
    const {index, embeddings} = setup();
    const doc = await docs().upsert(input()); embeddings.invalid = true;
    expect((await index.sync(doc.id)).error_code).toBe("invalid_embedding");
    await expect(index.search({query: "JSPI"})).rejects.toThrow("invalid dimensions");
    expect(await docs().search({query: "JSPI"})).toHaveLength(1);
  });
  it("retains deletion jobs after a failed delete and supports recreation of the same source identity", async () => {
    const {index, vectors} = setup();
    const doc = await docs().upsert(input()); await index.sync(doc.id); vectors.flush(); await docs().delete(doc.id);
    vectors.failDelete = true;
    expect((await index.sync(doc.id)).error_code).toBe("vector_delete_unavailable");
    expect(await index.search({query: "非同期"})).toEqual([]);
    vectors.failDelete = false; await index.reindex({}); vectors.flush(); expect(vectors.stored.size).toBe(0);
    const recreated = await docs().upsert(input()); expect(recreated.id).toBe(doc.id);
    await index.sync(recreated.id); vectors.flush(); expect(await index.search({query: "非同期"})).toHaveLength(1);
  });
  it("fences an in-flight old revision and leaves the latest mutation pending for retry", async () => {
    const {index, embeddings, vectors} = setup();
    const doc = await docs().upsert(input());
    embeddings.beforeReturn = async () => {
      embeddings.beforeReturn = undefined;
      await docs().update(doc.id, {title: "Ruby", body: "Rubyの新しい内容"});
      expect((await index.sync(doc.id)).status).toBe("pending"); // Active lease remains held.
    };
    await index.sync(doc.id); expect(vectors.upserts).toHaveLength(0);
    await index.sync(doc.id); vectors.flush();
    expect((await index.search({query: "Ruby", min_score: 0.5}))[0].title).toBe("Ruby");
    expect(await index.search({query: "非同期", min_score: 0.5})).toEqual([]);
  });
  it("resumes large articles from persisted chunk progress within bounded indexing invocations", async () => {
    const {index, embeddings, vectors} = setup();
    const doc = await docs().upsert(input({body: "Ruby ".repeat(10000)}));
    const first = await index.sync(doc.id); expect(first.status).toBe("pending"); expect(first.chunks_submitted).toBe(32);
    // Simulate a process dying with a lease, then its expiry on another request.
    await bindings.DB.prepare("UPDATE semantic_jobs SET lease_token='crashed',lease_until=? WHERE document_id=?")
      .bind(Date.now() + 120000, doc.id).run();
    expect((await index.sync(doc.id)).error_code).toBe("index_busy");
    await bindings.DB.prepare("UPDATE semantic_jobs SET lease_until=0 WHERE document_id=?").bind(doc.id).run();
    expect((await index.sync(doc.id)).status).toBe("submitted");
    vectors.flush();
    expect(embeddings.calls.filter(c => c.kind === "document").flatMap(c => c.texts)).toHaveLength(chunkDocument(doc.title, doc.body).length);
    expect((await index.search({query: "Ruby"}))[0].id).toBe(doc.id);
  });
  it("force-rebuilds an externally recreated index using existing D1 documents and stable chunk IDs", async () => {
    const {index, vectors} = setup();
    const doc = await docs().upsert(input()); await index.sync(doc.id); vectors.flush();
    const original = [...vectors.stored.keys()]; vectors.stored.clear();
    expect(await index.search({query: "非同期"})).toEqual([]);
    expect((await index.reindex({force: true})).results[0].status).toBe("submitted"); vectors.flush();
    expect([...vectors.stored.keys()]).toEqual(original);
    expect((await index.search({query: "非同期"}))[0].id).toBe(doc.id);
  });
});

describe("REST dual writes and read-only semantic MCP", () => {
  it("registers through REST into D1 and Vectorize, then searches by MCP and reads the same document", async () => {
    const {services, vectors} = setup();
    const registered = await fetchWith(services, "/api/documents", input()); expect(registered.status).toBe(200);
    const body = await registered.json<any>(); expect(body.semantic_index.status).toBe("submitted"); vectors.flush();
    const response = await rpc(services, "search_past_logs_semantic", {query: "非同期処理の昔の設計"});
    const [hit] = JSON.parse(response.result.content[0].text); expect(hit.id).toBe(body.document.id);
    const content = await rpc(services, "get_past_log", {id: hit.id});
    expect(JSON.parse(content.result.content[0].text).body).toBe(input().body);
    const updated = await fetchWith(services, `/api/documents/${hit.id}`, {body: "Rubyランタイムに関する新しい記録"}, false, "PUT");
    expect((await updated.json<any>()).semantic_index.status).toBe("submitted"); vectors.flush();
    const deleted = await fetchWith(services, `/api/documents/${hit.id}`, undefined, false, "DELETE");
    expect((await deleted.json<any>()).semantic_index.status).toBe("submitted"); vectors.flush();
    expect(vectors.stored.size).toBe(0);
  });
  it("keeps D1 writes and keyword search working during semantic failure and reports pending status", async () => {
    const {services, embeddings, vectors} = setup(); embeddings.fail = true;
    const response = await fetchWith(services, "/api/documents", input());
    const body = await response.json<any>(); expect(response.status).toBe(200);
    expect(body.semantic_index.status).toBe("pending"); expect(body.semantic_index.error_code).toBe("embedding_unavailable");
    expect(await docs().search({query: "JSPI"})).toHaveLength(1);
    const unavailable = await rpc(services, "search_past_logs_semantic", {query: "非同期"}); expect(unavailable.result.isError).toBe(true);
    expect(JSON.parse(unavailable.result.content[0].text).error).toBe("embedding_unavailable");
    embeddings.fail = false; vectors.failQuery = true;
    const failedQuery = await rpc(services, "search_past_logs_semantic", {query: "非同期"});
    expect(failedQuery.result.isError).toBe(true);
    expect(JSON.parse(failedQuery.result.content[0].text).error).toBe("vector_query_unavailable");
  });
  it("validates semantic input and authenticates index management separately from read-only MCP", async () => {
    const {services} = setup();
    for (const args of [{query: ""}, {query: "x", min_score: 2}, {query: "x", limit: 21}]) {
      const result = await rpc(services, "search_past_logs_semantic", args);
      expect(result.error ?? result.result?.isError).toBeTruthy();
    }
    expect((await fetchWith(services, "/api/semantic-index", undefined, true)).status).toBe(401);
    expect((await fetchWith(services, "/api/semantic-index/reindex", {}, true)).status).toBe(401);
    expect((await fetchWith(services, "/api/semantic-index")).status).toBe(200);
    expect((await fetchWith(services, "/api/semantic-index/reindex", {limit: 99})).status).toBe(400);
    const write = await rpc(services, "reindex", {}); expect(write.error ?? write.result?.isError).toBeTruthy();
    const missing = await rpc({AI: undefined, VECTORIZE: undefined}, "search_past_logs_semantic", {query: "x"});
    expect(JSON.parse(missing.result.content[0].text).error).toBe("semantic_not_configured");
  });
});
