// Explicit live-service test. Import samples and drain indexing jobs first.
import assert from "node:assert/strict";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
const endpoint = new URL("/mcp", process.env.PAST_LOGS_URL ?? "http://127.0.0.1:8788");
const token = process.env.PAST_LOGS_READ_TOKEN;
if (!token || token.length < 32) throw new Error("Set PAST_LOGS_READ_TOKEN");
if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && ["127.0.0.1", "localhost"].includes(endpoint.hostname))) throw new Error("Use HTTPS outside loopback");
const client = new Client({name: "niao-semantic-smoke", version: "1.0.0"});
try {
  await client.connect(new StreamableHTTPClientTransport(endpoint, {
    requestInit: {headers: {Authorization: `Bearer ${token}`}, redirect: "error"},
  }));
  const {tools} = await client.listTools();
  assert(tools.some(t => t.name === "search_past_logs_semantic" && t.annotations.readOnlyHint));
  const response = await client.callTool({name: "search_past_logs_semantic",
    arguments: {query: "実行ごとに新しい処理系を用意して、前の実行の状態が残らないようにする話", limit: 5}});
  assert(!response.isError, "Semantic service failed; inspect bindings/index status");
  const hits = JSON.parse(response.content[0].text);
  assert(hits.length > 0, "No indexed documents visible yet. Check status, wait for Vectorize, and rerun.");
  assert(hits.some(h => h.url === "https://example.com/hatena/ruby-wasm"), "Expected Ruby VM sample among retrieved documents; inspect real retrieval quality");
  const read = await client.callTool({name: "get_past_log", arguments: {id: hits[0].id, limit: 100}});
  assert(!read.isError); assert(JSON.parse(read.content[0].text).url);
  console.log(`Live semantic MCP smoke passed (${hits.length} candidates; original URLs preserved)`);
} finally { await client.close(); }
