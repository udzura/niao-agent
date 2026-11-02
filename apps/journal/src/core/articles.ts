import { assertPublishable, createDraftInput, getArticleInput, JournalError, journalLog,
  listArticlesInput, publishInput, updateDraftInput, type Source } from "./validation";

export interface Article {
  id: string; slug: string; authorId: string; journalDate: string | null;
  title: string; description: string | null; bodyMarkdown: string;
  status: "draft" | "published"; createdAt: string; updatedAt: string; publishedAt: string | null;
}
export type ArticleSummary = Omit<Article, "bodyMarkdown">;
type Row = Article & {idempotencyKey: string | null; creationHash: string};
const columns = `id, slug, author_id AS authorId, journal_date AS journalDate, title, description,
  body_markdown AS bodyMarkdown, status, created_at AS createdAt, updated_at AS updatedAt, published_at AS publishedAt`;
const digest = async (value: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))))
  .map(byte => byte.toString(16).padStart(2, "0")).join("");

export class Articles {
  constructor(private db: D1Database, private privateValues: string[] = []) {}
  private async byIdentity(clause: string, value: string): Promise<Row | null> {
    return this.db.prepare(`SELECT ${columns}, idempotency_key AS idempotencyKey, creation_hash AS creationHash FROM articles WHERE ${clause} = ?`)
      .bind(value).first<Row>();
  }
  async get(input: unknown, publishedOnly = false): Promise<Article & {sources: Source[]}> {
    const key = getArticleInput.parse(input);
    const row = await this.byIdentity(key.articleId ? "id" : "slug", key.articleId ?? key.slug!);
    if (!row || publishedOnly && row.status !== "published") throw new JournalError("not_found", 404);
    const {idempotencyKey: _key, creationHash: _hash, ...article} = row;
    const sources = (await this.db.prepare(`SELECT source_type AS sourceType, source_ref AS sourceRef, title, url, is_public AS public
      FROM article_sources WHERE article_id = ? ORDER BY position`).bind(row.id).all<Source & {title: string | null; url: string | null}>()).results
      .map(source => ({sourceType: source.sourceType, sourceRef: source.sourceRef,
        ...(source.title ? {title: source.title} : {}), ...(source.url ? {url: source.url} : {}), public: !!source.public}));
    return {...article, sources};
  }
  private sourceStatements(id: string, sources: Source[]) {
    return sources.map((source, position) => this.db.prepare(`INSERT INTO article_sources
      (article_id,position,source_type,source_ref,title,url,is_public) VALUES (?,?,?,?,?,?,?)`)
      .bind(id, position, source.sourceType, source.sourceRef, source.title ?? null, source.url ?? null, Number(source.public)));
  }
  async create(input: unknown) {
    const data = createDraftInput.parse(input);
    const hash = await digest(JSON.stringify(data));
    const existing = data.idempotencyKey ? await this.byIdentity("idempotency_key", data.idempotencyKey) : null;
    if (existing) {
      if (existing.creationHash !== hash) throw new JournalError("idempotency_conflict", 409);
      return this.get({articleId: existing.id});
    }
    const id = crypto.randomUUID(), slug = data.journalDate ?? id, now = new Date().toISOString();
    try {
      await this.db.batch([
        this.db.prepare(`INSERT INTO articles
          (id,slug,journal_date,title,description,body_markdown,created_at,updated_at,idempotency_key,creation_hash)
          VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(id, slug, data.journalDate ?? null, data.title, data.description ?? null,
            data.bodyMarkdown, now, now, data.idempotencyKey ?? null, hash),
        ...this.sourceStatements(id, data.sources ?? []),
      ]);
    } catch (error) {
      // A concurrent retry may have won. Read after the atomic batch has rolled back.
      const duplicate = data.idempotencyKey ? await this.byIdentity("idempotency_key", data.idempotencyKey) : null;
      if (duplicate) {
        if (duplicate.creationHash !== hash) throw new JournalError("idempotency_conflict", 409);
        return this.get({articleId: duplicate.id});
      }
      if (data.journalDate && await this.byIdentity("journal_date", data.journalDate)) throw new JournalError("journal_date_conflict", 409);
      throw error;
    }
    journalLog("draft_created", {articleId: id});
    return this.get({articleId: id});
  }
  async update(input: unknown) {
    const data = updateDraftInput.parse(input), article = await this.get({articleId: data.articleId});
    if (article.status !== "draft") throw new JournalError("published_article_immutable", 409);
    if (article.updatedAt !== data.expectedUpdatedAt) throw new JournalError("draft_changed", 409);
    // Ensure a revision changes even if two edits happen in the same millisecond.
    const now = new Date(Math.max(Date.now(), Date.parse(article.updatedAt) + 1)).toISOString();
    const next = {...article, ...data};
    // The guard aborts the whole D1 batch on concurrent edit/publication, including sources.
    // json('...') deliberately raises a SQL error only when the compare-and-swap failed.
    try {
      await this.db.batch([
        this.db.prepare(`UPDATE articles SET title=?,description=?,body_markdown=?,updated_at=?
          WHERE id=? AND status='draft' AND updated_at=?`).bind(next.title, next.description ?? null, next.bodyMarkdown,
            now, article.id, data.expectedUpdatedAt),
        this.db.prepare(`SELECT CASE WHEN changes() = 1 THEN 1 ELSE json('concurrent_draft_change') END`),
        ...(data.sources !== undefined ? [this.db.prepare("DELETE FROM article_sources WHERE article_id=?").bind(article.id),
          ...this.sourceStatements(article.id, data.sources)] : []),
      ]);
    } catch (error) {
      const latest = await this.get({articleId: article.id});
      if (latest.updatedAt !== article.updatedAt || latest.status !== "draft") throw new JournalError("draft_changed", 409);
      throw error;
    }
    journalLog("draft_updated", {articleId: article.id});
    return this.get({articleId: article.id});
  }
  async publish(input: unknown) {
    const data = publishInput.parse(input), article = await this.get({articleId: data.articleId});
    if (article.status === "published") return article;
    if (article.updatedAt !== data.expectedUpdatedAt) throw new JournalError("draft_changed", 409);
    assertPublishable([article.title, article.description, article.bodyMarkdown,
      ...article.sources.filter(s => s.public).map(s => `${s.title ?? ""} ${s.url}`)].join("\n"),
    [...this.privateValues, ...article.sources.filter(s => !s.public && s.sourceType !== "url").map(s => s.sourceRef)]);
    const now = new Date(Math.max(Date.now(), Date.parse(article.updatedAt) + 1)).toISOString();
    const result = await this.db.prepare(`UPDATE articles SET status='published', published_at=?, updated_at=?
      WHERE id=? AND status='draft' AND updated_at=?`).bind(now, now, article.id, data.expectedUpdatedAt).run();
    const published = await this.get({articleId: article.id});
    if (!result.meta.changes && published.status !== "published") throw new JournalError("draft_changed", 409);
    journalLog("published", {articleId: article.id});
    return published;
  }
  async list(input: unknown) {
    const {status, page, limit} = listArticlesInput.parse(input);
    const rows = (await this.db.prepare(`SELECT ${columns.replace("body_markdown AS bodyMarkdown, ", "")} FROM articles ${status ? "WHERE status=?" : ""}
      ORDER BY COALESCE(published_at,created_at) DESC,id DESC LIMIT ? OFFSET ?`)
      .bind(...(status ? [status] : []), limit + 1, (page - 1) * limit).all<ArticleSummary>()).results;
    return {articles: rows.slice(0, limit), page, hasMore: rows.length > limit};
  }
  async sitemap(page: number) {
    return (await this.db.prepare("SELECT slug,updated_at AS updatedAt FROM articles WHERE status='published' ORDER BY id LIMIT 1000 OFFSET ?")
      .bind((page - 1) * 1000).all<{slug: string; updatedAt: string}>()).results;
  }
  async publishedCount() {
    return (await this.db.prepare("SELECT COUNT(*) AS n FROM articles WHERE status='published'").first<{n: number}>())!.n;
  }
}
