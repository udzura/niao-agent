import { SELF, env, applyD1Migrations, reset } from "cloudflare:test";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { Articles } from "../src/core/articles";
import journalWorker, {requireReviewAccess} from "../src/index";

const bindings = env as any, base = "https://journal.example.org";
const token = "journal-agent-token-0000000000000000000";
beforeEach(async () => { await applyD1Migrations(bindings.DB, bindings.TEST_MIGRATIONS); });
afterEach(async () => { await reset(); });
const post = (path: string, body: string, cookie?: string, origin = base) => SELF.fetch(`${base}${path}`, {
  method: "POST", redirect: "manual", headers: {Origin: origin, "Content-Type": "application/x-www-form-urlencoded", ...(cookie ? {Cookie: cookie} : {})}, body,
});
async function login() {
  const response = await post("/review/login", new URLSearchParams({token}).toString());
  expect(response.status).toBe(303);
  const header = response.headers.get("Set-Cookie")!;
  expect(header).toContain("HttpOnly"); expect(header).toContain("SameSite=Strict"); expect(header).toContain("Secure");
  expect(header).not.toContain(token);
  return header.split(";")[0];
}
const read = (path: string, cookie?: string) => SELF.fetch(`${base}${path}`, {redirect: "manual", headers: cookie ? {Cookie: cookie} : {}});
it("requires browser login without revealing draft titles or bodies, including HEAD", async () => {
  const article = await new Articles(bindings.DB).create({title: "private title", bodyMarkdown: "private body"});
  for (const path of ["/review", `/review/articles/${article.id}`]) {
    const response = await read(path); expect(response.status).toBe(303); expect(response.headers.get("Location")).toContain("/review/login");
    expect(response.headers.get("Cache-Control")).toBe("no-store"); expect(await response.text()).not.toContain("private");
  }
  const head = await SELF.fetch(`${base}/review`, {method: "HEAD", redirect: "manual"}); expect(head.status).toBe(303);
  const page = await read("/review/login"); expect(await page.text()).toContain('type="password"');
  expect((await post("/review/login", "token=wrong")).status).toBe(401);
  expect((await post("/review/login", new URLSearchParams({token}).toString(), undefined, "https://evil.example")).status).toBe(403);
  expect((await post("/review/login", "x=" + "x".repeat(4096))).status).toBe(413);
});
it("renders a private HTML preview, escaped Markdown source and provenance without publishing", async () => {
  const article = await new Articles(bindings.DB).create({title: "Title <unsafe>", description: "Review description", bodyMarkdown: "## 気づき\n\n<script>alert(1)</script>\n\n![track](https://example.org/pixel)\n[x](javascript:alert(1))",
    sources: [{sourceType: "message", sourceRef: "private-message-id"}, {sourceType: "url", sourceRef: "internal-url-ref", title: "Reference", url: "https://example.org/reference", public: true}]});
  const cookie = await login();
  const list = await read("/review", cookie); expect(await list.text()).toContain(`/review/articles/${article.id}`);
  const response = await read(`/review/articles/${article.id}`, cookie), html = await response.text();
  expect(response.status).toBe(200); expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(response.headers.get("X-Robots-Tag")).toContain("noindex"); expect(response.headers.get("Cache-Tag")).toBeNull();
  expect(response.headers.get("Content-Security-Policy")).toContain("form-action 'self'");
  for (const text of ["Title &lt;unsafe&gt;", "Review description", "<h2>気づき</h2>", "Markdown原文", "private-message-id", "Reference", "下書き・未公開"]) expect(html).toContain(text);
  for (const text of ["<script>", "<img", 'href="javascript:', 'rel="canonical"', "BlogPosting"]) expect(html).not.toContain(text);
  expect((await new Articles(bindings.DB).get({articleId: article.id})).status).toBe("draft");
  expect((await read(`/journal/${article.slug}`)).status).toBe(404);
  expect((await read(`/review/articles/${crypto.randomUUID()}`, cookie)).status).toBe(404);
});
it("rejects tampered cookies, rejects cross-origin logout and clears the session on logout", async () => {
  const cookie = await login();
  const forged = cookie.slice(0, -5) + "ABCDE";
  expect((await read("/review", forged)).status).toBe(303);
  expect((await read("/review", `${cookie}; ${cookie}`)).status).toBe(303);
  expect((await post("/review/logout", "", cookie, "https://evil.example")).status).toBe(403);
  const logout = await post("/review/logout", "", cookie); expect(logout.status).toBe(303);
  expect(logout.headers.get("Set-Cookie")).toContain("Max-Age=0");
  // Browser cookies never authorize authoring transports or state-changing review routes.
  expect((await read("/mcp", cookie)).status).toBe(401);
  expect((await post("/review/articles/example/publish", "", cookie)).status).toBe(404);
});
it("invalidates existing sessions when their signing credential rotates", async () => {
  const cookie = await login();
  const {reviewApp} = await import("../src/review");
  const rotated = {...bindings, JOURNAL_AGENT_TOKEN: "rotated-agent-token-00000000000000000000"};
  const response = await reviewApp.fetch(new Request(`${base}/review`, {headers: {Cookie: cookie}}), rotated);
  expect(response.status).toBe(303);
});
it("expires review sessions after one hour", async () => {
  const cookie = await login(), {reviewApp} = await import("../src/review");
  vi.useFakeTimers({toFake: ["Date"]});
  try {
    vi.setSystemTime(Date.now() + 3601000);
    expect((await reviewApp.fetch(new Request(`${base}/review`, {headers: {Cookie: cookie}}), bindings)).status).toBe(303);
  } finally { vi.useRealTimers(); }
});
it("supports opaque WebKit origins only with same-origin Fetch Metadata", async () => {
  for (const fetchSite of ["same-origin", "cross-site", "none"]) {
    const response = await SELF.fetch(`${base}/review/login`, {method: "POST", redirect: "manual",
      headers: {Origin: "null", "Sec-Fetch-Site": fetchSite, "Content-Type": "application/x-www-form-urlencoded"},
      body: new URLSearchParams({token}).toString()});
    expect(response.status).toBe(fetchSite === "same-origin" ? 303 : 403);
  }
});
it("requires the configured runtime Access audience on every review route", async () => {
  const protectedEnv = {...bindings, JOURNAL_REVIEW_ACCESS_AUD: "review-app-audience"};
  const forgedHeaders = {"Cf-Access-Jwt-Assertion": "forged", "Cf-Access-Authenticated-User-Email": "owner@example.org"};
  for (const path of ["/review", "/review/login", "/review/logout", `/review/articles/${crypto.randomUUID()}`]) {
    const response = await journalWorker.fetch(new Request(`${base}${path}`, {headers: forgedHeaders}), protectedEnv, {} as ExecutionContext);
    expect(response.status).toBe(403); expect(response.headers.get("Cache-Control")).toBe("no-store");
  }
  const wrong = await journalWorker.fetch(new Request(`${base}/review/login`), protectedEnv,
    {access: {aud: "unrelated-app"}} as ExecutionContext);
  expect(wrong.status).toBe(403);
  const allowed = await journalWorker.fetch(new Request(`${base}/review/login`), protectedEnv,
    {access: {aud: "review-app-audience"}} as ExecutionContext);
  expect(allowed.status).toBe(200); expect(await allowed.text()).toContain('type="password"');
  expect(() => requireReviewAccess({...protectedEnv, JOURNAL_REVIEW_ACCESS_AUD: ""}, {} as ExecutionContext)).toThrow("review_access_not_configured");
  // Enabling browser Access must leave the MCP bearer boundary unchanged.
  const mcp = await journalWorker.fetch(new Request(`${base}/mcp`), protectedEnv,
    {exports: {}} as ExecutionContext);
  expect(mcp.status).toBe(401); expect(await mcp.text()).toContain("unauthorized");
});
