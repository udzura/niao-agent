import { z } from "zod";
import { ApiError, documentInput, documentUpdate, getInput } from "./validation";
import { indexTerms, searchDocuments } from "./search";

export type Document = {
  id: string; source: "cosense" | "hatena" | "manual"; source_id: string;
  url: string; title: string; body: string;
  created_at: string | null; updated_at: string | null; indexed_at: string;
  metadata: Record<string, z.infer<ReturnType<typeof z.json>>> | null;
};
type Row = Omit<Document, "metadata"> & {metadata: string | null};
const columns = "id, source, source_id, url, title, body, created_at, updated_at, indexed_at, metadata";
const decode = (row: Row): Document => ({...row, metadata: row.metadata === null ? null : JSON.parse(row.metadata)});
export class DocumentService {
  constructor(private db: D1Database) {}
  async get(id: string): Promise<Document | null> {
    const row = await this.db.prepare(`SELECT ${columns} FROM documents WHERE id = ?`).bind(id).first<Row>();
    return row ? decode(row) : null;
  }
  async upsert(input: unknown): Promise<Document> {
    const doc = documentInput.parse(input);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([doc.source, doc.source_id])));
    const id = "doc_" + [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
    const row = await this.db.prepare(`INSERT INTO documents (${columns}, search_title, search_body)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source, source_id) DO UPDATE SET url=excluded.url, title=excluded.title,
        body=excluded.body, created_at=excluded.created_at, updated_at=excluded.updated_at,
        indexed_at=excluded.indexed_at, metadata=excluded.metadata,
        search_title=excluded.search_title, search_body=excluded.search_body
      RETURNING ${columns}`)
      .bind(id, doc.source, doc.source_id, doc.url, doc.title, doc.body, doc.created_at ?? null,
        doc.updated_at ?? null, new Date().toISOString(), doc.metadata == null ? null : JSON.stringify(doc.metadata),
        indexTerms(doc.title), indexTerms(doc.body)).first<Row>();
    return decode(row!);
  }
  async update(id: string, input: unknown): Promise<Document> {
    const patch = documentUpdate.parse(input);
    // One UPDATE preserves concurrent changes to unrelated fields (no read/merge/write race).
    const values: unknown[] = [], assignments: string[] = [];
    for (const [key, value] of Object.entries(patch)) {
      assignments.push(`${key} = ?`);
      values.push(key === "metadata" && value !== null ? JSON.stringify(value) : value);
      if (key === "title" || key === "body") {
        assignments.push(`search_${key} = ?`); values.push(indexTerms(value as string));
      }
    }
    assignments.push("indexed_at = ?"); values.push(new Date().toISOString(), id);
    const row = await this.db.prepare(`UPDATE documents SET ${assignments.join(", ")} WHERE id = ? RETURNING ${columns}`)
      .bind(...values).first<Row>();
    if (!row) throw new ApiError(404, "not_found", "Document not found");
    return decode(row);
  }
  async delete(id: string) {
    const row = await this.db.prepare("DELETE FROM documents WHERE id = ? RETURNING id").bind(id).first();
    if (!row) throw new ApiError(404, "not_found", "Document not found");
    return {id, deleted: true};
  }
  search(input: unknown) { return searchDocuments(this.db, input); }
  async page(input: unknown) {
    const {id, offset, limit} = getInput.parse(input);
    const doc = await this.get(id);
    if (!doc) throw new ApiError(404, "not_found", "Document not found");
    const chars = [...doc.body], next = Math.min(chars.length, offset + limit);
    return {id: doc.id, title: doc.title, source: doc.source, url: doc.url,
      created_at: doc.created_at, updated_at: doc.updated_at,
      body: chars.slice(offset, next).join(""), offset, total_chars: chars.length,
      next_offset: next < chars.length ? next : null};
  }
}
