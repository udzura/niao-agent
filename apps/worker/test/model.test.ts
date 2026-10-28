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

describe('bounded native tool calling', () => {
  const frame = (delta: unknown) => `data: ${JSON.stringify({choices:[{delta}]})}\n\n`;
  it('assembles split arguments, returns tool output to the selected model, and streams the answer', async () => {
    const requests: any[] = [];
    const ai = {run:async (_model: string,input: any) => {
      requests.push(JSON.parse(JSON.stringify(input)));
      return stream(requests.length === 1
        ? frame({tool_calls:[{index:0,id:'call_1',function:{name:'ruby_eval',arguments:'{"code":"6*'}}]}) + frame({tool_calls:[{index:0,id:null,function:{name:null,arguments:'7"}'}}]}) + 'data: [DONE]\n\n'
        : frame({content:'42です。',tool_calls:null}) + 'data: [DONE]\n\n');
    }} as unknown as Ai;
    const executed: string[] = [];
    const adapter = new WorkersAIModel(ai,'@cf/google/gemma-4-26b-a4b-it',async code => {executed.push(code); return {ok:true,value:'42'};});
    const events = [];
    for await (const e of adapter.stream([{role:'user',content:'計算して'}],new AbortController().signal)) events.push(e);
    expect(executed).toEqual(['6*7']);
    expect(requests[1].messages.at(-1)).toEqual({role:'tool',tool_call_id:'call_1',content:'{"ok":true,"value":"42"}'});
    expect(events).toContainEqual({text:'42です。'});
    expect(events.filter(e => 'inferenceStarted' in e)).toHaveLength(1);
  });
  it('never dispatches unknown tools and stops repeated tool calls at the budget', async () => {
    let requests = 0, executions = 0;
    const ai = {run:async () => { requests++; return stream(frame({tool_calls:[{index:0,id:'call_'+requests,function:{name:requests === 1 ? 'fetch' : 'ruby_eval',arguments:'{"code":"1"}'}}]})+'data: [DONE]\n\n'); }} as unknown as Ai;
    const adapter = new WorkersAIModel(ai,'@cf/zai-org/glm-4.7-flash',async () => {executions++; return {ok:true,value:'1'};});
    await expect((async () => {for await (const e of adapter.stream([],new AbortController().signal)) { /* consume */ }})()).rejects.toThrow('tool_limit');
    expect(requests).toBe(4); expect(executions).toBe(2);
  });
});

it('executes the advertised tool through the real static Runner RPC and returns its value to the model', async () => {
  const {env} = await import('cloudflare:test');
  const {rubyExecutor} = await import('../src/ruby/tool');
  let round = 0;
  const ai = {run:async (_model: string,input: any) => {
    if (round++ === 0) return stream('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"ruby_call","function":{"name":"ruby_eval","arguments":"{\\"code\\":\\"1 + 1\\"}"}}]}}]}\n\ndata: [DONE]\n\n');
    const tool = input.messages.at(-1);
    expect(tool.role).toBe('tool');
    expect(JSON.parse(tool.content)).toMatchObject({ok:true,value:'2'});
    return stream('data: {"choices":[{"delta":{"content":"2"}}]}\n\ndata: [DONE]\n\n');
  }} as unknown as Ai;
  const adapter = new WorkersAIModel(ai,'@cf/zai-org/glm-4.7-flash',rubyExecutor((env as any).RUBY_RUNNER));
  const events = [];
  for await (const event of adapter.stream([],new AbortController().signal)) events.push(event);
  expect(round).toBe(2); expect(events).toContainEqual({text:'2'});
});
