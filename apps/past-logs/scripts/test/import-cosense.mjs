import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { backendUrl, documentFromPage, jsonClient, listPages, projectName, runImport } from "../import-cosense.mjs";

const project = "udzura-lofi-memo", target = "http://127.0.0.1:8788/", token = "test-importer-admin-token-0000000000000000";
const page = (index = 1, extra = {}) => ({id: index.toString(16).padStart(24, "0"), title: `日本語ページ${index}`,
  created: 1700000000, updated: 1700000001, lines: [{text: `日本語ページ${index}`}, {text: "Rubyと[内部リンク] #技術"},
    {text: "code:ruby"}, {text: "\tputs 'hello'"}, {text: ""}], ...extra});
const options = extra => ({project, target, token, delayMs: 0, ...extra});
async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), "niao-cosense-test-"));
  t.after(() => rm(directory, {recursive: true, force: true}));
  return join(directory, "checkpoint.json");
}
function fixture(pages, settings = {}) {
  const requests = [], writes = [], stored = new Map(), progress = [], sleeps = [];
  const fetchImpl = async (value, init = {}) => {
    const url = new URL(value); requests.push({url, ...init});
    if (url.origin === "https://scrapbox.io") {
      if (url.pathname === `/api/pages/${project}`) {
        const skip = Number(url.searchParams.get("skip")), limit = Number(url.searchParams.get("limit"));
        return Response.json({projectName: project, skip, limit, count: pages.length, pages: pages.slice(skip, skip + limit)});
      }
      const title = decodeURIComponent(url.pathname.slice(`/api/pages/${project}/`.length));
      const entry = pages.find(p => p.title === title);
      if (!entry || entry.id === settings.missingId) return Response.json({error: "not_found"}, {status: 404});
      return Response.json(entry);
    }
    if (url.origin !== new URL(target).origin || new Headers(init.headers).get("Authorization") !== `Bearer ${token}`) return Response.json({}, {status: 401});
    if (url.pathname === "/api/semantic-index") return Response.json({configured: true, pending: 0});
    if (url.pathname === "/api/documents" && init.method === "POST") {
      const document = JSON.parse(init.body);
      if (settings.failId && document.source_id.endsWith(settings.failId)) return Response.json({}, {status: 503});
      writes.push(document);
      const id = "doc_" + createHash("sha256").update(JSON.stringify([document.source, document.source_id])).digest("hex");
      stored.set(id, document);
      return Response.json({document: {id, ...document}, semantic_index: {status: settings.pending ? "pending" : "submitted"}});
    }
    return Response.json({}, {status: 404});
  };
  return {requests, writes, stored, progress, settings, dependencies: {fetchImpl, sleep: async ms => {sleeps.push(ms);},
    progress: entry => progress.push(entry)}, sleeps};
}

test("maps original lines, stable page identity, canonical URL and Unix timestamps", () => {
  const entry = page(1, {title: "Ruby / Wasm? #テスト"});
  const doc = documentFromPage(project, entry, entry);
  assert.equal(doc.source, "cosense"); assert.equal(doc.source_id, `${project}/${entry.id}`);
  assert.equal(doc.url, `https://scrapbox.io/${project}/Ruby%20%2F%20Wasm%3F%20%23%E3%83%86%E3%82%B9%E3%83%88`);
  assert.equal(doc.created_at, "2023-11-14T22:13:20.000Z"); assert.equal(doc.updated_at, "2023-11-14T22:13:21.000Z");
  assert.equal(doc.body, entry.lines.map(l => l.text).join("\n"));
  assert.equal(doc.metadata.format, "scrapbox");
  assert.equal(documentFromPage(project, {...entry, title: "before"}, {...entry, title: "after"}).source_id, doc.source_id);
});
test("fails malformed, mismatched, stale, and oversized pages without truncation", () => {
  const entry = page();
  for (const broken of [{...entry, id: "wrong"}, {...entry, lines: [{text: 1}]}, {...entry, created: "yesterday"},
    {...entry, updated: entry.updated - 1}, {...entry, lines: [{text: "😀".repeat(33000)}]}]) {
    assert.throws(() => documentFromPage(project, entry, broken));
  }
  assert.equal(documentFromPage(project, entry, {...entry, lines: []}).body, entry.title);
});
test("validates project URLs and secure backend roots", () => {
  assert.equal(projectName(`https://scrapbox.io/${project}/`), project);
  assert.equal(backendUrl("https://past-logs.example"), "https://past-logs.example/");
  for (const value of ["../project", "https://evil.example/project", `https://scrapbox.io/${project}/page`]) assert.throws(() => projectName(value));
  for (const value of ["http://remote.example", "https://token@past-logs.example", "https://past-logs.example/mcp", "https://past-logs.example/?token=secret"]) assert.throws(() => backendUrl(value));
});
test("lists every page through pagination and sorts by stable ID", async () => {
  const pages = Array.from({length: 101}, (_, i) => page(101 - i)), source = fixture(pages);
  const result = await listPages(project, jsonClient({fetchImpl: source.dependencies.fetchImpl, delayMs: 0}));
  assert.equal(result.length, 101); assert.equal(result[0].id, page(1).id);
  assert.deepEqual(source.requests.map(r => r.url.searchParams.get("skip")), ["0", "100"]);
});
test("retries inconsistent page snapshots and fails rather than hiding missing pages", async () => {
  let calls = 0;
  const result = await listPages(project, async () => {
    calls++;
    return {projectName: project, skip: 0, count: 2, pages: calls === 1 ? [page(1), page(1)] : [page(1), page(2)]};
  });
  assert.equal(calls, 2); assert.equal(result.length, 2);
  await assert.rejects(listPages(project, async () => ({projectName: project, skip: 0, count: 2, pages: [page(1), page(1)]})), /page_list_changed/);
});
test("list and dry-run modes require no credentials and never call Past Logs", async () => {
  const source = fixture([page(1), page(2)]);
  const listed = await runImport(options({list: true, token: undefined}), source.dependencies);
  assert.equal(listed.pages.length, 2); assert.equal(source.requests.length, 1);
  assert(listed.pages[0].url.startsWith("https://scrapbox.io/"));
  const dry = await runImport(options({dryRun: true, token: undefined, limit: 1}), source.dependencies);
  assert.equal(dry.summary.listed, 2); assert.equal(dry.summary.validated, 1); assert.equal(dry.summary.selected, 1);
  assert(source.requests.every(r => r.url.origin === "https://scrapbox.io")); assert.equal(source.writes.length, 0);
});
test("imports, atomically checkpoints and skips completed unchanged pages on rerun", async t => {
  const statePath = await temporary(t), source = fixture([page(1), page(2)]);
  const first = await runImport(options({statePath}), source.dependencies);
  assert.equal(first.summary.imported, 2); assert.equal(source.stored.size, 2);
  assert.equal((await stat(statePath)).mode & 0o777, 0o600);
  const checkpoint = await readFile(statePath, "utf8"); assert(!checkpoint.includes(token)); assert(!checkpoint.includes("puts"));
  const second = await runImport(options({statePath}), source.dependencies);
  assert.equal(second.summary.skipped, 2); assert.equal(second.summary.imported, 0); assert.equal(source.writes.length, 2);
  assert(source.requests.filter(r => r.url.origin === "https://scrapbox.io").every(r => !new Headers(r.headers).has("Authorization")));
  assert(source.requests.every(r => r.redirect === "error"));
});
test("renaming/updating a page and --force upsert the same source ID", async t => {
  const statePath = await temporary(t), pages = [page()], source = fixture(pages);
  await runImport(options({statePath}), source.dependencies);
  pages[0].title = "改名したページ"; pages[0].updated++;
  const update = await runImport(options({statePath}), source.dependencies);
  assert.equal(update.summary.imported, 1); assert.equal(source.stored.size, 1);
  assert.equal(source.writes[0].source_id, source.writes[1].source_id); assert.notEqual(source.writes[0].url, source.writes[1].url);
  assert.equal((await runImport(options({statePath, force: true}), source.dependencies)).summary.imported, 1);
});
test("preserves successful checkpoints on interruption and resumes remaining pages", async t => {
  const statePath = await temporary(t), pages = [page(1), page(2)], source = fixture(pages, {failId: page(2).id});
  await assert.rejects(runImport(options({statePath}), source.dependencies), /http_503/);
  assert.deepEqual(Object.keys(JSON.parse(await readFile(statePath, "utf8")).pages), [page(1).id]);
  source.settings.failId = undefined;
  const resumed = await runImport(options({statePath}), source.dependencies);
  assert.equal(resumed.summary.skipped, 1); assert.equal(resumed.summary.imported, 1); assert.equal(source.stored.size, 2);
});
test("reports pending semantic indexing while checkpointing successful D1 imports", async t => {
  const statePath = await temporary(t), source = fixture([page()], {pending: true});
  const first = await runImport(options({statePath}), source.dependencies);
  assert.equal(first.summary.imported, 1); assert.equal(first.summary.pending, 1);
  assert.equal((await runImport(options({statePath}), source.dependencies)).summary.skipped, 1);
});
test("reports a missing source page and continues without checkpointing it", async t => {
  const statePath = await temporary(t), source = fixture([page(1), page(2)], {missingId: page(1).id});
  const result = await runImport(options({statePath}), source.dependencies);
  assert.equal(result.summary.failed, 1); assert.equal(result.summary.imported, 1);
  assert(!JSON.parse(await readFile(statePath, "utf8")).pages[page(1).id]);
});
test("rejects checkpoints for a different destination or malformed entries", async t => {
  const statePath = await temporary(t), source = fixture([page()]);
  for (const state of [{version: 1, project, target: "https://other.example/", pages: {}},
    {version: 1, project, target, pages: {[page().id]: {title: "x", updated: 1700000001}}}]) {
    await writeFile(statePath, JSON.stringify(state));
    await assert.rejects(runImport(options({statePath}), source.dependencies), /checkpoint/);
  }
  assert.equal(source.writes.length, 0);
});
test("backs off transient failures and Retry-After, but never retries auth failures", async () => {
  const sleeps = []; let calls = 0;
  const request = jsonClient({delayMs: 0, sleep: async ms => sleeps.push(ms), fetchImpl: async () => {
    calls++; return calls === 1 ? new Response("private error", {status: 429, headers: {"Retry-After": "3"}}) : Response.json({ok: true});
  }});
  assert.deepEqual(await request("https://example.test"), {ok: true}); assert.deepEqual(sleeps, [3000]);
  calls = 0;
  const auth = jsonClient({delayMs: 0, fetchImpl: async () => {calls++; return new Response("credentials must not be printed", {status: 401});}});
  await assert.rejects(auth("https://example.test"), /http_401/); assert.equal(calls, 1);
  const later = jsonClient({delayMs: 0, fetchImpl: async () => new Response("", {status: 429, headers: {"Retry-After": "3600"}})});
  await assert.rejects(later("https://example.test"), /http_429/);
});
