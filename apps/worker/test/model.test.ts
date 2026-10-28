import { describe, expect, it } from "vitest";
import { boundedContext, parseSSE, WorkersAIModel } from "../src/model";
import { authenticated } from "../src/auth";
const encoder = new TextEncoder();
function stream(text: string) {
  const bytes = encoder.encode(text);
  return new ReadableStream<Uint8Array>({start(controller) {
    // Split every UTF-8 codepoint and SSE delimiter across reads.
    for (let i = 0; i < bytes.length; i += 2) controller.enqueue(bytes.slice(i, i + 2));
    controller.close();
  }});
}
async function collect(text: string) {
  const parts = [];
  for await (const part of parseSSE(stream(text), new AbortController().signal)) parts.push(part);
  return parts;
}
describe("Workers AI adapter", () => {
  it("passes the selected model identifier to the real provider adapter", async () => {
    let selected: string | undefined;
    const ai = {run: async (modelId: string) => { selected = modelId; return stream('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n'); }} as unknown as Ai;
    const adapter = new WorkersAIModel(ai, "@cf/zai-org/glm-4.7-flash");
    const parts = [];
    for await (const part of adapter.stream([], new AbortController().signal)) parts.push(part);
    expect(selected).toBe("@cf/zai-org/glm-4.7-flash"); expect(parts).toEqual([{text: "ok"}]);
  });
  it("decodes split UTF-8, CRLF, reasoning-only frames and safe usage", async () => {
    const parts = await collect(': ping\r\n\r\ndata: {"choices":[{"delta":{"reasoning_content":"private"}}]}\r\n\r\ndata: {"choices":[{"delta":{"content":"こんにちは"}}]}\r\n\r\ndata: {"usage":{"total_tokens":8,"prompt":"private"}}\r\n\r\ndata: [DONE]\r\n\r\n');
    expect(parts).toEqual([{text: "こんにちは"}, {usage: {total_tokens: 8}}]);
  });
  it("fails truncated, malformed and provider error streams", async () => {
    await expect(collect('data: {"response":"partial"}\n\n')).rejects.toThrow("incomplete_ai_stream");
    await expect(collect('data: bad\n\n')).rejects.toThrow("invalid_ai_response");
    await expect(collect('data: {"error":{"code":429}}\n\n')).rejects.toThrow("ai_rate_limited");
  });
  it("bounds context by count and content size", () => {
    const result = boundedContext(Array.from({length: 100}, () => ({role: "user" as const, content: "x".repeat(8000)})));
    expect(result).toHaveLength(4); expect(result[0].role).toBe("system");
  });
  it("fails closed for absent, short and incorrect secrets", async () => {
    const req = new Request("https://test", {headers: {Authorization: `Bearer ${"a".repeat(32)}`}});
    expect(await authenticated(req)).toBe(false);
    expect(await authenticated(req, "short")).toBe(false);
    expect(await authenticated(req, "b".repeat(32))).toBe(false);
    expect(await authenticated(req, "a".repeat(32))).toBe(true);
  });
});
