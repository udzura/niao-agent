import { workersAIError } from "./ai-errors";
import type { ConversationMessage, ModelID, OpenAIReasoningEffort, ToolCall } from "./model";
import type { AdditionalTool } from "./past-logs";
import { ChatError } from "./protocol";
import { readSSE } from "./sse";

export type ResponsesReasoningItem = {type: "reasoning"; id: string; summary: []; encrypted_content: string};
type ResponsesEvent = {text: string} | {usage: Record<string, number>} | {reasoningItems: ResponsesReasoningItem[]}
  | {toolDelta: {index: number; id: string; function: ToolCall["function"]}[]};

export function responsesInput(modelId: ModelID, messages: ConversationMessage[], tools: AdditionalTool["definition"][],
  toolChoice: "none" | "auto", effort: OpenAIReasoningEffort, maxOutputTokens: number) {
  const input: Record<string, unknown>[] = [];
  let latestUser = messages.length - 1;
  while (latestUser >= 0 && messages[latestUser].role !== "user") latestUser--;
  for (const [index, message] of messages.entries()) {
    if (message.role === "tool") {
      input.push({type: "function_call_output", call_id: message.tool_call_id, output: message.content});
      continue;
    }
    if ("tool_calls" in message) {
      if (index > latestUser && message.responseReasoning?.modelId === modelId)
        input.push(...message.responseReasoning.items);
      if (message.content) input.push({role: "assistant", content: message.content});
      for (const call of message.tool_calls)
        input.push({type: "function_call", call_id: call.id, name: call.function.name, arguments: call.function.arguments});
    } else {
      input.push({role: message.role, content: message.content});
    }
  }
  return {
    input, stream: true, max_output_tokens: maxOutputTokens, store: false,
    reasoning: {effort},
    include: ["reasoning.encrypted_content"],
    ...(tools.length ? {
      tools: tools.map(tool => ({type: "function", ...tool.function, strict: false})),
      tool_choice: toolChoice, parallel_tool_calls: false,
    } : {}),
  };
}

export async function* parseResponsesSSE(stream: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncIterable<ResponsesEvent> {
  // The terminal event can include a large encrypted reasoning item.
  for await (const event of readSSE(stream, signal, 1_000_000)) {
    if (event.type === "response.output_text.delta" || event.type === "response.refusal.delta") {
      if (typeof event.delta === "string") yield {text: event.delta};
      continue;
    }
    if (event.type === "error") throw workersAIError(event);
    if (!["response.completed", "response.incomplete", "response.failed"].includes(event.type)) continue;

    const {output, usage: sample} = event.response ?? {};
    if (sample) {
      const usage: Record<string, number> = {};
      for (const [key, value] of Object.entries({prompt_tokens: sample.input_tokens, completion_tokens: sample.output_tokens, total_tokens: sample.total_tokens})) {
        if (typeof value === "number") usage[key] = value;
      }
      yield {usage};
    }
    if (event.type === "response.failed") throw workersAIError(event.response?.error ?? event);
    if (event.type === "response.incomplete") throw new ChatError("incomplete_ai_stream");
    if (!Array.isArray(output)) throw new ChatError("invalid_ai_response");
    const toolDelta = [], reasoningItems: ResponsesReasoningItem[] = [];
    for (const item of output) {
      if (item?.type === "function_call") {
        if (typeof item.call_id !== "string" || typeof item.name !== "string" || typeof item.arguments !== "string")
          throw new ChatError("invalid_tool_call");
        toolDelta.push({index: toolDelta.length, id: item.call_id, function: {name: item.name, arguments: item.arguments}});
      } else if (item?.type === "reasoning" && typeof item.id === "string" && typeof item.encrypted_content === "string") {
        reasoningItems.push({type: "reasoning", id: item.id, summary: [], encrypted_content: item.encrypted_content});
      }
    }
    if (toolDelta.length > 3) throw new ChatError("invalid_tool_call");
    // Only dispatch completed calls. Intermediate output events can arrive before a failed response.
    if (reasoningItems.length) yield {reasoningItems};
    if (toolDelta.length) yield {toolDelta};
    return;
  }
  throw new ChatError("incomplete_ai_stream");
}
