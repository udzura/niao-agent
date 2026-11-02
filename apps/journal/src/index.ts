import { WorkerEntrypoint } from "cloudflare:workers";
import { JournalError, journalLog, safeCode } from "./core/validation";
import { authorize, boundedRequest, journalMcp } from "./mcp";
import { publicApp, securityHeaders, site, type JournalEnv } from "./public";

// This entrypoint must remain public-only: it has a platform cache BEFORE fetch.
export class PublicContent extends WorkerEntrypoint<JournalEnv> {
  fetch(request: Request) { return publicApp.fetch(request, this.env, this.ctx); }
  async purgePublication(articleId: string): Promise<boolean> {
    if (!/^[a-f0-9-]{36}$/.test(articleId)) return false;
    if (!this.ctx.cache) return false; // Local workerd does not implement Workers Cache.
    // RPC executes inside PublicContent's cache scope, even when called by the gateway.
    const result = await this.ctx.cache.purge({tags: ["journal-collections", `journal-article-${articleId}`]});
    return result.success;
  }
}
export function prefersMarkdown(accept: string | null): boolean {
  const media = (accept ?? "").toLowerCase().split(",").map(part => {
    const [type, ...parameters] = part.trim().split(";");
    const raw = parameters.map(p => p.trim()).find(p => p.startsWith("q="))?.slice(2);
    const q = raw === undefined ? 1 : Number(raw);
    return {type: type.trim(), q: Number.isFinite(q) && q >= 0 && q <= 1 ? q : 0};
  });
  const markdown = Math.max(0, ...media.filter(m => m.type === "text/markdown").map(m => m.q));
  const html = media.find(m => m.type === "text/html")?.q ?? media.find(m => m.type === "text/*")?.q
    ?? media.find(m => m.type === "*/*")?.q ?? 0;
  return markdown > 0 && markdown >= html;
}
export function publicRequest(request: Request, env: JournalEnv) {
  const url = new URL(request.url), origin = site(env).url;
  const path = url.pathname;
  if (path === "/journal") {
    const page = url.searchParams.get("page") ?? "1";
    if (!/^[1-9]\d{0,3}$/.test(page)) throw new JournalError("invalid_page");
    return new Request(`${origin}/journal${page === "1" ? "" : `?page=${Number(page)}`}`, {method: request.method, redirect: "manual"});
  }
  if (![/^\/$/, /^\/journal\/[a-z0-9][a-z0-9-]{0,99}(?:\.md)?$/, /^\/(?:feed|sitemap|sitemap-[1-9]\d{0,4})\.xml$/, /^\/(?:robots|llms)\.txt$/].some(pattern => pattern.test(path)))
    throw new JournalError("not_found", 404);
  const negotiated = /^\/journal\/[a-z0-9-]+$/.test(path) && prefersMarkdown(request.headers.get("Accept"));
  // Forward neither credentials/cookies nor host/method override headers into the cache.
  return new Request(`${origin}${path}${negotiated ? ".md" : ""}`, {method: request.method, redirect: "manual"});
}
const privateResponse = (response: Response) => {
  const headers = new Headers(response.headers); headers.set("Cache-Control", "no-store");
  headers.delete("Cache-Tag");
  return new Response(response.body, {status: response.status, headers});
};
export default {
  async fetch(request: Request, env: JournalEnv, ctx: ExecutionContext): Promise<Response> {
    try {
      const content = (ctx.exports as unknown as {PublicContent: Service<PublicContent>}).PublicContent;
      if (new URL(request.url).pathname === "/mcp") {
        const role = await authorize(request, env);
        const response = await journalMcp(env, role, id => content.purgePublication(id))(await boundedRequest(request), env, ctx);
        return privateResponse(response);
      }
      if (!["GET", "HEAD"].includes(request.method)) return new Response("Method not allowed", {status: 405, headers: {"Cache-Control": "no-store", Allow: "GET, HEAD"}});
      const internal = publicRequest(request, env), privateRead = request.headers.has("Authorization") || request.headers.has("Cookie");
      const response = await content.fetch(internal, privateRead ? {cache: "no-store"} : undefined);
      const headers = new Headers(response.headers);
      if (/^\/journal\/[a-z0-9-]+$/.test(new URL(request.url).pathname)) headers.set("Vary", "Accept");
      const output = new Response(request.method === "HEAD" ? null : response.body, {status: response.status, headers});
      return privateRead ? privateResponse(output) : output;
    } catch (error) {
      const code = safeCode(error); journalLog("request_error", {code});
      return Response.json({error: code}, {status: error instanceof JournalError ? error.status : 503,
        headers: {"Cache-Control": "no-store", ...securityHeaders, ...(error instanceof JournalError && error.status === 401 ? {"WWW-Authenticate": "Bearer"} : {})}});
    }
  },
} satisfies ExportedHandler<JournalEnv>;
