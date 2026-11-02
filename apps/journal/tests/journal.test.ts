import { SELF, env, applyD1Migrations, reset } from "cloudflare:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Articles } from "../src/core/articles";
import { prefersMarkdown, publicRequest } from "../src/index";
import { journalMcp } from "../src/mcp";

const bindings = env as any, base = "https://journal.example.org";
const publisher = "journal-publisher-token-000000000000000", agent = "journal-agent-token-0000000000000000000";
const draft = {title: "NiaoとD1 <&>", description: "調べたこと & 発見", bodyMarkdown: "## 観察\n\nD1を調べました。\n\n<script>alert('xss')</script>\n\n[x](javascript:alert(1))", journalDate: "2026-11-01"};
beforeEach(async () => { await applyD1Migrations(bindings.DB, bindings.TEST_MIGRATIONS); });
afterEach(async () => { await reset(); });
const store = () => new Articles(bindings.DB);
const publish = async (data: Record<string, unknown> = draft) => {
  const created = await store().create(data);
  return store().publish({articleId: created.id, expectedUpdatedAt: created.updatedAt, confirmPublication: true});
};
async function mcp<T>(token: string, run: (client: Client) => Promise<T>) {
  const client = new Client({name: "journal-test", version: "1.0.0"});
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: {headers: {Authorization: `Bearer ${token}`}},
    fetch: (input, init) => SELF.fetch(input as RequestInfo, init as RequestInit),
  });
  try { await client.connect(transport); return await run(client); }
  finally { await client.close(); }
}
const call = async (client: Client, name: string, args: Record<string, unknown>) => {
  const result = await client.callTool({name, arguments: args});
  return {...JSON.parse((result.content[0] as {text: string}).text), isError: result.isError ?? false};
};

describe("D1 authoring", () => {
  it("migrates, atomically stores sources, enforces identity/date uniqueness and idempotency", async () => {
    const data = {...draft, idempotencyKey: "daily:2026-11-01", sources: [{sourceType: "message", sourceRef: "private-message-123"}]};
    const created = await store().create(data);
    expect(created).toMatchObject({status: "draft", journalDate: "2026-11-01", slug: "2026-11-01", authorId: "niao"});
    expect(await store().create(data)).toEqual(created);
    await expect(store().create({...data, title: "different"})).rejects.toMatchObject({code: "idempotency_conflict"});
    await expect(store().create({...draft, idempotencyKey: "other"})).rejects.toMatchObject({code: "journal_date_conflict"});
    await expect(bindings.DB.prepare("UPDATE articles SET slug='changed' WHERE id=?").bind(created.id).run()).rejects.toThrow();
    const count = await bindings.DB.prepare("SELECT count(*) AS n FROM articles").first(); expect(count.n).toBe(1);
    await expect(store().create({...draft, journalDate: "2026-02-30"})).rejects.toThrow();
  });
  it("updates drafts with review preconditions and publishes idempotently with frozen content", async () => {
    const created = await store().create(draft);
    const updated = await store().update({articleId: created.id, expectedUpdatedAt: created.updatedAt, title: "変更", sources: []});
    expect(updated.status).toBe("draft"); expect(updated.updatedAt).not.toBe(created.updatedAt);
    await expect(store().update({articleId: created.id, expectedUpdatedAt: created.updatedAt, title: "stale"})).rejects.toMatchObject({code: "draft_changed"});
    await expect(store().publish({articleId: created.id, expectedUpdatedAt: created.updatedAt, confirmPublication: true})).rejects.toMatchObject({code: "draft_changed"});
    const input = {articleId: created.id, expectedUpdatedAt: updated.updatedAt, confirmPublication: true};
    const published = await store().publish(input);
    expect(await store().publish(input)).toEqual(published);
    await expect(store().update({articleId: created.id, expectedUpdatedAt: published.updatedAt, title: "edit"})).rejects.toMatchObject({code: "published_article_immutable"});
    for (const sql of ["UPDATE articles SET status='draft',published_at=NULL", "UPDATE articles SET body_markdown='changed'", "DELETE FROM articles"])
      await expect(bindings.DB.prepare(sql).run()).rejects.toThrow();
  });
  it("detects concurrent draft/source updates without mixing revisions", async () => {
    const created = await store().create(draft);
    const results = await Promise.allSettled(["first", "second"].map(title => store().update({articleId: created.id, expectedUpdatedAt: created.updatedAt,
      title, sources: [{sourceType: "observation", sourceRef: title}]})));
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    const latest = await store().get({articleId: created.id}); expect(latest.sources[0].sourceRef).toBe(latest.title);
  });
  it("rejects publication of credential patterns and private identifiers", async () => {
    for (const bodyMarkdown of ["Bearer abcdefghijklmnopqrstuvwxyz123456", "private-observation-123"]) {
      const created = await store().create({title: "unsafe", bodyMarkdown, sources: [{sourceType: "observation", sourceRef: "private-observation-123"}]});
      await expect(store().publish({articleId: created.id, expectedUpdatedAt: created.updatedAt, confirmPublication: true})).rejects.toMatchObject({code: "sensitive_content"});
    }
  });
});

describe("open Web", () => {
  it("hides drafts everywhere, with no-store errors", async () => {
    const created = await store().create(draft);
    for (const path of [`/journal/${created.slug}`, `/journal/${created.slug}.md`]) {
      const response = await SELF.fetch(`${base}${path}`); expect(response.status).toBe(404); expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
    for (const path of ["/journal", "/feed.xml", "/sitemap.xml"]) expect(await (await SELF.fetch(`${base}${path}`)).text()).not.toContain(created.title);
  });
  it("renders escaped HTML, canonical Markdown, negotiation and public-only sources", async () => {
    const article = await publish({...draft, sources: [{sourceType: "message", sourceRef: "internal-message-456", title: "Private"},
      {sourceType: "url", sourceRef: "internal-url-id", title: "D1 reference", url: "https://developers.cloudflare.com/d1/", public: true}]});
    const url = `${base}/journal/${article.slug}`;
    const htmlResponse = await SELF.fetch(url), html = await htmlResponse.text();
    expect(htmlResponse.headers.get("Content-Type")).toContain("text/html"); expect(htmlResponse.headers.get("Vary")).toBe("Accept");
    expect(html).toContain("NiaoとD1 &lt;&amp;&gt;"); expect(html).toContain("<h2>観察</h2>");
    expect(html).not.toContain("<script>alert"); expect(html).not.toContain('href="javascript:');
    expect(html).toContain(`rel="canonical" href="${url}"`); expect(html).toContain('type="application/rss+xml"');
    expect(html).toContain("BlogPosting"); expect(html).toContain("D1 reference");
    for (const secret of ["internal-message-456", "internal-url-id", "Private"]) expect(html).not.toContain(secret);
    const markdownResponse = await SELF.fetch(url, {headers: {Accept: "text/markdown"}}), markdown = await markdownResponse.text();
    expect(markdownResponse.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8"); expect(markdown).toContain(article.bodyMarkdown);
    expect(markdown).toContain(`canonical_url: "${url}"`); expect(markdown).not.toContain("internal-message-456");
    expect(await (await SELF.fetch(`${url}.md`, {headers: {Accept: "text/html"}})).text()).toBe(markdown);
    expect((await SELF.fetch(url)).headers.get("Content-Type")).toContain("text/html");
    expect(htmlResponse.headers.get("Cache-Control")).toContain("s-maxage=86400");
    expect(markdownResponse.headers.get("Link")).toContain(`${url}.md`);
    const head = await SELF.fetch(url, {method: "HEAD"}); expect(await head.text()).toBe("");
  });
  it("isolates representations by normalized URL, and bypasses caching for credentials/cookies", async () => {
    const article = await publish(); const url = `${base}/journal/${article.slug}`;
    expect(publicRequest(new Request(`${url}?junk=1`, {headers: {Accept: "text/markdown", Authorization: "secret", "X-Forwarded-Host": "evil.test"}}), bindings).url).toBe(`${url}.md`);
    expect([...publicRequest(new Request(url, {headers: {Cookie: "x=y"}}), bindings).headers]).toEqual([]);
    for (const headers of [{Authorization: `Bearer ${publisher}`}, {Cookie: "private=true"}]) {
      const response = await SELF.fetch(url, {headers}); expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
    expect(prefersMarkdown("text/markdown;q=0, text/html")).toBe(false);
    expect(prefersMarkdown("text/html;q=0.9,text/markdown;q=0.1")).toBe(false);
    expect(prefersMarkdown("text/markdown;q=1, text/html;q=0.5")).toBe(true);
    expect(prefersMarkdown("text/markdown;q=0.1, */*;q=1")).toBe(false);
    expect((await SELF.fetch(`${base}/journal?page=-1`)).status).toBe(400);
  });
  it("serves valid RSS ordered by publication and stable UUID GUIDs, plus discovery files", async () => {
    await store().create({...draft, journalDate: "2026-10-29", title: "hidden-draft"});
    const a = await publish({...draft, journalDate: "2026-10-30"});
    await bindings.DB.prepare("INSERT INTO articles (id,slug,title,body_markdown,status,created_at,updated_at,published_at,creation_hash) VALUES (?,?,?,'body','published',?,?,?,'test')")
      .bind(crypto.randomUUID(), "newest", "newest", "2099-01-01T00:00:00.000Z", "2099-01-01T00:00:00.000Z", "2099-01-01T00:00:00.000Z").run();
    const response = await SELF.fetch(`${base}/feed.xml`), text = await response.text();
    expect(response.headers.get("Content-Type")).toBe("application/rss+xml; charset=utf-8"); expect(XMLValidator.validate(text)).toBe(true);
    const channel = new XMLParser().parse(text).rss.channel;
    expect(channel.item[0].title).toBe("newest"); expect(channel.item[1].guid).toBe(`urn:uuid:${a.id}`);
    expect(channel.item[1].pubDate).toBe(new Date(a.publishedAt!).toUTCString()); expect(text).not.toContain("hidden-draft");
    const map = await (await SELF.fetch(`${base}/sitemap.xml`)).text(); expect(XMLValidator.validate(map)).toBe(true);
    expect(map).toContain(`${base}/journal/${a.slug}`); expect(map).not.toContain("2026-10-29");
    for (const path of ["/journal", "/llms.txt", "/robots.txt"]) expect((await SELF.fetch(`${base}${path}`)).status).toBe(200);
    expect((await SELF.fetch(`${base}/`, {redirect: "manual"})).status).toBe(302);
  });
  it("bounds feed/index pagination and excludes drafts", async () => {
    await bindings.DB.batch(Array.from({length: 32}, (_, i) => bindings.DB.prepare("INSERT INTO articles (id,slug,title,body_markdown,status,created_at,updated_at,published_at,creation_hash) VALUES (?,?,?,'body','published',?,?,?,'test')")
      .bind(crypto.randomUUID(), `post-${i}`, `title-${i}`, "2026-11-01T00:00:00.000Z", "2026-11-01T00:00:00.000Z", new Date(1793491200000 + i * 1000).toISOString())));
    const feed = new XMLParser().parse(await (await SELF.fetch(`${base}/feed.xml`)).text()); expect(feed.rss.channel.item).toHaveLength(30);
    expect((await (await SELF.fetch(`${base}/journal`)).text()).match(/<li>/g)).toHaveLength(20);
    expect((await (await SELF.fetch(`${base}/journal?page=2`)).text()).match(/<li>/g)).toHaveLength(12);
  });
  it("splits a sitemap after 1000 published articles", async () => {
    // Recursive SQL keeps the fixture fast and exercises the real D1 pagination.
    await bindings.DB.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1001)
      INSERT INTO articles (id,slug,title,body_markdown,status,created_at,updated_at,published_at,creation_hash)
      SELECT printf('sitemap-%04d',x),printf('map-%04d',x),'map','body','published','2026-11-01T00:00:00.000Z',
      '2026-11-01T00:00:00.000Z','2026-11-01T00:00:00.000Z','map' FROM n`).run();
    const index = await (await SELF.fetch(`${base}/sitemap.xml`)).text(); expect(XMLValidator.validate(index)).toBe(true);
    expect(index).toContain("sitemap-2.xml");
    const first = await SELF.fetch(`${base}/sitemap-1.xml`), second = await SELF.fetch(`${base}/sitemap-2.xml`);
    expect(first.status).toBe(200); expect(second.status).toBe(200);
    expect((await first.text()).match(/<url>/g)).toHaveLength(1001); // includes journal index
    expect((await second.text()).match(/<url>/g)).toHaveLength(2);
    expect((await SELF.fetch(`${base}/sitemap-3.xml`)).status).toBe(404);
  });
});

describe("authenticated Streamable HTTP MCP", () => {
  it("rejects unauthorized and cross-origin requests before MCP, including GET", async () => {
    for (const method of ["GET", "POST"]) {
      const response = await SELF.fetch(`${base}/mcp`, {method}); expect(response.status).toBe(401); expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
    expect((await SELF.fetch(`${base}/mcp`, {headers: {Authorization: `Bearer ${publisher}`, Origin: "https://evil.test"}})).status).toBe(403);
    expect((await SELF.fetch(`${base}/mcp`, {method: "POST", headers: {Authorization: `Bearer ${agent}`}, body: "x".repeat(262145)})).status).toBe(413);
  });
  it("discovers tools, creates/edits/reviews drafts, denies Agent publication and publishes with publisher credentials", async () => {
    let articleId = "", expectedUpdatedAt = "";
    await mcp(agent, async client => {
      expect((await client.listTools()).tools.map(t => t.name).sort()).toEqual(["create_draft", "get_article", "list_articles", "publish_article", "update_draft"]);
      const receipt = await call(client, "create_draft", {...draft, idempotencyKey: "mcp-daily"}); articleId = receipt.articleId;
      expect(receipt).toMatchObject({status: "draft", public: false, isError: false});
      expect((await call(client, "get_article", {articleId})).bodyMarkdown).toBe(draft.bodyMarkdown);
      const edited = await call(client, "update_draft", {articleId, expectedUpdatedAt: receipt.updatedAt, title: "reviewed"});
      expectedUpdatedAt = edited.updatedAt;
      expect((await call(client, "publish_article", {articleId, expectedUpdatedAt, confirmPublication: true}))).toMatchObject({error: "publication_forbidden", isError: true});
      expect((await call(client, "list_articles", {status: "draft"})).articles).toHaveLength(1);
    });
    await mcp(publisher, async client => {
      const args = {articleId, expectedUpdatedAt, confirmPublication: true};
      const publication = await call(client, "publish_article", args); expect(publication.status).toBe("published");
      expect((await call(client, "publish_article", args)).publishedAt).toBe(publication.publishedAt);
      expect((await SELF.fetch(publication.canonicalUrl)).status).toBe(200);
    });
  });
  it("purges published resources on every idempotent publish and reports recoverable failures", async () => {
    const created = await store().create(draft); const purged: string[] = [];
    const handler = journalMcp(bindings, "publisher", async id => { purged.push(id); return purged.length === 3; });
    const request = new Request(`${base}/mcp`, {method: "POST", headers: {"Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-03-26"},
      body: JSON.stringify({jsonrpc: "2.0", id: 1, method: "tools/call", params: {name: "publish_article", arguments: {articleId: created.id, expectedUpdatedAt: created.updatedAt, confirmPublication: true}}})});
    for (let i = 0; i < 2; i++) {
      const response = await handler(request.clone(), bindings, {} as ExecutionContext);
      expect(await response.text()).toContain("pending_retry");
    }
    expect(await (await handler(request.clone(), bindings, {} as ExecutionContext)).text()).toContain("complete");
    expect(purged).toEqual([created.id, created.id, created.id]);
  });
  it("blocks publication of configured credentials even without a recognizable token prefix", async () => {
    const created = await store().create({title: "credential fixture", bodyMarkdown: publisher});
    await mcp(publisher, async client => {
      expect(await call(client, "publish_article", {articleId: created.id, expectedUpdatedAt: created.updatedAt, confirmPublication: true}))
        .toMatchObject({error: "sensitive_content", isError: true});
    });
  });
});
