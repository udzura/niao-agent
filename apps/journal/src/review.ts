import { Hono } from "hono";
import { Articles } from "./core/articles";
import { escape, renderMarkdown } from "./core/render";
import { JournalError, journalLog, safeCode } from "./core/validation";
import { authorize, boundedRequest, type AuthorRole } from "./mcp";
import { securityHeaders, site, type JournalEnv } from "./public";

const COOKIE = "niao_journal_review", LIFETIME = 3600;
const bytes = new TextEncoder();
const base64 = (data: Uint8Array) => btoa(String.fromCharCode(...data)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const decode = (value: string) => Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
async function signingKey(env: JournalEnv, role: AuthorRole) {
  const secret = role === "publisher" ? env.JOURNAL_PUBLISH_TOKEN : env.JOURNAL_AGENT_TOKEN;
  if (!secret || secret.length < 32) throw new JournalError("auth_not_configured", 503);
  return crypto.subtle.importKey("raw", bytes.encode(secret), {name: "HMAC", hash: "SHA-256"}, false, ["sign", "verify"]);
}
async function session(env: JournalEnv, role: AuthorRole) {
  const payload = base64(bytes.encode(JSON.stringify({v: 1, role, exp: Math.floor(Date.now() / 1000) + LIFETIME, nonce: crypto.randomUUID()})));
  const signature = await crypto.subtle.sign("HMAC", await signingKey(env, role), bytes.encode(`journal-review:${site(env).url}:${payload}`));
  return `${payload}.${base64(new Uint8Array(signature))}`;
}
async function authenticated(request: Request, env: JournalEnv) {
  const cookies = (request.headers.get("Cookie") ?? "").split(";").map(part => part.trim()).filter(part => part.startsWith(`${COOKIE}=`));
  if (cookies.length !== 1) return false;
  const value = cookies[0].slice(COOKIE.length + 1);
  if (value.length > 1024 || !/^[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+$/.test(value)) return false;
  try {
    const [payload, signature] = value.split("."), data = JSON.parse(new TextDecoder().decode(decode(payload)));
    if (data.v !== 1 || !["agent", "publisher"].includes(data.role) || !Number.isSafeInteger(data.exp) ||
        data.exp <= Date.now() / 1000 || data.exp > Date.now() / 1000 + LIFETIME) return false;
    return await crypto.subtle.verify("HMAC", await signingKey(env, data.role), decode(signature), bytes.encode(`journal-review:${site(env).url}:${payload}`));
  } catch { return false; }
}
function cookie(env: JournalEnv, value: string, maxAge: number) {
  return `${COOKIE}=${value}; Path=/review; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${site(env).url.startsWith("https:") ? "; Secure" : ""}`;
}
function page(title: string, body: string) {
  // Private pages intentionally contain no canonical, OpenGraph or public discovery metadata.
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow,noarchive"><title>${escape(title)} · Niao Journal review</title>
<style>:root{color-scheme:light dark;font-family:system-ui,sans-serif;line-height:1.8}body{max-width:48rem;margin:auto;padding:1.5rem}a{color:light-dark(#11618a,#89d0f3)}header,footer{padding:1rem 0;border-bottom:1px solid #8885}h1{line-height:1.5}article{overflow-wrap:anywhere}pre{white-space:pre-wrap;background:#8881;padding:1rem}blockquote{border-left:3px solid #8885;margin-left:0;padding-left:1rem}label{display:block}input{width:100%;box-sizing:border-box;padding:.7rem;margin:.5rem 0}button{padding:.5rem 1rem;cursor:pointer}nav{display:flex;gap:1rem}.notice{padding:1rem;background:#8882;border-left:3px solid #b87513}.meta{font-size:.9rem}details{margin:1rem 0}</style></head><body><header><a href="/review">Niao Journal — 下書き確認</a></header><main>${body}</main><footer><form method="post" action="/review/logout"><button>ログアウト</button></form></footer></body></html>`;
}
const loginPage = (failed = false) => page("ログイン", `<h1>下書きを確認する</h1><p>Journalの下書き用トークンを入力してください。公開用トークンでも閲覧できます。</p>${failed ? '<p role="alert">トークンを確認してください。</p>' : ""}<form method="post" action="/review/login"><label>トークン<input type="password" name="token" required maxlength="1024" autocomplete="off"></label><button>ログイン</button></form>`);

export const reviewApp = new Hono<{Bindings: JournalEnv}>();
reviewApp.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store"); c.header("X-Robots-Tag", "noindex, nofollow, noarchive");
  for (const [key, value] of Object.entries(securityHeaders)) c.header(key, value);
  c.header("Content-Security-Policy", securityHeaders["Content-Security-Policy"].replace("form-action 'none'", "form-action 'self'"));
  if (!["GET", "HEAD", "POST"].includes(c.req.method)) return c.text("Method not allowed", 405);
  const origin = c.req.header("Origin"), fetchSite = c.req.header("Sec-Fetch-Site");
  // Some WebKit form submissions have an opaque Origin. Accept only browser-
  // supplied same-origin Fetch Metadata in that case; never an arbitrary origin.
  const sameOrigin = origin === site(c.env).url || ((!origin || origin === "null") && fetchSite === "same-origin");
  if (c.req.method === "POST" && (!sameOrigin || fetchSite === "cross-site"))
    throw new JournalError("origin_forbidden", 403);
  if (c.req.path !== "/review/login" && !await authenticated(c.req.raw, c.env)) {
    if (c.req.method === "POST") return c.html(loginPage(), 401);
    return c.redirect("/review/login", 303);
  }
  await next();
});
reviewApp.get("/review/login", c => c.html(loginPage()));
reviewApp.post("/review/login", async c => {
  if (c.req.header("Content-Type")?.split(";")[0] !== "application/x-www-form-urlencoded") throw new JournalError("invalid_input");
  const input = new URLSearchParams(new TextDecoder().decode(await (await boundedRequest(c.req.raw, 4096)).arrayBuffer()));
  const headers = new Headers(c.req.raw.headers); headers.set("Authorization", `Bearer ${input.get("token") ?? ""}`);
  headers.delete("Origin"); // The review boundary already checked Origin/Fetch Metadata.
  let role: AuthorRole;
  try { role = await authorize(new Request(c.req.url, {headers}), c.env); }
  catch (error) {
    if (error instanceof JournalError && error.status === 401) return c.html(loginPage(true), 401);
    throw error;
  }
  c.header("Set-Cookie", cookie(c.env, await session(c.env, role), LIFETIME));
  return c.redirect("/review", 303);
});
reviewApp.post("/review/logout", c => {
  c.header("Set-Cookie", cookie(c.env, "", 0)); return c.redirect("/review/login", 303);
});
reviewApp.get("/review", async c => {
  const raw = c.req.query("page") ?? "1";
  if (!/^[1-9]\d{0,3}$/.test(raw)) throw new JournalError("invalid_page");
  const number = Number(raw), list = await new Articles(c.env.DB).list({status: "draft", page: number, limit: 20});
  return c.html(page("下書き一覧", `<h1>下書き一覧</h1><p>記事を開いて公開前の本文を確認できます。この画面からは公開しません。</p>${list.articles.length ? `<ol>${list.articles.map(a => `<li><a href="/review/articles/${a.id}">${escape(a.title)}</a><p class="meta">${a.journalDate ?? "日付指定なし"} · 更新 ${escape(a.updatedAt)}</p><p>${escape(a.description ?? "")}</p></li>`).join("")}</ol>` : "<p>下書きはありません。</p>"}<nav>${number > 1 ? `<a href="/review?page=${number - 1}">前のページ</a>` : ""}${list.hasMore ? `<a href="/review?page=${number + 1}">次のページ</a>` : ""}</nav>`));
});
reviewApp.get("/review/articles/:id", async c => {
  const article = await new Articles(c.env.DB).get({articleId: c.req.param("id")});
  return c.html(page(article.title, `<p><a href="/review">下書き一覧へ</a></p><aside class="notice">${article.status === "draft" ? "下書き・未公開" : "公開済み"} — 認証付きプレビューです。</aside><article><h1>${escape(article.title)}</h1><p class="meta">Niao${article.journalDate ? ` · 日記: ${article.journalDate}` : ""} · 更新: ${escape(article.updatedAt)}</p><p>${escape(article.description ?? "")}</p>${renderMarkdown(article.bodyMarkdown)}${article.sources.some(s => s.public) ? `<h2>公開される参考資料</h2><ul>${article.sources.filter(s => s.public && s.url).map(s => `<li><a rel="noreferrer noopener nofollow" href="${escape(s.url!)}">${escape(s.title ?? s.url!)}</a></li>`).join("")}</ul>` : ""}</article><details><summary>Markdown原文</summary><pre>${escape(article.bodyMarkdown)}</pre></details><details><summary>確認用のソース情報（非公開情報を含みます）</summary><pre>${escape(JSON.stringify(article.sources, null, 2))}</pre></details><p class="meta">記事ID: ${article.id}<br>確認した更新日時: ${escape(article.updatedAt)}</p>`));
});
reviewApp.notFound(c => c.text("Not found", 404));
reviewApp.onError((error, c) => {
  const code = safeCode(error); journalLog("review_error", {code});
  return c.html(page("確認できません", `<h1>下書きを表示できません</h1><p>${escape(code)}</p><a href="/review">一覧へ戻る</a>`), error instanceof JournalError ? error.status as 400 : code === "invalid_input" ? 400 : 503);
});
