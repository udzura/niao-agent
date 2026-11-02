import {version} from "../../../version.json";
import { routeAgentRequest } from "agents";
import { authenticated } from "./auth";
import type {NiaoAgent} from "./niao-agent";
import {consumeFetchJobs,type FetchJobMessage} from "./fetch-jobs";
export { NiaoAgent } from "./niao-agent";
export interface Env {
  TOOLS_MISC: Service<import("../../tools-misc/src/index").default>;
  RUBY_RUNNER: Service<import("../../ruby-runner/src/index").default>;
  NiaoAgent: DurableObjectNamespace<NiaoAgent>;
  FETCH_JOBS?: Queue<FetchJobMessage>;
  AI: Ai;
  NIAO_TOKEN: string;
  CHAT_RETENTION_DAYS?: string;
  CF_ACCOUNT_ID?: string;
  CF_ANALYTICS_TOKEN?: string;
  PAST_LOGS_MCP_URL?: string;
  PAST_LOGS_MCP_TOKEN?: string;
  JOURNAL?: Fetcher;
  JOURNAL_ENABLED?: string;
  JOURNAL_AGENT_TOKEN?: string;
  JOURNAL_PUBLISH_TOKEN?: string;
  JOURNAL_TARGET_LENGTH?: string;
}
export default {
  queue: consumeFetchJobs,
  async fetch(request: Request, env: Env): Promise<Response> {
    // Authenticate before routing, including upgrade requests and health checks.
    if (!env.NIAO_TOKEN || env.NIAO_TOKEN.length < 32) return new Response("Server is not configured", {status: 503});
    if (!await authenticated(request, env.NIAO_TOKEN)) return new Response("Unauthorized", {status: 401, headers: {"WWW-Authenticate": "Bearer"}});
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") return Response.json({ok: true, protocol: 1, version}, {headers: {"Cache-Control": "no-store"}});
    // One identity only; arbitrary URLs must not create additional billable agents.
    const sessionRoute=/^\/agents\/niao-agent\/personal\/sessions(?:\/[a-zA-Z0-9-]+(?:\/history)?)?$/.test(url.pathname);
    const journalRoute=/^\/agents\/niao-agent\/personal\/journal(?:\/generate|\/articles(?:\/[a-f0-9-]{36}(?:\/publish)?)?)?$/.test(url.pathname);
    if (!sessionRoute && !journalRoute && !["/agents/niao-agent/personal", "/agents/niao-agent/personal/history", "/agents/niao-agent/personal/usage", "/agents/niao-agent/personal/platform-usage", "/agents/niao-agent/personal/settings", "/agents/niao-agent/personal/jobs"].includes(url.pathname)) return new Response("Not found", {status: 404});
    const allowed = journalRoute ? [url.pathname.endsWith("/generate") || url.pathname.endsWith("/publish") ? "POST" : "GET"] : sessionRoute ? ["GET","POST","PATCH","DELETE"] : url.pathname.endsWith("/settings") ? ["GET", "PUT"]
      : url.pathname.endsWith("/history") ? ["GET", "DELETE"] : ["GET"];
    if (!allowed.includes(request.method)) return new Response("Method not allowed", {status: 405, headers: {Allow: allowed.join(", ")}});
    const upgrade = request.headers.get("Upgrade")?.toLowerCase() === "websocket";
    if (upgrade && url.pathname !== "/agents/niao-agent/personal") return new Response("Not found", {status: 404});
    return await routeAgentRequest(request, env) ?? new Response("Not found", {status: 404});
  },
} satisfies ExportedHandler<Env>;
