// Drive the durable D1 outbox explicitly; no cron, queue, or hidden background job.
const base = new URL(process.env.PAST_LOGS_URL ?? "http://127.0.0.1:8788");
const token = process.env.PAST_LOGS_ADMIN_TOKEN;
if (!token || token.length < 32) throw new Error("Set PAST_LOGS_ADMIN_TOKEN");
if (base.protocol !== "https:" && !(base.protocol === "http:" && ["127.0.0.1", "localhost"].includes(base.hostname))) throw new Error("Use HTTPS outside loopback");
if (process.argv.slice(2).some(arg => arg !== "--force")) throw new Error("Usage: npm run reindex [-- --force]");
const maximum = Number(process.env.PAST_LOGS_INDEX_MAX_REQUESTS ?? "1000");
if (!Number.isInteger(maximum) || maximum < 1 || maximum > 10000) throw new Error("Invalid PAST_LOGS_INDEX_MAX_REQUESTS (1–10000)");
let after, force = process.argv.includes("--force"), completed = false;
for (let count = 0; count < maximum; count++) {
  const response = await fetch(new URL("/api/semantic-index/reindex", base), {method: "POST", redirect: "error",
    signal: AbortSignal.timeout(150000), headers: {Authorization: `Bearer ${token}`, "Content-Type": "application/json"},
    body: JSON.stringify({limit: 1, force, ...(after ? {after} : {})})});
  if (!response.ok) throw new Error(`Index maintenance failed: HTTP ${response.status}`);
  const page = await response.json();
  for (const result of page.results) {
    console.log(`${result.id}: ${result.status}, chunks=${result.chunks_submitted}/${result.chunk_count}`);
    if (result.error_code) throw new Error(`Index pending: ${result.error_code}. Fix the cause and rerun; D1 data is preserved.`);
  }
  if (page.has_more) after = page.next_after;
  else if (page.summary.pending > 0) { after = undefined; force = false; }
  else { completed = true; console.log("All indexing mutations submitted. Vectorize search visibility is eventual."); break; }
}
if (!completed) throw new Error("Request budget reached. Rerun to continue from persisted progress.");
