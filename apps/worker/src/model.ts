import { ChatError } from "./protocol";
export const MODEL_ID = "@cf/google/gemma-4-26b-a4b-it"; // "@cf/zai-org/glm-4.7-flash";
export type ModelMessage = { role: "system" | "user" | "assistant"; content: string };
export type ModelEvent = { text: string } | { usage: Record<string, number> };
export interface ChatModel {
  stream(messages: ModelMessage[], signal: AbortSignal): AsyncIterable<ModelEvent>;
}

// The only module aware of Workers AI's provider-specific input and SSE format.
export class WorkersAIModel implements ChatModel {
  constructor(private ai: Ai) { }
  async *stream(messages: ModelMessage[], signal: AbortSignal): AsyncIterable<ModelEvent> {
    const result = await this.ai.run(MODEL_ID, {
      messages, stream: true, max_completion_tokens: 2048,
      chat_template_kwargs: { enable_thinking: false },
      stream_options: { include_usage: true },
    }, { signal });
    if (!(result instanceof ReadableStream)) throw new ChatError("invalid_ai_response");
    yield* parseSSE(result, signal);
  }
}

// Handles split UTF-8, CRLF, multiple data lines, usage-only chunks, and truncated streams.
export async function* parseSSE(stream: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncIterable<ModelEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finished = false;
  const abort = () => { void reader.cancel().catch(() => { }); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (buffer.length > 256_000) throw new ChatError("invalid_ai_response");
      let match: RegExpExecArray | null;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const data = frame.split(/\r?\n/).filter(l => l.startsWith("data:")).map(l => l.slice(5).trimStart()).join("\n");
        if (!data) continue;
        if (data === "[DONE]") { finished = true; break; }
        let chunk;
        try { chunk = JSON.parse(data); } catch { throw new ChatError("invalid_ai_response"); }
        if (chunk.error) throw new ChatError(chunk.error.code === 429 ? "ai_rate_limited" : "ai_unavailable");
        const text = chunk.choices?.[0]?.delta?.content ?? chunk.response;
        if (typeof text === "string" && text) yield { text };
        if (chunk.usage) {
          const usage: Record<string, number> = {};
          for (const key of ["prompt_tokens", "completion_tokens", "total_tokens", "neurons"]) {
            if (typeof chunk.usage[key] === "number") usage[key] = chunk.usage[key];
          }
          yield { usage };
        }
      }
      if (finished) return;
      if (done) throw new ChatError("incomplete_ai_stream");
    }
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => { });
    reader.releaseLock();
  }
}

export function boundedContext(messages: ModelMessage[]): ModelMessage[] {
  let remaining = 24_000;
  const result: ModelMessage[] = [];
  for (const message of messages.slice(-24).reverse()) {
    if (message.content.length > remaining) break;
    result.unshift(message);
    remaining -= message.content.length;
  }
  return [{ role: "system", content: "You are Niao, a thoughtful personal AI companion. Reply in the user's language. Be concise, honest, and helpful." }, ...result];
}
