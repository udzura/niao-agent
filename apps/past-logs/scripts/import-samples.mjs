import { readFile } from "node:fs/promises";

const endpoint = new URL(process.env.PAST_LOGS_URL ?? "http://127.0.0.1:8788");
const token = process.env.PAST_LOGS_ADMIN_TOKEN;
if (!token || token.length < 32) throw new Error("Set PAST_LOGS_ADMIN_TOKEN (at least 32 characters)");
if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && ["127.0.0.1", "localhost"].includes(endpoint.hostname))) {
  throw new Error("Use HTTPS outside loopback");
}
const documents = JSON.parse(await readFile(new URL("../samples/documents.json", import.meta.url), "utf8"));
for (const document of documents) {
  const response = await fetch(new URL("/api/documents", endpoint), {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(60000),
    headers: {"Content-Type": "application/json", Authorization: `Bearer ${token}`}, body: JSON.stringify(document),
  });
  if (!response.ok) throw new Error(`Sample import failed: HTTP ${response.status}`);
  const {document: imported, semantic_index: index} = await response.json();
  console.log(`Imported sample ${imported.id}; semantic=${index?.status ?? "unknown"}${index?.error_code ? "; " + index.error_code : ""}`);
}
