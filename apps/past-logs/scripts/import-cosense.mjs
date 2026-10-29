import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export const DEFAULT_PROJECT = "udzura-lofi-memo";
const SOURCE = "https://scrapbox.io";
const PAGE_SIZE = 100;
const utf8 = text => Buffer.byteLength(text, "utf8");
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
class ImportError extends Error {
  constructor(code, status = 0) { super(code); this.code = code; this.status = status; }
}
export function projectName(value) {
  if (value.startsWith("https://")) {
    const url = new URL(value);
    if (url.origin !== SOURCE || url.username || url.password || url.search || url.hash) throw new ImportError("invalid_project_url");
    value = url.pathname.replace(/^\//, "").replace(/\/$/, "");
  }
  if (!/^[a-z0-9][a-z0-9_-]{0,99}$/.test(value)) throw new ImportError("invalid_project_name");
  return value;
}
export function backendUrl(value) {
  const url = new URL(value);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) ||
    url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new ImportError("invalid_past_logs_url");
  return url.href;
}
const canonicalUrl = (project, title) => `${SOURCE}/${project}/${encodeURIComponent(title)}`;
function timestamp(value) {
  if (value == null) return null;
  if (!Number.isInteger(value) || value < 0 || !Number.isFinite(new Date(value * 1000).getTime())) throw new ImportError("invalid_source_timestamp");
  return new Date(value * 1000).toISOString();
}
function pageSummary(page) {
  if (!page || typeof page.id !== "string" || !/^[a-f0-9]{24}$/.test(page.id) ||
    typeof page.title !== "string" || !page.title.trim() || !Number.isInteger(page.updated)) throw new ImportError("invalid_page_summary");
  return {id: page.id, title: page.title, updated: page.updated};
}
export function documentFromPage(project, summary, page) {
  if (page?.id !== summary.id || typeof page.title !== "string" || !page.title.trim() ||
    !Array.isArray(page.lines) || !page.lines.every(line => typeof line?.text === "string")) throw new ImportError("invalid_page_data");
  if (!Number.isInteger(page.updated) || page.updated < summary.updated) throw new ImportError("page_changed_during_import");
  // Preserve original Scrapbox notation, code indentation, links and blank lines.
  // It is reference text, never HTML/JavaScript to execute or a lossy Markdown conversion.
  const body = page.lines.map(line => line.text).join("\n") || page.title;
  const document = {source: "cosense", source_id: `${project}/${page.id}`, url: canonicalUrl(project, page.title),
    title: page.title, body, created_at: timestamp(page.created), updated_at: timestamp(page.updated),
    metadata: {project, page_id: page.id, format: "scrapbox", importer_version: 1}};
  // Keep these limits in sync with src/validation.ts. Never truncate source articles.
  if (document.title.length > 1024 || document.url.length > 2048 || utf8(body) > 128 * 1024 ||
    utf8(JSON.stringify(document)) > 256 * 1024) throw new ImportError("document_exceeds_past_logs_limits");
  return document;
}

export function jsonClient({fetchImpl = fetch, delayMs = 300, sleep = pause} = {}) {
  let lastRequest = 0;
  return async (url, init = {}, timeoutMs = 20000) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const wait = lastRequest + delayMs - Date.now();
      if (wait > 0) await sleep(wait);
      lastRequest = Date.now();
      let response;
      try { response = await fetchImpl(url, {...init, redirect: "error", signal: AbortSignal.timeout(timeoutMs)}); }
      catch {
        if (attempt === 2) throw new ImportError("network_or_timeout");
        await sleep(1000 * 2 ** attempt); continue;
      }
      if (response.ok) {
        try { return await response.json(); }
        catch { throw new ImportError("invalid_json_response"); }
      }
      const retryable = [408, 429, 500, 502, 503, 504].includes(response.status);
      const retryAfter = response.headers.get("Retry-After");
      const seconds = retryAfter ? /^\d+$/.test(retryAfter) ? Number(retryAfter) : Math.max(0, (Date.parse(retryAfter) - Date.now()) / 1000) : 0;
      await response.body?.cancel();
      if (seconds > 60 || !retryable || attempt === 2) throw new ImportError(`http_${response.status}`, response.status);
      await sleep(Math.max(1000 * 2 ** attempt, Number.isFinite(seconds) ? seconds * 1000 : 0));
    }
  };
}

export async function listPages(project, request) {
  // Collect the list BEFORE importing; API order may change as pages are edited.
  // Retry inconsistent pagination rather than silently declaring a partial list complete.
  for (let pass = 0; pass < 3; pass++) {
    const pages = new Map();
    let skip = 0, expected, inconsistent = false;
    while (true) {
      const value = await request(`${SOURCE}/api/pages/${project}?skip=${skip}&limit=${PAGE_SIZE}`);
      if (value.projectName !== project || value.skip !== skip || !Number.isSafeInteger(value.count) || value.count < 0 ||
        !Array.isArray(value.pages) || value.pages.length > PAGE_SIZE) throw new ImportError("invalid_page_list");
      expected ??= value.count;
      if (value.count !== expected) inconsistent = true;
      for (const page of value.pages) { const summary = pageSummary(page); pages.set(summary.id, summary); }
      skip += value.pages.length;
      if (skip >= value.count || value.pages.length === 0) break;
    }
    if (!inconsistent && pages.size === expected) return [...pages.values()].sort((a, b) => a.id.localeCompare(b.id));
  }
  throw new ImportError("page_list_changed_retry_later");
}

export function defaultStatePath(project, target) {
  const key = createHash("sha256").update(target).digest("hex").slice(0, 16);
  return fileURLToPath(new URL(`../.import-state/cosense-${project}-${key}.json`, import.meta.url));
}
async function loadState(path, project, target) {
  try {
    const state = JSON.parse(await readFile(path, "utf8"));
    if (state.version !== 1 || state.project !== project || state.target !== target || !state.pages || typeof state.pages !== "object" || Array.isArray(state.pages)) throw new ImportError("checkpoint_mismatch");
    if (Object.entries(state.pages).some(([id, page]) => !/^[a-f0-9]{24}$/.test(id) || !page ||
      typeof page.title !== "string" || !Number.isInteger(page.updated) || !/^doc_[a-f0-9]{64}$/.test(page.document_id))) throw new ImportError("checkpoint_unreadable");
    return state;
  } catch (error) {
    if (error.code === "ENOENT") return {version: 1, project, target, pages: {}};
    if (error instanceof ImportError) throw error;
    throw new ImportError("checkpoint_unreadable");
  }
}
async function saveState(path, state) {
  await mkdir(dirname(path), {recursive: true, mode: 0o700});
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, JSON.stringify(state) + "\n", {mode: 0o600, flag: "wx"}); await rename(temporary, path); }
  finally { await rm(temporary, {force: true}); }
}

export async function runImport(options = {}, dependencies = {}) {
  const project = projectName(options.project ?? DEFAULT_PROJECT);
  const request = jsonClient({fetchImpl: dependencies.fetchImpl, delayMs: options.delayMs ?? 300, sleep: dependencies.sleep});
  const progress = dependencies.progress ?? (entry => process.stderr.write(JSON.stringify(entry) + "\n"));
  const pages = await listPages(project, request);
  const selected = pages.slice(0, options.limit ?? pages.length);
  const result = {project, listed: pages.length, selected: selected.length, imported: 0, skipped: 0, validated: 0, pending: 0, failed: 0};
  progress({event: "cosense.listed", project, pages: pages.length, selected: selected.length});
  if (options.list) return {summary: result, pages: selected.map(p => ({...p, url: canonicalUrl(project, p.title)}))};
  const dryRun = Boolean(options.dryRun);
  const target = dryRun ? null : backendUrl(options.target ?? "http://127.0.0.1:8788");
  const token = options.token;
  if (!dryRun && (!token || token.length < 32)) throw new ImportError("set_PAST_LOGS_ADMIN_TOKEN");
  const path = options.statePath ?? (target ? defaultStatePath(project, target) : null);
  const state = dryRun ? null : await loadState(path, project, target);
  const headers = {Authorization: `Bearer ${token}`, "Content-Type": "application/json"};
  // Verify admin authorization and the correct Past Logs service before fetching bodies.
  if (!dryRun) await request(new URL("/api/semantic-index", target), {headers});
  for (const summary of selected) {
    const previous = state?.pages[summary.id];
    if (!options.force && previous?.updated === summary.updated && previous.title === summary.title) {
      result.skipped++; progress({event: "cosense.page", id: summary.id, status: "skipped"}); continue;
    }
    let phase = "source";
    try {
      const page = await request(`${SOURCE}/api/pages/${project}/${encodeURIComponent(summary.title)}`);
      const document = documentFromPage(project, summary, page);
      if (dryRun) {
        result.validated++; progress({event: "cosense.page", id: summary.id, status: "validated", bytes: utf8(document.body)}); continue;
      }
      phase = "backend";
      const imported = await request(new URL("/api/documents", target), {method: "POST", headers, body: JSON.stringify(document)}, 60000);
      if (!/^doc_[a-f0-9]{64}$/.test(imported.document?.id) || imported.document.source !== "cosense" || imported.document.source_id !== document.source_id) throw new ImportError("invalid_import_response");
      state.pages[page.id] = {title: page.title, updated: page.updated, document_id: imported.document.id};
      await saveState(path, state);
      result.imported++;
      const status = imported.semantic_index?.status ?? "unknown";
      if (status !== "submitted") result.pending++;
      progress({event: "cosense.page", id: page.id, status: "imported", semantic: status});
    } catch (error) {
      const code = error instanceof ImportError ? error.code : "local_import_error";
      progress({event: "cosense.page", id: summary.id, status: "failed", code}); result.failed++;
      if ([401, 403, 429].includes(error.status) || code === "network_or_timeout" || !(error instanceof ImportError) ||
        (phase === "backend" && (error.status >= 500 || error.status === 404 || code === "invalid_import_response"))) throw new ImportError(code, error.status);
    }
  }
  return {summary: result};
}

export async function main(args = process.argv.slice(2), env = process.env) {
  const {values} = parseArgs({args, options: {
    project: {type: "string", default: DEFAULT_PROJECT}, list: {type: "boolean"}, "dry-run": {type: "boolean"},
    limit: {type: "string"}, "delay-ms": {type: "string", default: "300"}, state: {type: "string"},
    force: {type: "boolean"}, help: {type: "boolean", short: "h"},
  }});
  if (values.help) {
    process.stdout.write("Usage: npm run import:cosense -- [--list | --dry-run] [--limit N] [--project NAME_OR_URL] [--force] [--state PATH] [--delay-ms N]\nDefaults: udzura-lofi-memo, sequential requests at least 300ms apart.\nImport requires PAST_LOGS_URL (default localhost:8788) and PAST_LOGS_ADMIN_TOKEN.\n"); return;
  }
  const limit = values.limit === undefined ? undefined : Number(values.limit), delayMs = Number(values["delay-ms"]);
  if ((limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) || !Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 60000 || (values.list && values["dry-run"])) throw new ImportError("invalid_options");
  const result = await runImport({project: values.project, list: values.list, dryRun: values["dry-run"], limit, delayMs,
    force: values.force, statePath: values.state ? resolve(values.state) : undefined, target: env.PAST_LOGS_URL, token: env.PAST_LOGS_ADMIN_TOKEN});
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  if (result.summary.pending) process.stderr.write("Semantic indexing is pending for some imports. Run npm run reindex -w apps/past-logs after fixing bindings/quota.\n");
  if (result.summary.failed) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    process.stderr.write(`Cosense import stopped: ${error instanceof ImportError ? error.code : "invalid_options_or_local_error"}. Completed checkpoints are preserved.\n`);
    process.exitCode = 1;
  });
}
