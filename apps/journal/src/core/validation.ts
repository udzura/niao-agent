import { z } from "zod";

export class JournalError extends Error {
  constructor(public code: string, public status = 400) { super(code); }
}
export const journalDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
});
export const articleId = z.uuid();
export const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/);
export function publicUrl(value: string): string | null {
  try {
    const url = new URL(value);
    // Public citations cannot carry credentials, private hosts or query secrets.
    if (url.protocol !== "https:" || url.username || url.password || url.hash ||
        !url.hostname.includes(".") || /^[\d.]+$/.test(url.hostname) || url.hostname.includes(":") ||
        /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(url.hostname) ||
        /(?:token|secret|key|auth|password|signature|credential|session)/i.test(url.search)) return null;
    return url.href;
  } catch { return null; }
}
export const sourceInput = z.strictObject({
  sourceType: z.enum(["url", "observation", "message"]),
  sourceRef: z.string().trim().min(1).max(500),
  title: z.string().trim().min(1).max(200).optional(),
  url: z.string().max(2000).refine(value => publicUrl(value) !== null).optional(),
  public: z.boolean().default(false),
}).refine(source => !source.public || source.sourceType === "url" && !!source.url);
const fields = {
  title: z.string().trim().min(1).max(200),
  bodyMarkdown: z.string().trim().min(1).max(50000),
  description: z.string().trim().max(1000).nullable().optional(),
  sources: z.array(sourceInput).max(20).optional(),
};
export const createDraftInput = z.strictObject({
  ...fields, journalDate: journalDate.optional(),
  idempotencyKey: z.string().regex(/^[a-zA-Z0-9:_-]{1,128}$/).optional(),
});
export const updateDraftInput = z.strictObject({
  articleId, expectedUpdatedAt: z.iso.datetime(),
  title: fields.title.optional(), bodyMarkdown: fields.bodyMarkdown.optional(),
  description: fields.description, sources: fields.sources,
}).refine(value => [value.title, value.bodyMarkdown, value.description, value.sources].some(x => x !== undefined));
export const publishInput = z.strictObject({articleId, expectedUpdatedAt: z.iso.datetime(), confirmPublication: z.literal(true)});
export const getArticleInput = z.strictObject({articleId: articleId.optional(), slug: slug.optional()})
  .refine(value => Number(!!value.articleId) + Number(!!value.slug) === 1);
export const listArticlesInput = z.strictObject({
  status: z.enum(["draft", "published"]).optional(),
  page: z.number().int().min(1).max(10000).default(1),
  limit: z.number().int().min(1).max(50).default(20),
});
export type Source = z.infer<typeof sourceInput>;
// A deterministic, intentionally conservative backstop; human review is required.
export function assertPublishable(text: string, privateRefs: string[] = []) {
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[a-z0-9._~-]{12,}|\b(?:sk-[a-z0-9_-]{16,}|gh[pousr]_[a-z0-9]{20,}|AKIA[A-Z0-9]{16})|(?:api[_-]?key|password|access[_-]?token|secret)\s*[=:]\s*["']?[a-z0-9_./+~-]{12,}/i.test(text) ||
      privateRefs.some(ref => ref.length >= 6 && text.includes(ref))) throw new JournalError("sensitive_content", 422);
}
export const safeCode = (error: unknown) => error instanceof JournalError ? error.code
  : error instanceof z.ZodError ? "invalid_input" : "database_unavailable";
export const journalLog = (event: string, fields: Record<string, string | number | boolean> = {}) =>
  console.log(JSON.stringify({event: `journal.${event}`, ...fields}));
