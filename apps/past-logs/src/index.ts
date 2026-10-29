import { z } from "zod";
import { DocumentService } from "./documents";
import { pastLogsMcp } from "./mcp";
import { ApiError, idSchema, MAX_REQUEST_BYTES } from "./validation";
import { SemanticIndex, type SemanticBindings } from "./semantic";

export interface Env extends SemanticBindings {
  DB: D1Database;
  PAST_LOGS_ADMIN_TOKEN: string;
  PAST_LOGS_READ_TOKEN: string;
}
const json = (body: unknown, status = 200, headers: HeadersInit = {}) => Response.json(body, {
  status, headers: {"Cache-Control": "no-store", ...headers},
});
async function authorize(request: Request, env: Env, admin: boolean) {
  const secret = admin ? env.PAST_LOGS_ADMIN_TOKEN : env.PAST_LOGS_READ_TOKEN;
  if (!secret || secret.length < 32 || env.PAST_LOGS_ADMIN_TOKEN === env.PAST_LOGS_READ_TOKEN) {
    throw new ApiError(503, "not_configured", "Configure separate admin and read secrets (at least 32 characters)");
  }
  const token = request.headers.get("Authorization");
  if (!token?.startsWith("Bearer ") || token.length > 1024) throw new ApiError(401, "unauthorized", "Bearer token required");
  const bytes = new TextEncoder();
  const [a, b] = await Promise.all([crypto.subtle.digest("SHA-256", bytes.encode(secret)),
    crypto.subtle.digest("SHA-256", bytes.encode(token.slice(7)))]);
  if (!crypto.subtle.timingSafeEqual(a, b)) throw new ApiError(401, "unauthorized", "Invalid bearer token");
}
async function readJson(request: Request): Promise<unknown> {
  if (request.headers.get("Content-Type")?.split(";")[0].trim() !== "application/json") {
    throw new ApiError(415, "unsupported_media_type", "Use application/json");
  }
  if (Number(request.headers.get("Content-Length") ?? 0) > MAX_REQUEST_BYTES) throw new ApiError(413, "request_too_large", "JSON request exceeds 256 KiB");
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, "invalid_json", "JSON body required");
  let text = "", size = 0;
  const decoder = new TextDecoder("utf-8", {fatal: true, ignoreBOM: false});
  try {
    while (true) {
      const {value, done} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_REQUEST_BYTES) {
        await reader.cancel(); throw new ApiError(413, "request_too_large", "JSON request exceeds 256 KiB");
      }
      text += decoder.decode(value, {stream: true});
    }
    return JSON.parse(text + decoder.decode());
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, "invalid_json", "Invalid UTF-8 JSON");
  } finally { reader.releaseLock(); }
}
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      const path = new URL(request.url).pathname;
      if (path === "/health" && request.method === "GET") return json({ok: true, service: "niao-past-logs"});
      if (path === "/mcp") {
        await authorize(request, env, false);
        const response = await pastLogsMcp(new DocumentService(env.DB), new SemanticIndex(env.DB, env))(request, env, ctx);
        const headers = new Headers(response.headers); headers.set("Cache-Control", "no-store");
        return new Response(response.body, {status: response.status, headers});
      }
      if (path === "/api/semantic-index" || path === "/api/semantic-index/reindex") {
        await authorize(request, env, true);
        const index = new SemanticIndex(env.DB, env);
        if (path === "/api/semantic-index" && request.method === "GET") return json(await index.summary());
        if (path.endsWith("/reindex") && request.method === "POST") return json(await index.reindex(await readJson(request)));
        return json({error: {code: "method_not_allowed", message: "Method not allowed"}}, 405);
      }
      const match = /^\/api\/documents(?:\/(doc_[a-f0-9]{64}))?$/.exec(path);
      if (!match) return json({error: {code: "not_found", message: "Not found"}}, 404);
      await authorize(request, env, true);
      const documents = new DocumentService(env.DB), index = new SemanticIndex(env.DB, env), id = match[1];
      if (!id && request.method === "POST") {
        const document = await documents.upsert(await readJson(request));
        return json({document, semantic_index: await index.sync(document.id)});
      }
      if (id) {
        idSchema.parse(id);
        if (request.method === "GET") {
          const document = await documents.get(id);
          if (!document) throw new ApiError(404, "not_found", "Document not found");
          return json({document});
        }
        if (request.method === "PUT") {
          const document = await documents.update(id, await readJson(request));
          return json({document, semantic_index: await index.sync(id)});
        }
        if (request.method === "DELETE") return json({...await documents.delete(id), semantic_index: await index.sync(id)});
      }
      return json({error: {code: "method_not_allowed", message: "Method not allowed"}}, 405,
        {Allow: id ? "GET, PUT, DELETE" : "POST"});
    } catch (error) {
      if (error instanceof ApiError) return json({error: {code: error.code, message: error.message}}, error.status,
        error.status === 401 ? {"WWW-Authenticate": "Bearer"} : {});
      if (error instanceof z.ZodError) return json({error: {code: "invalid_input", message: "Invalid document or input limits exceeded",
        fields: error.issues.map(issue => issue.path.join("."))}}, 400);
      console.warn(JSON.stringify({event: "past_logs.error", code: "internal_error"}));
      return json({error: {code: "internal_error", message: "Document service unavailable"}}, 500);
    }
  },
} satisfies ExportedHandler<Env>;
