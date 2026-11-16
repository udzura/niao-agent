import { workersAIError } from "./ai-errors";
import { ChatError } from "./protocol";

// Handles split UTF-8, CRLF, multiline data, and aborted or truncated streams.
export async function* readSSE(stream: ReadableStream<Uint8Array>, signal: AbortSignal, maxFrameSize = 256_000) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const abort = () => { void reader.cancel().catch(() => { }); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const {value, done} = await reader.read();
      signal.throwIfAborted();
      buffer += done ? decoder.decode() : decoder.decode(value, {stream: true});
      let match: RegExpExecArray | null;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        if (match.index > maxFrameSize) throw new ChatError("invalid_ai_response");
        const frame = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const data = frame.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
        if (!data) continue;
        if (data === "[DONE]") return;
        let chunk;
        try { chunk = JSON.parse(data); } catch { throw new ChatError("invalid_ai_response"); }
        if (!chunk || typeof chunk !== "object") throw new ChatError("invalid_ai_response");
        if (chunk.error || chunk.success === false && Array.isArray(chunk.errors) && chunk.errors.length)
          throw workersAIError(chunk.error ?? chunk);
        yield chunk;
      }
      if (buffer.length > maxFrameSize) throw new ChatError("invalid_ai_response");
      if (done) throw new ChatError("incomplete_ai_stream");
    }
  } catch (error) {
    throw workersAIError(error);
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => { });
    reader.releaseLock();
  }
}
