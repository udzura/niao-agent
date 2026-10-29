import { SELF, env, applyD1Migrations, reset, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import worker, {type Env} from "../src/index";
import { DocumentService } from "../src/documents";
import { MAX_BODY_BYTES } from "../src/validation";

const testEnv = env as unknown as Env & {TEST_MIGRATIONS: any[]};
const docs = () => new DocumentService(testEnv.DB);
const admin = "test-admin-token-0000000000000000000000";
const reader = "test-reader-token-000000000000000000000";
const input = (extra = {}) => ({source: "cosense", source_id: "project/日本語検索", url: "https://scrapbox.io/example/日本語検索",
  title: "日本語検索とCloudflare Workers", body: "日本語の全文検索をD1で実装する。Cloudflare WorkersとSQLite FTS5の技術メモ。",
  created_at: "2024-02-01T09:00:00+09:00", ...extra});
async function rest(path: string, method = "GET", body?: unknown, token: string | null = admin) {
  return SELF.fetch("https://example.test" + path, {method, headers: {
    "Content-Type": "application/json", ...(token ? {Authorization: `Bearer ${token}`} : {}),
  }, ...(body === undefined ? {} : {body: JSON.stringify(body)})});
}
async function rpc(method: string, params: unknown = {}, token: string | null = reader) {
  const response = await SELF.fetch("https://example.test/mcp", {method: "POST", headers: {
    "Content-Type": "application/json", Accept: "application/json, text/event-stream",
    ...(token ? {Authorization: `Bearer ${token}`} : {}),
  }, body: JSON.stringify({jsonrpc: "2.0", id: 1, method, params})});
  const text = await response.text();
  const data = response.headers.get("Content-Type")?.includes("text/event-stream")
    ? JSON.parse(text.split("\n").find(l => l.startsWith("data:"))!.slice(5)) : JSON.parse(text);
  return {status: response.status, data};
}
beforeEach(async () => { await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS); });
afterEach(async () => { await reset(); });

describe("D1 documents and Japanese keyword index", () => {
  it("creates stable identities, idempotently upserts, and preserves original dates", async () => {
    const first = await docs().upsert(input({metadata: {tags: ["Ruby", "日本語"]}}));
    const second = await docs().upsert(input({body: "更新した内容", updated_at: "2025-06-03T12:00:00Z"}));
    expect(first.id).toBe(second.id);
    expect(first.created_at).toBe("2024-02-01T00:00:00.000Z");
    expect(first.metadata).toEqual({tags: ["Ruby", "日本語"]});
    expect(second.indexed_at).not.toBe(second.created_at);
    expect(await docs().get(first.id)).toEqual(second);
    expect((await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM documents").first<any>()).n).toBe(1);
    const otherSource = await docs().upsert(input({source: "hatena"}));
    expect(otherSource.id).not.toBe(first.id);
  });
  it("searches Japanese two/one-character words, longer phrases, mixed queries and normalized English", async () => {
    const doc = await docs().upsert(input());
    for (const query of ["検索", "語", "全文検索", "Cloudflare 日本語", "workers sqlite", "Ｃｌｏｕｄｆｌａｒｅ"]) {
      const hits = await docs().search({query});
      expect(hits.map(h => h.id), query).toContain(doc.id);
      expect(hits[0].excerpt.length).toBeLessThanOrEqual(242);
      expect(hits[0].url).toBe(doc.url); expect(hits[0].created_at).toBe(doc.created_at);
      expect(hits[0].relevance).toBeGreaterThan(0);
    }
    expect(await docs().search({query: "検索 missingword"})).toEqual([]);
    expect(await docs().search({query: "日本語実装"})).toEqual([]); // No bag-of-bigrams false phrase.
    await expect(docs().search({query: "***"})).rejects.toThrow("searchable terms");
  });
  it("ranks title matches, filters sources, and bounds result count", async () => {
    const bodyHit = await docs().upsert(input({source_id: "body", title: "日記", body: "Rubyと遊ぶ"}));
    const titleHit = await docs().upsert(input({source_id: "title", source: "hatena", title: "Ruby", body: "日記"}));
    expect((await docs().search({query: "ruby"})).map(h => h.id)).toEqual([titleHit.id, bodyHit.id]);
    expect((await docs().search({query: "ruby", source: "cosense"})).map(h => h.id)).toEqual([bodyHit.id]);
    expect(await docs().search({query: "ruby", limit: 1})).toHaveLength(1);
  });
  it("atomically updates/removes search entries for PUT, upsert, and deletion", async () => {
    const doc = await docs().upsert(input());
    await docs().update(doc.id, {title: "新しい表題", body: "mrubyで計算"});
    expect(await docs().search({query: "Cloudflare"})).toEqual([]);
    expect(await docs().search({query: "mruby"})).toHaveLength(1);
    await docs().upsert(input({title: "再取り込み", body: "乱数生成"}));
    expect(await docs().search({query: "mruby"})).toEqual([]);
    expect(await docs().search({query: "乱数"})).toHaveLength(1);
    await docs().delete(doc.id);
    expect(await docs().get(doc.id)).toBeNull();
    expect(await docs().search({query: "乱数"})).toEqual([]);
    await expect(docs().update(doc.id, {title: "x"})).rejects.toThrow("not found");
  });
});

describe("authenticated management REST API", () => {
  it("supports the complete import/get/update/delete flow and missing IDs", async () => {
    const created = await rest("/api/documents", "POST", input()); expect(created.status).toBe(200);
    const {document} = await created.json<any>();
    const path = `/api/documents/${document.id}`;
    expect((await rest(path)).status).toBe(200);
    const updated = await rest(path, "PUT", {title: "更新した記事"});
    expect((await updated.json<any>()).document.title).toBe("更新した記事");
    expect((await rest(path, "DELETE")).status).toBe(200);
    expect((await rest(path)).status).toBe(404);
    expect((await rest(path, "DELETE")).status).toBe(404);
    expect((await rest("/api/documents")).status).toBe(405);
  });
  it("separates read and admin credentials on all routes, including retrieval", async () => {
    const {id} = await docs().upsert(input());
    for (const token of [null, reader, "incorrect-token"]) {
      for (const [method, path] of [["POST", "/api/documents"], ["GET", `/api/documents/${id}`], ["PUT", `/api/documents/${id}`], ["DELETE", `/api/documents/${id}`]]) {
        expect((await rest(path, method, method === "GET" || method === "DELETE" ? undefined : input(), token)).status).toBe(401);
      }
    }
    expect((await rpc("tools/list", {}, admin)).status).toBe(401);
    expect((await rpc("tools/list", {}, null)).status).toBe(401);
    expect((await rest("/health", "GET", undefined, null)).status).toBe(200);
    const ctx = createExecutionContext();
    const misconfigured = await worker.fetch(new Request("https://test/mcp"), {...testEnv, PAST_LOGS_READ_TOKEN: admin}, ctx);
    expect(misconfigured.status).toBe(503); await waitOnExecutionContext(ctx);
  });
  it("validates identity, dates, unknown fields, body and request limits", async () => {
    for (const patch of [{source: "unknown"}, {url: "javascript:alert(1)"}, {created_at: "yesterday"}, {body: ""}, {id: "user-owned"}, {body: "x".repeat(MAX_BODY_BYTES + 1)}]) {
      expect((await rest("/api/documents", "POST", input(patch))).status).toBe(400);
    }
    expect((await rest("/api/documents", "POST", input({body: "x".repeat(256 * 1024)}))).status).toBe(413);
    // NFKC expansion must fail safely before D1's row/column limits or JS argument limits.
    expect((await rest("/api/documents", "POST", input({body: "㍿".repeat(40000)}))).status).toBe(413);
    const {id} = await docs().upsert(input());
    expect((await rest(`/api/documents/${id}`, "PUT", {source_id: "new-identity"})).status).toBe(400);
    const response = await SELF.fetch("https://test/api/documents", {method: "POST", headers: {Authorization: `Bearer ${admin}`, "Content-Type": "application/json"}, body: "{"});
    expect(response.status).toBe(400);
  });
});

describe("stateless MCP read-only tools over Streamable HTTP", () => {
  it("discovers three read-only tools, searches and retrieves source references", async () => {
    const doc = await docs().upsert(input());
    const list = await rpc("tools/list"); expect(list.status).toBe(200);
    expect(list.data.result.tools.map((t: any) => t.name).sort()).toEqual(["get_past_log", "search_past_logs", "search_past_logs_semantic"]);
    expect(list.data.result.tools.every((t: any) => t.annotations.readOnlyHint)).toBe(true);
    const search = await rpc("tools/call", {name: "search_past_logs", arguments: {query: "検索 Cloudflare"}});
    const hits = JSON.parse(search.data.result.content[0].text); expect(hits[0].id).toBe(doc.id);
    const get = await rpc("tools/call", {name: "get_past_log", arguments: {id: doc.id}});
    expect(JSON.parse(get.data.result.content[0].text).body).toBe(doc.body);
    const write = await rpc("tools/call", {name: "delete_document", arguments: {id: doc.id}});
    expect(write.data.error ?? write.data.result?.isError).toBeTruthy();
    expect(await docs().get(doc.id)).not.toBeNull();
  });
  it("rejects malformed tool inputs and handles unknown documents gracefully", async () => {
    for (const args of [{query: ""}, {query: "Ruby", limit: 21}, {query: "Ruby", source: "unknown"}]) {
      const response = await rpc("tools/call", {name: "search_past_logs", arguments: args});
      expect(response.data.error ?? response.data.result?.isError).toBeTruthy();
    }
    const missing = await rpc("tools/call", {name: "get_past_log", arguments: {id: "doc_" + "0".repeat(64)}});
    expect(missing.data.result.isError).toBe(true);
    expect(JSON.parse(missing.data.result.content[0].text)).toEqual({error: "not_found"});
  });
  it("stores long Unicode articles and paginates bounded MCP results without split characters", async () => {
    const body = "検索😀Ruby ".repeat(2000);
    const doc = await docs().upsert(input({body}));
    const first = await rpc("tools/call", {name: "get_past_log", arguments: {id: doc.id, limit: 100}});
    const page = JSON.parse(first.data.result.content[0].text);
    expect([...page.body]).toHaveLength(100); expect(page.next_offset).toBe(100);
    expect(page.total_chars).toBe([...body].length);
    expect((await docs().page({id: doc.id, offset: 100, limit: 100})).body).toBe([...body].slice(100, 200).join(""));
    expect((await docs().get(doc.id))!.body).toBe(body);
  });
});
