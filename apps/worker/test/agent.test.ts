import { SELF, env, runInDurableObject, reset, evictDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { afterEach, describe, expect, it } from "vitest";
import { NiaoAgent } from "../src/niao-agent";
import { ChatError } from "../src/protocol";
import { ClefThinkingJudge } from "../src/thinking-policy";
import { PlatformAnalytics } from "../src/platform-usage";
import {workersAIError} from "../src/ai-errors";

const headers = {Authorization: "Bearer test-only-token-000000000000000000000000"};
const base = "https://test/agents/niao-agent/personal";
const sockets: WebSocket[] = [];
afterEach(async () => { for (const ws of sockets.splice(0)) ws.close(); await reset(); });
async function stub() { return getAgentByName((env as any).NiaoAgent, "personal"); }
async function model(mode: "ok" | "fail" | "slow" = "ok") {
  await runInDurableObject(await stub(), (agent: NiaoAgent) => {
    (agent as any).createModel = () => ({async *stream() {
      yield {text: "こん"};
      if (mode === "slow") await new Promise(resolve => setTimeout(resolve, 80));
      if (mode === "fail") throw new ChatError("ai_rate_limited");
      yield {text: "にちは"};
      yield {usage: {total_tokens: 8, neurons: 2.5}};
      yield {usage: {total_tokens: 8, neurons: 2.5}};
    }});
  });
}
async function connect() {
  const response = await SELF.fetch(base, {headers: {...headers, Upgrade: "websocket"}});
  expect(response.status).toBe(101);
  const ws = response.webSocket!;
  const events: any[] = [];
  ws.addEventListener("message", event => { events.push(JSON.parse(event.data as string)); });
  ws.accept(); sockets.push(ws);
  const until = async (predicate: (event: any) => boolean) => {
    for (let i = 0; i < 200; i++) {
      const found = events.find(predicate);
      if (found) return found;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error("Expected protocol event not received");
  };
  await until(e => e.type === "ready");
  return {ws, events, until};
}
const send = (ws: WebSocket, requestId: string, content = "hello") => ws.send(JSON.stringify({v: 1, type: "send", requestId, content}));
async function settingsUpdate(body: unknown) {
  const response=await SELF.fetch(`${base}/settings`,{method:"PUT",headers:{...headers,"Content-Type":"application/json"},body:JSON.stringify(body)});
  return {status:response.status,body:await response.json<any>()};
}
async function history(after = 0) {
  const response = await SELF.fetch(`${base}/history?after=${after}`, {headers});
  expect(response.status).toBe(200);
  return response.json<any>();
}

it("returns redacted provider details over WebSocket and restores them after eviction",async()=>{
  await runInDurableObject(await stub(),(agent:NiaoAgent)=>{
    (agent as any).createModel=()=>({async *stream(){
      throw workersAIError(new Error("4006: AiError: you have used up your daily free allocation of 10,000 neurons PRIVATE_CONVERSATION SECRET_TOKEN"));
    }});
  });
  const client=await connect();const id=crypto.randomUUID();send(client.ws,id);
  const failed=await client.until(e=>e.type==="error"&&e.requestId===id);
  expect(failed).toMatchObject({code:"ai_rate_limited",details:{provider:"cloudflare",providerCode:4006,reason:"daily_quota_exceeded"}});
  expect(JSON.stringify(failed)).not.toMatch(/PRIVATE_CONVERSATION|SECRET_TOKEN/);
  client.ws.close();await evictDurableObject(await stub(),{webSockets:"close"});
  const page=await history();expect(page.turns).toEqual([{requestId:id,status:"failed",errorCode:"ai_rate_limited",errorDetails:failed.details}]);
  await model();const retry=await connect();send(retry.ws,id);
  await retry.until(e=>e.type==="committed");expect((await history()).turns).toEqual([]);
  await runInDurableObject(await stub(),(agent:NiaoAgent)=>{
    expect(agent.sql<{errorDetails:string|null}>`SELECT errorDetails FROM niao_turns WHERE requestId=${id}`[0].errorDetails).toBeNull();
  });
});

describe("authenticated Worker boundary", () => {
  it("rejects unauthenticated HTTP and upgrades before allocating an agent", async () => {
    for (const path of ["/health", "/agents/niao-agent/personal/usage", "/agents/niao-agent/personal/platform-usage", "/agents/niao-agent/personal/history", "/agents/niao-agent/personal"]) {
      expect((await SELF.fetch(`https://test${path}`)).status).toBe(401);
      expect((await SELF.fetch(`https://test${path}`, {headers: {Upgrade: "websocket"}})).status).toBe(401);
    }
    expect((await SELF.fetch("https://test/health", {headers})).status).toBe(200);
    expect((await SELF.fetch("https://test/health?token=anything")).status).toBe(401);
    expect((await SELF.fetch("https://test/agents/niao-agent/other", {headers})).status).toBe(404);
    expect((await SELF.fetch(base, {method: "POST", headers})).status).toBe(405);
  });
  it("serves platform usage through the authenticated Agent and keeps it read-only", async () => {
    expect((await SELF.fetch(`${base}/platform-usage`, {method: "POST", headers})).status).toBe(405);
    expect((await SELF.fetch(`${base}/platform-usage`, {headers: {...headers, Upgrade: "websocket"}})).status).toBe(404);
    const unconfigured = await (await SELF.fetch(`${base}/platform-usage`, {headers})).json<any>();
    expect(unconfigured.workers).toMatchObject({status: "not_configured", requests: null});
    await runInDurableObject(await stub(), (agent: NiaoAgent) => {
      (agent as any).platformAnalytics = new PlatformAnalytics({CF_ACCOUNT_ID: "a".repeat(32), CF_ANALYTICS_TOKEN: "test-token"}, async (url, init) => {
        if (String(url).includes("/subscriptions")) return new Response(null, {status: 403});
        const workers = String(init?.body).includes("workersInvocationsAdaptive");
        return Response.json({data: {viewer: {accounts: [{[workers ? "workersInvocationsAdaptive" : "durableObjectsPeriodicGroups"]:
          [{sum: workers ? {requests: 50} : {duration: 12.5}}]}]}}});
      });
    });
    const response = await SELF.fetch(`${base}/platform-usage`, {headers});
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toMatchObject({v: 1, workers: {status: "available", requests: 50},
      durableObjects: {status: "available", durationGbSeconds: 12.5}, plan: {status: "unavailable", name: null}});
  });
});

describe("automatic thinking and judge accounting",()=>{
  const gemma="@cf/google/gemma-4-26b-a4b-it";
  const usage=async()=> (await SELF.fetch(`${base}/usage`,{headers})).json<any>();
  it.each([
    [gemma,0.15,0.45,true,true], [gemma,0.35,0.65,false,true], [gemma,0.65,0.85,false,false],
    ["@cf/qwen/qwen3-30b-a3b-fp8",0.15,0.45,true,true], ["@cf/qwen/qwen3-30b-a3b-fp8",0.35,0.65,false,true], ["@cf/qwen/qwen3-30b-a3b-fp8",0.65,0.85,false,false],
    ["@cf/qwen/qwen3.8-27b",0.15,0.45,true,true], ["@cf/qwen/qwen3.8-27b",0.35,0.65,false,true], ["@cf/qwen/qwen3.8-27b",0.65,0.85,false,false],
  ])("applies composer thresholds for %s: %s / %s to each following turn without changing the model",async(selectedModel,offThreshold,onThreshold,lowEnabled,midEnabled)=>{
    await settingsUpdate({modelId:selectedModel,thinkingMode:'on'});
    const client=await connect();
    const policy={offThreshold,onThreshold,ambiguity:'on',timeoutMs:3000};
    expect((await settingsUpdate({thinkingMode:'auto',thinkingPolicy:policy})).body).toMatchObject({modelId:selectedModel,thinkingMode:'auto',thinkingPolicy:policy});
    expect((await client.until(e=>e.type==='settings_updated')).settings).toMatchObject({modelId:selectedModel,thinkingPolicy:policy});
    for (const [score,enabled] of [[0.2,lowEnabled],[0.5,midEnabled]] as const) {
      await runInDurableObject(await stub(),(agent:NiaoAgent)=>{
        (agent as any).createThinkingJudge=()=>new ClefThinkingJudge({run:async()=>({answers:{needs_thinking:{type:'noul',noul:score}},usage:{input_tokens:10}})} as unknown as Ai);
        (agent as any).createModel=(modelId:string,thinking:boolean)=>({async *stream(){
          expect(modelId).toBe(selectedModel);expect(thinking).toBe(enabled);yield {text:thinking?'on':'off'};
        }});
      });
      const id=crypto.randomUUID();send(client.ws,id);
      expect((await client.until(e=>e.type==='committed'&&e.requestId===id)).messages[1].content).toBe(enabled?'on':'off');
    }
    expect((await usage()).local.judge.attempts).toBe(2);
    expect((await settingsUpdate({thinkingMode:'off'})).body).toMatchObject({modelId:selectedModel,thinkingMode:'off',thinkingPolicy:policy});
    client.ws.close();await evictDurableObject(await stub(),{webSockets:'close'});
    expect((await history()).settings).toMatchObject({modelId:selectedModel,thinkingMode:'off',thinkingPolicy:policy});
  });
  it("validates partial settings atomically and preserves thinking on model-only updates",async()=>{
    await settingsUpdate({modelId:gemma,thinkingMode:'auto',thinkingPolicy:{offThreshold:0.15,onThreshold:0.45}});
    const before=(await history()).settings;
    for (const body of [{},[],null,1,{other:true},{modelId:null},{thinkingMode:'invalid'},{thinkingMode:'on',thinkingPolicy:{offThreshold:0.9}}]) {
      expect((await settingsUpdate(body)).status).toBe(400);
      expect((await history()).settings).toEqual(before);
    }
    expect((await settingsUpdate({modelId:'@cf/zai-org/glm-4.7-flash'})).body).toMatchObject({thinkingMode:'auto',thinkingPolicy:before.thinkingPolicy});
  });
  it("judges once per turn, keeps tool continuations fixed, and counts rate-derived neurons exactly once",async()=>{
    expect((await settingsUpdate({modelId:gemma,thinkingMode:"auto"})).status).toBe(200);
    await runInDurableObject(await stub(),(agent:NiaoAgent)=>{
      let calls=0;
      (agent as any).createThinkingJudge=()=>new ClefThinkingJudge({run:async(model:string,input:any)=>{
        calls++;expect(model).toBe('@cf/cloudflare/clef-flash');expect(input.state.messages.at(-1).content).toBe('hello');
        await new Promise(resolve=>setTimeout(resolve,50));
        return {answers:{needs_thinking:{type:'noul',noul:0.1}},usage:{input_tokens:1000}};
      }} as unknown as Ai);
      (agent as any).createModel=(_model:string,enabled:boolean)=>({async *stream(){
        expect(calls).toBe(1);expect(enabled).toBe(false);
        yield {usage:{neurons:2}};yield {toolStatus:'running'};yield {toolStatus:'completed'};
        yield {inferenceStarted:true};yield {usage:{neurons:3}};yield {text:'direct answer'};
        expect(calls).toBe(1);
      }});
    });
    const client=await connect();const id=crypto.randomUUID();send(client.ws,id);
    await client.until(e=>e.type==='accepted');send(client.ws,id);
    await client.until(e=>e.type==='committed');send(client.ws,id);
    const first=await usage();
    expect(first.local).toMatchObject({neurons:8.455,attempts:3,unmeasuredAttempts:0,
      judge:{neurons:3.455,attempts:1,unmeasuredAttempts:0,calculatedAttempts:1,timedAttempts:1}});
    expect(first.local.judge.totalDurationMs).toBeGreaterThanOrEqual(40);
    await runInDurableObject(await stub(),(agent:NiaoAgent)=>{
      expect(agent.sql`SELECT score, reason, inputTokens, neuronsPerMillion FROM niao_judge_attempts`).toEqual([
        {score:0.1,reason:'low_score',inputTokens:1000,neuronsPerMillion:3455},
      ]);
    });
    client.ws.close();await evictDurableObject(await stub(),{webSockets:'close'});
    expect((await usage()).local).toEqual(first.local);
    const cleared=await SELF.fetch(`${base}/history`,{method:'DELETE',headers:{...headers,'If-Match':'"0"'}});
    expect(cleared.status).toBe(200);await cleared.text();
    expect((await usage()).local).toEqual(first.local);
  });
  it.each([
    [0.9,false,true,'high_score'],[0.5,false,true,'ambiguous'],[null,false,true,'invalid_response'],[null,true,true,'unavailable'],
  ])("keeps generation working for score %s / failure %s",async(score,fail,enabled,reason)=>{
    await settingsUpdate({modelId:gemma,thinkingMode:'auto'});
    await runInDurableObject(await stub(),(agent:NiaoAgent)=>{
      (agent as any).createThinkingJudge=()=>new ClefThinkingJudge({run:async()=>{
        if(fail)throw new Error('private upstream response');
        return {answers:{needs_thinking:{type:'noul',noul:score}},usage:{input_tokens:1000}};
      }} as unknown as Ai);
      (agent as any).createModel=(_model:string,actual:boolean)=>({async *stream(){
        expect(actual).toBe(enabled);yield {usage:{neurons:2}};yield {text:'answer'};
      }});
    });
    const client=await connect();send(client.ws,crypto.randomUUID());await client.until(e=>e.type==='committed');
    const result=await usage();
    expect(result.local.attempts).toBe(2);expect(result.local.judge.attempts).toBe(1);
    expect(result.local.neurons).toBe(fail?2:5.455);expect(result.local.unmeasuredAttempts).toBe(fail?1:0);
    await runInDurableObject(await stub(),(agent:NiaoAgent)=>{expect(agent.sql`SELECT reason FROM niao_judge_attempts`).toEqual([{reason}]);});
  });
  it("does not invoke the judge for manual modes or an unsupported model",async()=>{
    await runInDurableObject(await stub(),(agent:NiaoAgent)=>{
      (agent as any).createThinkingJudge=()=>{throw new Error('Unexpected judge');};
      (agent as any).createModel=(_model:string,enabled:boolean)=>({async *stream(){yield {usage:{neurons:1}};yield {text:enabled?'on':'off'};}});
    });
    const client=await connect();
    for (const [modelId,thinkingMode,answer] of [[gemma,'off','off'],[gemma,'on','on'],['@cf/zai-org/glm-4.7-flash','auto','off']]) {
      await settingsUpdate({modelId,thinkingMode});const id=crypto.randomUUID();send(client.ws,id);
      expect((await client.until(e=>e.type==='committed'&&e.requestId===id)).messages[1].content).toBe(answer);
    }
    const result=await usage();expect(result.local.attempts).toBe(3);expect(result.local.judge.attempts).toBe(0);
  });
  it("continues with thinking ON after a judge timeout and marks its unknown usage",async()=>{
    await settingsUpdate({modelId:gemma,thinkingMode:'auto',thinkingPolicy:{timeoutMs:100}});
    await runInDurableObject(await stub(),(agent:NiaoAgent)=>{
      (agent as any).createThinkingJudge=()=>new ClefThinkingJudge({run:()=>new Promise(()=>{})} as unknown as Ai);
      (agent as any).createModel=(_model:string,enabled:boolean)=>({async *stream(){
        expect(enabled).toBe(true);yield {text:'answer after timeout'};yield {usage:{neurons:2}};
      }});
    });
    const client=await connect();send(client.ws,crypto.randomUUID());
    await client.until(e=>e.type==='committed');
    const result=await usage();
    expect(result.local).toMatchObject({neurons:2,attempts:2,unmeasuredAttempts:1,judge:{attempts:1,unmeasuredAttempts:1,timedAttempts:1}});
    expect(result.local.judge.totalDurationMs).toBeGreaterThanOrEqual(90);
  });
  it("migrates a saved boolean ON and preserves adjustable policy across restart and legacy model changes",async()=>{
    await runInDurableObject(await stub(),(agent:NiaoAgent)=>{
      agent.sql`DROP TABLE niao_settings`;
      agent.sql`CREATE TABLE niao_settings (id INTEGER PRIMARY KEY,modelId TEXT NOT NULL,epoch INTEGER NOT NULL,thinkingEnabled INTEGER NOT NULL)`;
      agent.sql`INSERT INTO niao_settings VALUES (1,'@cf/google/gemma-4-26b-a4b-it',2,1)`;
    });
    await evictDurableObject(await stub());
    expect((await history()).settings).toMatchObject({thinkingMode:'on',thinkingEnabled:true,epoch:2});
    const policy={offThreshold:0.2,onThreshold:0.8,ambiguity:'on',timeoutMs:1500};
    expect((await settingsUpdate({modelId:gemma,thinkingMode:'auto',thinkingPolicy:policy})).body).toMatchObject({thinkingMode:'auto',thinkingPolicy:policy});
    await evictDurableObject(await stub());
    expect((await history()).settings).toMatchObject({thinkingMode:'auto',thinkingPolicy:policy});
    expect((await settingsUpdate({modelId:gemma})).body.thinkingMode).toBe('auto');
    expect((await settingsUpdate({modelId:gemma,thinkingPolicy:{ambiguity:'off'}})).body.thinkingPolicy).toEqual({...policy,ambiguity:'off'});
    expect((await settingsUpdate({modelId:gemma,thinkingEnabled:false})).body.thinkingMode).toBe('off');
    const before=(await history()).settings;
    for (const fields of [{thinkingMode:'invalid'},{thinkingMode:null},{thinkingMode:'auto',thinkingEnabled:false},{thinkingPolicy:{offThreshold:0.9}},{thinkingPolicy:{timeoutMs:1}},{thinkingPolicy:{oops:1}}]) {
      expect((await settingsUpdate({modelId:gemma,...fields})).status).toBe(400);
    }
    expect((await history()).settings).toEqual(before);
  });
  it("uses the turn's policy snapshot and charges each retry but never a completed replay",async()=>{
    await settingsUpdate({modelId:gemma,thinkingMode:'auto'});
    await runInDurableObject(await stub(),(agent:NiaoAgent)=>{
      let generations=0;
      (agent as any).createThinkingJudge=()=>new ClefThinkingJudge({run:async()=>{
        await new Promise(resolve=>setTimeout(resolve,150));
        return {answers:{needs_thinking:{type:'noul',noul:0.5}},usage:{input_tokens:1000}};
      }} as unknown as Ai);
      (agent as any).createModel=(_model:string,enabled:boolean)=>({async *stream(){
        generations++;if(generations===1){expect(enabled).toBe(true);throw new ChatError('ai_rate_limited');}
        yield {text:enabled?'on':'off'};yield {usage:{neurons:2}};
      }});
    });
    const client=await connect();const id=crypto.randomUUID();send(client.ws,id);
    await client.until(e=>e.type==='accepted');
    await settingsUpdate({modelId:gemma,thinkingPolicy:{ambiguity:'off'}});
    await client.until(e=>e.type==='error'&&e.requestId===id);
    await runInDurableObject(await stub(),(agent:NiaoAgent)=>{expect(agent.sql`SELECT reason FROM niao_judge_attempts`).toEqual([{reason:'ambiguous'}]);});
    send(client.ws,id);
    expect((await client.until(e=>e.type==='committed'&&e.requestId===id)).messages[1].content).toBe('off');
    send(client.ws,id);
    const result=await usage();expect(result.local.attempts).toBe(4);expect(result.local.judge.attempts).toBe(2);
    expect(result.local.neurons).toBeCloseTo(8.91);expect(result.local.unmeasuredAttempts).toBe(1);
  });
});
describe("model settings and conversation cleanup", () => {
  const gemma = "@cf/google/gemma-4-26b-a4b-it";
  const glm = "@cf/zai-org/glm-4.7-flash";
  const put = (modelId: string, thinkingEnabled?: unknown) => SELF.fetch(`${base}/settings`, {method: "PUT", headers: {...headers, "Content-Type": "application/json"}, body: JSON.stringify({modelId, thinkingEnabled})});
  const clear = (epoch: number) => SELF.fetch(`${base}/history`, {method: "DELETE", headers: {...headers, "If-Match": `"${epoch}"`}});
  it("authenticates mutations and rejects unsupported or malformed settings", async () => {
    expect((await SELF.fetch(`${base}/settings`, {method: "PUT", body: "{}"})).status).toBe(401);
    expect((await SELF.fetch(`${base}/history`, {method: "DELETE"})).status).toBe(401);
    expect((await put("@cf/not-a-chat-model" )).status).toBe(400);
    expect((await SELF.fetch(`${base}/settings`, {method: "PUT", headers: {...headers, "Content-Type": "application/json"}, body: "null"})).status).toBe(400);
    expect((await SELF.fetch(`${base}/history`, {method: "DELETE", headers})).status).toBe(428);
    const settings = await (await SELF.fetch(`${base}/settings`, {headers})).json<any>();
    expect(settings.modelId).toBe(gemma); expect(settings.models.map((x: any) => x.id)).toEqual([gemma, glm, "@cf/ibm-granite/granite-4.0-h-micro", "@cf/meta/llama-3.3-70b-instruct-fp8-fast", "@cf/meta/llama-4-scout-17b-16e-instruct", "@cf/qwen/qwen3-30b-a3b-fp8", "@cf/qwen/qwen3.8-27b"]);
  });
  it.each([glm,"@cf/meta/llama-3.3-70b-instruct-fp8-fast","@cf/ibm-granite/granite-4.0-h-micro", "@cf/meta/llama-4-scout-17b-16e-instruct", "@cf/qwen/qwen3-30b-a3b-fp8"])("persists %s across eviction and uses it for inference", async selected => {
    const updated = await put(selected);
    expect(updated.status).toBe(200); await updated.text();
    await evictDurableObject(await stub());
    const settings = await (await SELF.fetch(`${base}/settings`, {headers})).json<any>();
    expect(settings.modelId).toBe(selected);
    await runInDurableObject(await stub(), (agent: NiaoAgent) => {
      (agent as any).createModel = (modelId: string) => ({async *stream() { yield {text: modelId}; }});
    });
    const client = await connect(); send(client.ws, crypto.randomUUID());
    expect((await client.until(e => e.type === "committed")).messages[1].content).toBe(selected);
  });
  it("validates thinking atomically and preserves it for model-only updates", async () => {
    const get = async () => (await SELF.fetch(`${base}/settings`, {headers})).json<any>();
    const initial = await get();
    expect(initial.thinkingEnabled).toBe(false);
    expect(initial.models.map((model:any) => model.supportsThinking)).toEqual([true,false,false,false,false,true,true]);
    for (const value of [null, "true", 1, {}, []]) {
      const response = await put(glm,value);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({code:"invalid_settings"});
    }
    expect(await get()).toEqual(initial);
    expect((await (await put(gemma,true)).json<any>()).thinkingEnabled).toBe(true);
    expect(await (await put(glm)).json()).toMatchObject({modelId:glm,thinkingEnabled:true});
    expect(await (await put(gemma)).json()).toMatchObject({modelId:gemma,thinkingEnabled:true});
    expect(await (await put(gemma,false)).json()).toMatchObject({modelId:gemma,thinkingEnabled:false});
  });
  it("migrates existing model settings without clearing history and restores thinking after eviction", async () => {
    await runInDurableObject(await stub(), (agent:NiaoAgent) => {
      agent.sql`DROP TABLE niao_settings`;
      agent.sql`CREATE TABLE niao_settings (id INTEGER PRIMARY KEY, modelId TEXT NOT NULL, epoch INTEGER NOT NULL DEFAULT 0)`;
      agent.sql`INSERT INTO niao_settings VALUES (1,'@cf/zai-org/glm-4.7-flash',3)`;
      agent.sql`INSERT INTO niao_messages (id,requestId,role,content,createdAt) VALUES ('legacy','legacy','user','saved history','now')`;
    });
    await evictDurableObject(await stub());
    const migrated = await history();
    expect(migrated.settings).toMatchObject({modelId:glm,epoch:3,thinkingEnabled:false});
    expect(migrated.messages[0].content).toBe('saved history');
    await (await put(gemma,true)).text();
    await evictDurableObject(await stub());
    const restored = await history();
    expect(restored.settings).toMatchObject({modelId:gemma,epoch:3,thinkingEnabled:true});
    expect(restored.messages).toEqual(migrated.messages);
  });
  it("broadcasts thinking changes, snapshots the running turn, and preserves the option on cleanup", async () => {
    await runInDurableObject(await stub(), (agent:NiaoAgent) => {
      (agent as any).createModel = (_modelId:string, thinkingEnabled:boolean) => ({async *stream() {
        yield {text:thinkingEnabled ? 'thinking on' : 'thinking off'};
        await new Promise(resolve => setTimeout(resolve,150));
      }});
    });
    const client = await connect(); const first = crypto.randomUUID(); send(client.ws,first);
    await client.until(e => e.type === 'partial');
    expect((await put(gemma,true)).status).toBe(200);
    expect((await client.until(e => e.type === 'settings_updated')).settings.thinkingEnabled).toBe(true);
    expect((await client.until(e => e.type === 'committed' && e.requestId === first)).messages[1].content).toBe('thinking off');
    const next = crypto.randomUUID(); send(client.ws,next);
    expect((await client.until(e => e.type === 'committed' && e.requestId === next)).messages[1].content).toBe('thinking on');
    const cleared = await clear(0); expect(cleared.status).toBe(200); await cleared.text();
    expect((await history()).settings.thinkingEnabled).toBe(true);
  });
  it("changes only the next inference and refuses cleanup while generating", async () => {
    await runInDurableObject(await stub(), (agent: NiaoAgent) => {
      (agent as any).createModel = (modelId: string) => ({async *stream() {
        yield {text: modelId};
        await new Promise(resolve => setTimeout(resolve, 150));
      }});
    });
    const client = await connect(); const first = crypto.randomUUID(); send(client.ws, first);
    await client.until(e => e.type === "partial");
    expect((await clear(0)).status).toBe(409);
    expect((await put(glm)).status).toBe(200);
    expect((await client.until(e => e.type === "committed" && e.requestId === first)).messages[1].content).toBe(gemma);
    const next = crypto.randomUUID(); send(client.ws, next);
    expect((await client.until(e => e.type === "committed" && e.requestId === next)).messages[1].content).toBe(glm);
  });
  it("clears history but preserves settings/usage, fences offline sends and repairs old cursors", async () => {
    await model(); const client = await connect(); const id = crypto.randomUUID(); send(client.ws, id);
    await client.until(e => e.type === "committed"); await (await put(glm)).text();
    const old = await history();
    const cleared = await clear(0);
    expect(cleared.status).toBe(200); await cleared.text();
    expect((await client.until(e => e.type === "history_cleared")).epoch).toBe(1);
    const page = await history(old.cursor);
    expect(page.epoch).toBe(1); expect(page.messages).toEqual([]); expect(page.turns).toEqual([]);
    expect(page.settings.modelId).toBe(glm);
    expect((await (await SELF.fetch(`${base}/usage`, {headers})).json<any>()).local.neurons).toBe(2.5);
    send(client.ws, id); // Old offline/retry payload without an epoch cannot resurrect history.
    expect((await client.until(e => e.type === "error" && e.requestId === id)).code).toBe("history_changed");
    await runInDurableObject(await stub(), (agent: NiaoAgent) => {
      (agent as any).createModel = () => ({async *stream(messages: any[]) {
        if (messages.length !== 2 || messages[1].content !== "new conversation") throw new Error("Old context survived deletion");
        yield {text: "fresh"};
      }});
    });
    const next = crypto.randomUUID();
    client.ws.send(JSON.stringify({v: 1, type: "send", requestId: next, content: "new conversation", epoch: 1}));
    const completed = await client.until(e => e.type === "committed" && e.requestId === next);
    expect(completed.messages[0].seq).toBeGreaterThan(old.cursor);
    const staleClear = await clear(0);
    expect(staleClear.status).toBe(409); await staleClear.text(); // Retrying a lost DELETE response cannot delete the new chat.
    client.ws.close(); await evictDurableObject(await stub(), {webSockets: "close"});
    const recovered = await history(old.cursor);
    expect(recovered.epoch).toBe(1); expect(recovered.messages).toEqual(completed.messages);
  });
});
describe("persistent chat using the real Agent and SQLite runtime", () => {
  it("streams, commits, deduplicates retry, and survives actual eviction", async () => {
    await model();
    const client = await connect();
    const id = crypto.randomUUID();
    send(client.ws, id);
    const completed = await client.until(e => e.type === "committed");
    expect(completed.messages.map((m: any) => m.role)).toEqual(["user", "assistant"]);
    expect(client.events.filter(e => e.type === "partial").map(e => e.text)).toEqual(["こん", "こんにちは"]);
    send(client.ws, id);
    await new Promise(resolve => setTimeout(resolve, 40));
    expect((await history()).messages).toHaveLength(2);
    client.ws.close();
    await evictDurableObject(await stub(), {webSockets: "close"});
    const recovered = await history();
    expect(recovered.messages).toEqual(completed.messages);
    const next = await connect();
    send(next.ws, id);
    expect((await next.until(e => e.type === "committed")).messages).toEqual(completed.messages);
    expect((await history(completed.messages[0].seq)).messages).toEqual([completed.messages[1]]);
  });
  it("keeps partial output transient and retries failed turns without duplicating the user", async () => {
    await model("fail");
    const client = await connect();
    const id = crypto.randomUUID(); send(client.ws, id);
    expect((await client.until(e => e.type === "error")).code).toBe("ai_rate_limited");
    const failed = await history();
    expect(failed.messages).toHaveLength(1);
    expect(failed.turns[0].status).toBe("failed");
    expect(failed.active).toBeNull();
    await model(); send(client.ws, id);
    await client.until(e => e.type === "committed");
    expect((await history()).messages).toHaveLength(2);
  });
  it("does not run a second generation for duplicate in-flight sends or conflict", async () => {
    await model("slow");
    const a = await connect(); const b = await connect();
    const id = crypto.randomUUID(); send(a.ws, id);
    await a.until(e => e.type === "partial");
    send(b.ws, id); send(b.ws, id, "different");
    const otherID = crypto.randomUUID(); send(b.ws, otherID);
    expect((await b.until(e => e.type === "error" && e.requestId === id)).code).toBe("id_conflict");
    expect((await b.until(e => e.type === "error" && e.requestId === otherID)).code).toBe("busy");
    await a.until(e => e.type === "committed");
    expect((await history()).messages).toHaveLength(2);
  });
  it("reports a persisted running turn as interrupted after eviction", async () => {
    const id = crypto.randomUUID();
    await runInDurableObject(await stub(), (agent: NiaoAgent) => {
      agent.sql`INSERT INTO niao_turns (requestId,status) VALUES (${id},'running')`;
      agent.sql`INSERT INTO niao_messages (id,requestId,role,content,createdAt) VALUES (${id},${id},'user','hello','2026-10-27T00:00:00Z')`;
    });
    await evictDurableObject(await stub());
    const page = await history();
    expect(page.messages).toHaveLength(1);
    expect(page.turns).toEqual([{requestId: id, status: "failed", errorCode: "interrupted"}]);
    await model(); const client = await connect(); send(client.ws, id);
    await client.until(e => e.type === "committed");
    expect((await history()).messages).toHaveLength(2);
  });
  it("keeps the original prompt when retrying an old failure after many later turns", async () => {
    const id = crypto.randomUUID();
    await runInDurableObject(await stub(), (agent: NiaoAgent) => {
      agent.sql`INSERT INTO niao_turns (requestId,status) VALUES (${id},'failed')`;
      agent.sql`INSERT INTO niao_messages (id,requestId,role,content,createdAt) VALUES (${id},${id},'user','original prompt','2026-10-27T00:00:00Z')`;
      for (let i = 0; i < 30; i++) {
        const later = `later-${i}`;
        agent.sql`INSERT INTO niao_turns (requestId,status) VALUES (${later},'completed')`;
        agent.sql`INSERT INTO niao_messages (id,requestId,role,content,createdAt) VALUES (${later},${later},'user','later prompt','2026-10-27T01:00:00Z')`;
      }
      (agent as any).createModel = () => ({async *stream(messages: any[]) {
        if (messages.at(-1)?.content !== "original prompt" || messages.length !== 2) throw new Error("Incorrect historical context");
        yield {text: "original answer"};
      }});
    });
    const client = await connect(); send(client.ws, id, "original prompt");
    expect((await client.until(e => e.type === "committed")).messages[1].content).toBe("original answer");
  });
  it("persists observed usage once per inference, counts unknown attempts and survives eviction", async () => {
    const usage = async () => (await SELF.fetch(`${base}/usage`, {headers})).json<any>();
    await model(); const client = await connect();
    const id = crypto.randomUUID(); send(client.ws, id);
    await client.until(e => e.type === "committed");
    send(client.ws, id); // A retry of the completed submission must not count again.
    await new Promise(resolve => setTimeout(resolve, 30));
    const first = await usage();
    expect(first.account.status).toBe("not_configured");
    expect(first.account.neurons).toBeNull();
    expect(first.local).toMatchObject({neurons: 2.5, attempts: 1, unmeasuredAttempts: 0});
    await model("fail"); const failedID = crypto.randomUUID(); send(client.ws, failedID);
    await client.until(e => e.type === "error" && e.requestId === failedID);
    expect((await usage()).local).toMatchObject({neurons: 2.5, attempts: 2, unmeasuredAttempts: 1});
    await model(); send(client.ws, failedID);
    await client.until(e => e.type === "committed" && e.requestId === failedID);
    client.ws.close(); await evictDurableObject(await stub(), {webSockets: "close"});
    const recovered = await usage();
    expect(recovered.local).toMatchObject({neurons: 5, attempts: 3, unmeasuredAttempts: 1, trackingSince: first.local.trackingSince});
    await runInDurableObject(await stub(), (agent: NiaoAgent) => {
      agent.sql`INSERT INTO niao_usage_attempts VALUES ('old', '2000-01-01T12:00:00.000Z', 999)`;
    });
    expect((await usage()).local.neurons).toBe(5);
    const response = await SELF.fetch(`${base}/usage`, {headers});
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
  it("validates input and cursor, and pages history without gaps", async () => {
    const client = await connect();
    for (const content of ["", " ", "x".repeat(8001)]) send(client.ws, crypto.randomUUID(), content);
    await client.until(e => e.type === "error");
    expect((await history()).messages).toHaveLength(0);
    expect((await SELF.fetch(`${base}/history?after=-1`, {headers})).status).toBe(400);
    await runInDurableObject(await stub(), (agent: NiaoAgent) => {
      for (let i = 0; i < 105; i++) agent.sql`INSERT INTO niao_messages (id,requestId,role,content,createdAt) VALUES (${String(i)},${String(i)},'user','seed','2026-10-27T00:00:00Z')`;
    });
    const first = await history(); const last = await history(first.cursor);
    expect(first.messages).toHaveLength(100); expect(first.hasMore).toBe(true);
    expect(last.messages).toHaveLength(5); expect(last.hasMore).toBe(false);
    expect(new Set([...first.messages, ...last.messages].map(m => m.seq)).size).toBe(105);
  });
});

it('accounts separately for each model invocation around a tool call', async () => {
  await runInDurableObject(await stub(), (agent: NiaoAgent) => {
    (agent as any).createModel = () => ({async *stream() {
      yield {usage:{neurons:2}};
      yield {toolStatus:'running'};
      yield {toolStatus:'completed'};
      yield {inferenceStarted:true};
      yield {usage:{neurons:3}};
      yield {text:'42'};
    }});
  });
  const client = await connect(); send(client.ws,crypto.randomUUID());
  await client.until(e => e.type === 'committed');
  const usage = await (await SELF.fetch(`${base}/usage`,{headers})).json<any>();
  expect(usage.local.attempts).toBe(2); expect(usage.local.neurons).toBe(5);
  expect(client.events.filter(e => e.type === 'tool_status').map(e => e.status)).toEqual(['running','completed']);
});

it('streams separated thoughts, persists per-generation thinking after eviction and never uses it as context',async()=>{
  await runInDurableObject(await stub(),(agent:NiaoAgent)=>{
    (agent as any).createModel=()=>({async *stream(messages:any[]){
      if(JSON.stringify(messages).includes('PRIVATE_THINKING'))throw new Error('Thinking leaked to context');
      yield {thinking:{generation:0,text:'PRIVATE_THINKING before tool',active:true}};
      await new Promise(resolve=>setTimeout(resolve,40));
      yield {thinking:{generation:0,text:'',active:false}};
      yield {toolStatus:'running'};yield {toolStatus:'completed'};
      yield {inferenceStarted:true};
      yield {thinking:{generation:1,text:'PRIVATE_THINKING after tool',active:false}};
      yield {text:'normalized answer'};
    }});
  });
  const client=await connect();const id=crypto.randomUUID();send(client.ws,id);
  await client.until(e=>e.type==='partial'&&e.thinking?.[0]?.active===true);
  const active=await history();expect(active.active.thinking[0].text).toContain('PRIVATE_THINKING');
  const complete=await client.until(e=>e.type==='committed'&&e.requestId===id);
  const assistant=complete.messages[1];
  expect(assistant.content).toBe('normalized answer');
  expect(assistant.thinking).toEqual([
    {generation:0,text:'PRIVATE_THINKING before tool',active:false},
    {generation:1,text:'PRIVATE_THINKING after tool',active:false},
  ]);
  send(client.ws,crypto.randomUUID());
  await client.until(e=>e.type==='committed'&&e.requestId!==id); // Fixture checks context above.
  client.ws.close();await evictDurableObject(await stub(),{webSockets:'close'});
  const restored=await history();expect(restored.messages[1]).toEqual(assistant);
  const next=await connect();send(next.ws,id);
  expect((await next.until(e=>e.type==='committed')).messages[1]).toEqual(assistant);
  next.ws.close();
  const cleared=await SELF.fetch(`${base}/history`,{method:'DELETE',headers:{...headers,'If-Match':'"0"'}});
  expect(cleared.status).toBe(200);await cleared.text();
  await runInDurableObject(await stub(),(agent:NiaoAgent)=>{
    expect((agent as any).sql`SELECT * FROM niao_thinking`).toEqual([]);
  });
});

it('bounds thinking output and does not commit a thinking-only assistant response',async()=>{
  await runInDurableObject(await stub(),(agent:NiaoAgent)=>{
    (agent as any).createModel=()=>({async *stream(){yield {thinking:{generation:0,text:'only thoughts',active:false}};}});
  });
  const client=await connect();send(client.ws,crypto.randomUUID());
  expect((await client.until(e=>e.type==='error')).code).toBe('empty_ai_response');
  expect((await history()).messages.map((m:any)=>m.role)).toEqual(['user']);
  await runInDurableObject(await stub(),(agent:NiaoAgent)=>{
    (agent as any).createModel=()=>({async *stream(){yield {thinking:{generation:0,text:'x'.repeat(32001),active:true}};}});
  });
  const next=crypto.randomUUID();send(client.ws,next);
  expect((await client.until(e=>e.type==='error'&&e.requestId===next)).code).toBe('response_too_large');
});
