import assert from "node:assert/strict";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const endpoint = new URL("/mcp", process.env.PAST_LOGS_URL ?? "http://127.0.0.1:8788");
const token = process.env.PAST_LOGS_READ_TOKEN;
if (!token || token.length < 32) throw new Error("Set PAST_LOGS_READ_TOKEN (at least 32 characters)");
if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && ["127.0.0.1", "localhost"].includes(endpoint.hostname))) throw new Error("Use HTTPS outside loopback");
const client = new Client({name: "niao-past-logs-smoke", version: "1.0.0"});
try {
  await client.connect(new StreamableHTTPClientTransport(endpoint, {
    requestInit: {headers: {Authorization: `Bearer ${token}`}, redirect: "error"},
  }));
  const {tools} = await client.listTools();
  assert.deepEqual(tools.map(t => t.name).sort(), ["get_past_log", "search_past_logs", "search_past_logs_semantic"]);
  assert(tools.every(t => t.annotations.readOnlyHint));
  const search = await client.callTool({name: "search_past_logs", arguments: {query: "Cloudflare 日本語", limit: 5}});
  assert(!search.isError);
  const hits = JSON.parse(search.content[0].text);
  assert(hits.length > 0, "Import the sample dataset first");
  const article = await client.callTool({name: "get_past_log", arguments: {id: hits[0].id, limit: 100}});
  const page = JSON.parse(article.content[0].text);
  assert(!article.isError); assert(page.url); assert(page.created_at); assert([...page.body].length <= 100);
  console.log(`Past Logs HTTP/MCP smoke passed (${tools.length} read-only tools, ${hits.length} hits)`);
} finally { await client.close(); }
