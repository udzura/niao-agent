export const MAX_INPUT = 8_000;
export type Role = "user" | "assistant";
export interface ThinkingSegment { generation: number; text: string; active: boolean }
export interface Message {
  seq: number;
  id: string;
  requestId: string;
  role: Role;
  content: string;
  createdAt: string;
  thinking?: ThinkingSegment[];
}
export interface Turn {
  requestId: string;
  status: "running" | "failed" | "completed";
  errorCode: string | null;
}
export type Submission = { v: 1; type: "send"; requestId: string; content: string; epoch?: number };
export class ChatError extends Error {
  constructor(public code: string) { super(code); }
}
export function parseSubmission(raw: unknown): Submission {
  if (typeof raw !== "string" || raw.length > 50_000) throw new ChatError("invalid_message");
  let data: unknown;
  try { data = JSON.parse(raw); } catch { throw new ChatError("invalid_message"); }
  const x = data as Partial<Submission> | null;
  if (!x || x.v !== 1 || x.type !== "send" || typeof x.requestId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x.requestId) ||
      (x.epoch !== undefined && (!Number.isSafeInteger(x.epoch) || x.epoch < 0)) ||
      typeof x.content !== "string" || !x.content.trim() || x.content.length > MAX_INPUT) {
    throw new ChatError("invalid_message");
  }
  return {v: 1, type: "send", requestId: x.requestId.toLowerCase(), content: x.content.trim(), epoch: x.epoch};
}
export function errorCode(error: unknown): string {
  if (error instanceof ChatError) return error.code;
  const e = error as { status?: number; statusCode?: number; name?: string };
  if (e?.status === 429 || e?.statusCode === 429) return "ai_rate_limited";
  if (e?.name === "TimeoutError" || e?.name === "AbortError") return "ai_timeout";
  return "ai_unavailable";
}
