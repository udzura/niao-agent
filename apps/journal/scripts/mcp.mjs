import {Client, StreamableHTTPClientTransport} from "@modelcontextprotocol/client";

// Local authoring/review helper. The token is never placed in command-line arguments.
const endpoint = new URL(process.env.JOURNAL_MCP_URL ?? "http://127.0.0.1:8791/mcp");
const token = process.env.JOURNAL_MCP_TOKEN;
if (!token || token.length < 32 || endpoint.pathname !== "/mcp" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
    endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname))) {
  process.stderr.write("Set JOURNAL_MCP_URL and a JOURNAL_MCP_TOKEN of at least 32 characters.\n"); process.exit(1);
}
const name = process.argv[2] ?? "tools/list";
const client = new Client({name: "niao-journal-cli", version: "1.0.0"});
const transport = new StreamableHTTPClientTransport(endpoint, {requestInit: {redirect: "error"},
  fetch: async (input, init) => {
    const request = new Request(input, init);
    if (request.url !== endpoint.href) throw new Error("Unexpected endpoint");
    const headers = new Headers(request.headers); headers.set("Authorization", `Bearer ${token}`);
    return fetch(request, {headers, redirect: "error", signal: AbortSignal.timeout(20000)});
  },
});
try {
  await client.connect(transport);
  if (name === "tools/list") process.stdout.write(JSON.stringify(await client.listTools(), null, 2) + "\n");
  else {
    let body = "";
    for await (const chunk of process.stdin) { body += chunk; if (body.length > 262144) throw new Error("Input too large"); }
    const result = await client.callTool({name, arguments: JSON.parse(body || "{}")});
    for (const item of result.content) if (item.type === "text") process.stdout.write(item.text + "\n");
    if (result.isError) process.exitCode = 1;
  }
} catch { process.stderr.write("Journal MCP request failed. Check configuration and input.\n"); process.exitCode = 1; }
finally { await client.close().catch(() => {}); }
