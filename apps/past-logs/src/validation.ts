import { z } from "zod";

export const MAX_BODY_BYTES = 128 * 1024;
export const MAX_REQUEST_BYTES = 256 * 1024;
const bytes = (s: string) => new TextEncoder().encode(s).length;
export const sourceSchema = z.enum(["cosense", "hatena", "manual"]);
export const idSchema = z.string().regex(/^doc_[a-f0-9]{64}$/);
const timestamp = z.iso.datetime({offset: true}).transform(s => new Date(s).toISOString()).nullable();
const fields = {
  url: z.url({protocol: /^https?$/}).max(2048),
  title: z.string().trim().min(1).max(1024),
  body: z.string().min(1).refine(s => bytes(s) <= MAX_BODY_BYTES, "Body exceeds 128 KiB UTF-8"),
  created_at: timestamp.optional(),
  updated_at: timestamp.optional(),
  metadata: z.record(z.string(), z.json()).nullable().optional()
    .refine(v => bytes(JSON.stringify(v) ?? "") <= 16 * 1024, "Metadata exceeds 16 KiB"),
};
export const documentInput = z.strictObject({
  source: sourceSchema, source_id: z.string().trim().min(1).max(1024), ...fields,
});
// Identity and import timestamps are immutable through PUT.
export const documentUpdate = z.strictObject(fields).partial().refine(v => Object.keys(v).length > 0);
export const searchInput = z.strictObject({
  query: z.string().trim().min(1).max(200),
  limit: z.number().int().min(1).max(20).default(5),
  source: sourceSchema.optional(),
});
export const semanticSearchInput = searchInput.extend({
  query: z.string().trim().min(1).max(2000),
  min_score: z.number().min(-1).max(1).default(0),
});
export const reindexInput = z.strictObject({
  // One article per request keeps worst-case binding/D1 calls within Free quotas.
  limit: z.literal(1).default(1),
  after: idSchema.optional(),
  force: z.boolean().default(false),
});
export const getInput = z.strictObject({
  id: idSchema,
  offset: z.number().int().min(0).max(131072).default(0),
  limit: z.number().int().min(1).max(8000).default(4000),
});
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
