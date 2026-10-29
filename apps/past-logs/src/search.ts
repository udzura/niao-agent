import { ApiError, searchInput } from "./validation";
import type { Document } from "./documents";

const cjk = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]+$/u;
function pieces(text: string): string[] {
  const words = text.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  return words.flatMap(word => word.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]+|[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]+/gu) ?? []);
}
const encode = (prefix: string, chars: string[]) => prefix + chars.map(c => c.codePointAt(0)!.toString(16).padStart(6, "0")).join("");
function bigrams(chars: string[]): string[] {
  return chars.slice(1).map((c, i) => encode("g", [chars[i], c]));
}
export function indexTerms(text: string): string {
  const tokens: string[] = [], unigrams = new Set<string>();
  let length = 0;
  const append = (token: string) => {
    length += token.length + 1;
    if (length > 1_000_000) throw new ApiError(413, "index_too_large", "Normalized search index exceeds 1 MB; shorten the document");
    tokens.push(token);
  };
  for (const piece of pieces(text)) {
    const chars = [...piece];
    if (cjk.test(piece)) {
      for (let i = 1; i < chars.length; i++) append(encode("g", [chars[i - 1], chars[i]]));
      for (const c of chars) unigrams.add(encode("u", [c]));
    } else if (chars.length <= 128) append(encode("w", chars));
    append("sep"); // Phrases cannot cross punctuation, words, or script boundaries.
  }
  append("sep");
  for (const token of unigrams) append(token);
  return tokens.join(" ");
}
function matchExpression(query: string): string {
  const terms = pieces(query);
  if (!terms.length || terms.length > 16) throw new ApiError(400, "invalid_query", "Use 1–16 searchable terms");
  return terms.map(piece => {
    const chars = [...piece];
    if (chars.length > 128) throw new ApiError(400, "invalid_query", "Search term is too long");
    // Only owned ASCII tokens reach MATCH; user FTS operators are never executed.
    const tokens = cjk.test(piece) ? chars.length === 1 ? [encode("u", chars)] : bigrams(chars) : [encode("w", chars)];
    return `"${tokens.join(" ")}"`;
  }).join(" AND ");
}
export function excerpt(body: string, query: string): string {
  const chars = [...body], normalized = body.normalize("NFKC").toLowerCase();
  const positions = pieces(query).map(q => normalized.indexOf(q)).filter(p => p >= 0);
  // NFKC can change offsets slightly; the excerpt is advisory, never the original body.
  const point = positions.length ? [...normalized.slice(0, Math.min(...positions))].length : 0;
  const start = Math.max(0, point - 50);
  return (start ? "…" : "") + chars.slice(start, start + 240).join("") + (start + 240 < chars.length ? "…" : "");
}
export async function searchDocuments(db: D1Database, input: unknown) {
  const {query, limit, source} = searchInput.parse(input);
  const result = await db.prepare(`SELECT d.id, d.title, d.source, d.url, d.created_at, d.body,
      -bm25(documents_fts, 6.0, 1.0) AS relevance
    FROM documents_fts JOIN documents d ON d.rowid = documents_fts.rowid
    WHERE documents_fts MATCH ? ${source ? "AND d.source = ?" : ""}
    ORDER BY bm25(documents_fts, 6.0, 1.0), d.id LIMIT ?`)
    .bind(matchExpression(query), ...(source ? [source] : []), limit)
    .all<Pick<Document, "id" | "title" | "source" | "url" | "created_at" | "body"> & {relevance: number}>();
  return result.results.map(({body, ...doc}) => ({...doc, excerpt: excerpt(body, query)}));
}
