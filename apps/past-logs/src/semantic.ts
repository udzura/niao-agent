import { Embeddings, EMBEDDING_BATCH, EMBEDDING_DIMENSIONS, EMBEDDING_MODEL, INDEX_VERSION, chunkDocument, vectorId } from "./embeddings";
import { ApiError, reindexInput, semanticSearchInput } from "./validation";

export type SemanticBindings = {AI?: Ai; VECTORIZE?: Vectorize};
type Job = {
  document_id: string; revision: string; operation: "upsert" | "delete";
  status: "pending" | "submitted"; index_version: string; next_chunk: number; chunk_count: number;
  cleanup_after: string; last_error: string | null; mutation_id: string | null;
  lease_until: number | null;
};
type IndexDocument = {id: string; title: string; body: string; source: string; semantic_revision: string};
const MAX_BATCHES = 4;
const CLEANUP_BATCH = 256;

// Binding RPCs cannot all be cancelled. Bound our wait, retain every planned
// vector ID in D1, and fence search results against the current D1 revision.
async function call<T>(operation: () => Promise<T>, signal: AbortSignal, code: string): Promise<T> {
  if (signal.aborted) throw new ApiError(503, "semantic_timeout", "Semantic operation timed out");
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(new ApiError(503, "semantic_timeout", "Semantic operation timed out"));
    signal.addEventListener("abort", abort, {once: true});
    if (signal.aborted) abort();
  });
  try { return await Promise.race([operation(), cancelled]); }
  catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(503, code, "Semantic index service unavailable");
  } finally { signal.removeEventListener("abort", abort); }
}

export class SemanticIndex {
  constructor(private db: D1Database, private bindings: SemanticBindings) {}
  get configured() { return Boolean(this.bindings.AI && this.bindings.VECTORIZE); }
  private async job(id: string) {
    return this.db.prepare("SELECT * FROM semantic_jobs WHERE document_id = ?").bind(id).first<Job>();
  }
  private state(job: Job | null, error?: string) {
    return {status: job?.status ?? "pending", chunks_submitted: job?.next_chunk ?? 0,
      chunk_count: job?.chunk_count ?? 0, mutation_id: job?.mutation_id ?? null,
      error_code: error ?? job?.last_error ?? null};
  }
  private async assertCurrent(job: Job, token: string) {
    const current = await this.db.prepare(`SELECT 1 AS ok FROM semantic_jobs
      WHERE document_id=? AND revision=? AND lease_token=? AND lease_until>?`)
      .bind(job.document_id, job.revision, token, Date.now()).first();
    if (!current) throw new ApiError(409, "index_superseded", "Document changed during indexing");
  }
  async sync(id: string, force = false) {
    if (!this.configured) return this.state(await this.job(id), "semantic_not_configured");
    const token = crypto.randomUUID(), now = Date.now();
    const job = await this.db.prepare(`UPDATE semantic_jobs SET lease_token=?, lease_until=?, attempts=attempts+1,
        next_chunk=CASE WHEN index_version<>? OR ? THEN 0 ELSE next_chunk END,
        cleanup_after=CASE WHEN index_version<>? OR ? THEN '' ELSE cleanup_after END,
        index_version=?, status='pending', last_error=NULL
      WHERE document_id=? AND (lease_until IS NULL OR lease_until<?)
        AND (status='pending' OR index_version<>? OR ?)
      RETURNING *`)
      .bind(token, now + 120_000, INDEX_VERSION, force ? 1 : 0, INDEX_VERSION, force ? 1 : 0,
        INDEX_VERSION, id, now, INDEX_VERSION, force ? 1 : 0).first<Job>();
    if (!job) {
      const current = await this.job(id);
      return this.state(current, current?.lease_until && current.lease_until > now ? "index_busy" : undefined);
    }
    const signal = AbortSignal.timeout(25_000);
    try {
      if (job.operation === "upsert") await this.upsert(job, token, signal);
      else await this.cleanup(job, token, signal);
    } catch (error) {
      const code = error instanceof ApiError ? error.code : "index_unavailable";
      console.warn(JSON.stringify({event: "past_logs.index", code, operation: job.operation}));
      await this.db.prepare(`UPDATE semantic_jobs SET last_error=? WHERE document_id=? AND revision=? AND lease_token=?`)
        .bind(code, id, job.revision, token).run();
    } finally {
      await this.db.prepare(`UPDATE semantic_jobs SET lease_token=NULL, lease_until=NULL,
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE document_id=? AND lease_token=?`).bind(id, token).run();
    }
    return this.state(await this.job(id));
  }
  private async upsert(job: Job, token: string, signal: AbortSignal) {
    const doc = await this.db.prepare(`SELECT id,title,body,source,semantic_revision FROM documents WHERE id=?`)
      .bind(job.document_id).first<IndexDocument>();
    if (!doc || doc.semantic_revision !== job.revision) throw new ApiError(409, "index_superseded", "Document changed during indexing");
    const chunks = chunkDocument(doc.title, doc.body);
    const ids = await Promise.all(chunks.map(c => vectorId(doc.id, job.revision, c.index)));
    // Track IDs BEFORE external writes, including an interrupted/uncertain upsert.
    await this.db.prepare(`INSERT OR IGNORE INTO semantic_chunks
        (id,document_id,revision,index_version,chunk_index,start_offset,end_offset)
      SELECT json_extract(value,'$.id'),?,?,?,json_extract(value,'$.index'),
        json_extract(value,'$.start'),json_extract(value,'$.end') FROM json_each(?)`)
      .bind(doc.id, job.revision, INDEX_VERSION,
        JSON.stringify(chunks.map((c, i) => ({id: ids[i], index: c.index, start: c.start, end: c.end})))).run();
    await this.db.prepare(`UPDATE semantic_jobs SET chunk_count=? WHERE document_id=? AND revision=? AND lease_token=?`)
      .bind(chunks.length, doc.id, job.revision, token).run();
    const embeddings = new Embeddings(this.bindings.AI!);
    let next = job.next_chunk;
    for (let batch = 0; next < chunks.length && batch < MAX_BATCHES; batch++) {
      await this.assertCurrent(job, token);
      const selected = chunks.slice(next, next + EMBEDDING_BATCH);
      const vectors = await call(() => embeddings.embed(selected.map(c => c.text), "document", signal), signal, "embedding_unavailable");
      await this.assertCurrent(job, token);
      const result = await call(() => this.bindings.VECTORIZE!.upsert(selected.map((c, i) => ({
        id: ids[c.index], values: vectors[i], namespace: INDEX_VERSION,
        metadata: {source: doc.source, document_id: doc.id, revision: job.revision},
      }))), signal, "vector_upsert_unavailable");
      next += selected.length;
      await this.db.prepare(`UPDATE semantic_jobs SET next_chunk=?, mutation_id=?
        WHERE document_id=? AND revision=? AND lease_token=?`)
        .bind(next, result.mutationId, doc.id, job.revision, token).run();
    }
    if (next === chunks.length) await this.cleanup(job, token, signal);
  }
  private async cleanup(job: Job, token: string, signal: AbortSignal) {
    await this.assertCurrent(job, token);
    const retired = await this.db.prepare(`SELECT id FROM semantic_chunks WHERE document_id=? AND id>?
      ${job.operation === "upsert" ? "AND (revision<>? OR index_version<>?)" : ""}
      ORDER BY id LIMIT ?`)
      .bind(job.document_id, job.cleanup_after, ...(job.operation === "upsert" ? [job.revision, INDEX_VERSION] : []), CLEANUP_BATCH)
      .all<{id: string}>();
    let mutationId = job.mutation_id;
    if (retired.results.length) {
      const result = await call(() => this.bindings.VECTORIZE!.deleteByIds(retired.results.map(c => c.id)), signal, "vector_delete_unavailable");
      mutationId = result.mutationId;
    }
    // Submitted is an acknowledgement, not a claim of Vectorize read-after-write consistency.
    await this.db.prepare(`UPDATE semantic_jobs SET status=?, cleanup_after=?, mutation_id=COALESCE(?,mutation_id), last_error=NULL
      WHERE document_id=? AND revision=? AND lease_token=?`)
      .bind(retired.results.length < CLEANUP_BATCH ? "submitted" : "pending", retired.results.at(-1)?.id ?? job.cleanup_after,
        mutationId, job.document_id, job.revision, token).run();
  }
  async summary() {
    const counts = await this.db.prepare(`SELECT COUNT(*) AS total,
      COALESCE(SUM(status='pending' OR index_version<>?),0) AS pending,
      COALESCE(SUM(last_error IS NOT NULL),0) AS failed FROM semantic_jobs`).bind(INDEX_VERSION).first();
    return {configured: this.configured, model: EMBEDDING_MODEL, dimensions: EMBEDDING_DIMENSIONS, index_version: INDEX_VERSION,
      ...counts, visibility: "eventual"};
  }
  async reindex(input: unknown) {
    const {limit, after, force} = reindexInput.parse(input);
    if (!this.configured) throw new ApiError(503, "semantic_not_configured", "Configure AI and VECTORIZE bindings");
    const jobs = await this.db.prepare(`SELECT document_id FROM semantic_jobs WHERE document_id>?
      ${force ? "" : "AND (status='pending' OR index_version<>?)"} ORDER BY document_id LIMIT ?`)
      .bind(after ?? "", ...(force ? [] : [INDEX_VERSION]), limit + 1).all<{document_id: string}>();
    const selected = jobs.results.slice(0, limit), results = [];
    for (const job of selected) results.push({id: job.document_id, ...await this.sync(job.document_id, force)});
    return {results, next_after: selected.at(-1)?.document_id ?? after ?? null, has_more: jobs.results.length > limit,
      summary: await this.summary()};
  }
  async search(input: unknown) {
    const {query, limit, source, min_score} = semanticSearchInput.parse(input);
    if (!this.configured) throw new ApiError(503, "semantic_not_configured", "Semantic search is not configured");
    const signal = AbortSignal.timeout(10_000);
    const [vector] = await call(() => new Embeddings(this.bindings.AI!).embed([query], "query", signal), signal, "embedding_unavailable");
    const matches = await call(() => this.bindings.VECTORIZE!.query(vector, {namespace: INDEX_VERSION, topK: 50,
      returnValues: false, returnMetadata: "none", ...(source ? {filter: {source: {$eq: source}}} : {})}), signal, "vector_query_unavailable");
    const candidates = matches.matches.filter(m => Number.isFinite(m.score) && m.score >= min_score).slice(0, 50);
    if (!candidates.length) return [];
    // Never return source text or source URLs from untrusted/stale vector metadata.
    const rows = await this.db.prepare(`SELECT d.id,d.title,d.source,d.url,d.created_at,d.body,c.id AS vector_id,
        c.start_offset,c.end_offset FROM semantic_chunks c JOIN documents d ON d.id=c.document_id
      WHERE c.id IN (SELECT value FROM json_each(?)) AND c.revision=d.semantic_revision AND c.index_version=?
        ${source ? "AND d.source=?" : ""}`)
      .bind(JSON.stringify(candidates.map(m => m.id)), INDEX_VERSION, ...(source ? [source] : []))
      .all<{id: string; title: string; source: string; url: string; created_at: string | null; body: string;
        vector_id: string; start_offset: number; end_offset: number}>();
    const byId = new Map(rows.results.map(row => [row.vector_id, row])), seen = new Set<string>(), results = [];
    for (const match of candidates.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))) {
      const row = byId.get(match.id);
      if (!row || seen.has(row.id)) continue;
      seen.add(row.id);
      const chars = [...row.body], end = Math.min(row.end_offset, row.start_offset + 240);
      results.push({id: row.id, title: row.title, source: row.source, url: row.url, created_at: row.created_at,
        excerpt: (row.start_offset ? "…" : "") + chars.slice(row.start_offset, end).join("") + (end < chars.length ? "…" : ""),
        relevance: match.score, search_method: "semantic", chunk_start: row.start_offset, chunk_end: row.end_offset});
      if (results.length === limit) break;
    }
    return results;
  }
}
