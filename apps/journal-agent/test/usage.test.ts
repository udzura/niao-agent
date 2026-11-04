import {env,applyD1Migrations,reset,runInDurableObject,evictDurableObject} from "cloudflare:test";
import {getAgentByName} from "agents";
import {beforeEach,afterEach,expect,it} from "vitest";
import mainWorker from "../../worker/src/index";
import {measureUsage} from "../src/usage";
const bindings=env as any,token="journal-usage-test-token-000000000000000";
const base="https://test/agents/niao-agent/personal/journal-usage";
const api=(query="",init:RequestInit={headers:{Authorization:`Bearer ${token}`}})=>mainWorker.fetch(new Request(base+query,init),{...bindings,NIAO_TOKEN:token});
const sse=(events:unknown[],done=true)=>new ReadableStream({start(c){
  c.enqueue(new TextEncoder().encode(events.map(event=>`data: ${JSON.stringify(event)}\n\n`).join("")+(done ? "data: [DONE]\n\n" : "")));c.close();
}});
beforeEach(async()=>{await applyD1Migrations(bindings.TEST_DB,bindings.TEST_MIGRATIONS);});
afterEach(async()=>{await reset();});
async function prepareJob(){
  const main=await getAgentByName(bindings.NiaoAgent,"personal");
  const receipt=await runInDurableObject(main,async(a:any)=>{
    a.env.JOURNAL_PROMPTS={send:async()=>{}};a.active={requestId:crypto.randomUUID(),sessionId:"legacy"};
    const receipt=await a.enqueueJournalAgent({prompt:"日報を書いて PRIVATE-PROMPT"},a.active.requestId,0);a.active=null;return receipt;
  });
  const claim=await main.claimJournalAgentJob(receipt.jobId);if(claim.action!=="run")throw Error("missing job");
  return {main,job:claim.job,report:await getAgentByName(bindings.JournalAgent,receipt.reportSessionId)};
}
it("counts each inference once, distinguishes reported/estimated neurons, and exposes private authenticated usage after expiry",async()=>{
  const {main,report,job}=await prepareJob();
  await runInDurableObject(report,async(a:any)=>{
    let calls=0;a.onRunError=(error:unknown)=>{throw error;};
    a.env.AI={run:async(model:string,input:any)=>{
      calls++;expect(model).toBe("@cf/google/gemma-4-26b-a4b-it");expect(input.max_completion_tokens).toBe(8192);
      expect(input.chat_template_kwargs.enable_thinking).toBe(false);expect(input.stream_options.include_usage).toBe(true);
      return calls===1 ? sse([
        {choices:[{delta:{tool_calls:[{index:0,id:"read-chat",function:{name:"read_today_chat_sessions",arguments:"{}"}}]}}]},
        {usage:{prompt_tokens:100,completion_tokens:1,total_tokens:101,neurons:1}},
        {usage:{prompt_tokens:120,completion_tokens:30,total_tokens:150,neurons:3}},
      ]) : sse([{choices:[{delta:{content:"日報の確認 PRIVATE-BODY"}}]},{usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120}}]);
    }};
    expect(await a.run(job)).toContain("日報の確認");await a.run(job);expect(calls).toBe(2);
  });
  const response=await api(`?jobId=${job.id}`);expect(response.status).toBe(200);expect(response.headers.get("Cache-Control")).toBe("no-store");
  const snapshot=await response.json<any>();
  expect(snapshot.summary).toMatchObject({attempts:2,inputTokens:220,outputTokens:50,reportedAttempts:1,estimatedAttempts:1,reportedNeurons:3,complete:true,source:"mixed"});
  expect(snapshot.summary.estimatedNeurons).toBeCloseTo(1.45456,5);expect(snapshot.summary.neurons).toBeCloseTo(4.45456,5);
  expect(snapshot.attempts.map((a:any)=>a.model)).toEqual(["@cf/google/gemma-4-26b-a4b-it","@cf/google/gemma-4-26b-a4b-it"]);
  expect(JSON.stringify(snapshot)).not.toMatch(/PRIVATE-|sourceRef|prompt_tokens/);
  const first=await (await api(`?reportSessionId=${job.reportSessionId}&limit=1`)).json<any>();
  expect(first.hasMore).toBe(true);expect(first.attempts).toHaveLength(1);
  const second=await (await api(`?reportSessionId=${job.reportSessionId}&limit=1&before=${first.nextCursor}`)).json<any>();
  expect(second.hasMore).toBe(false);expect(second.attempts[0].id).not.toBe(first.attempts[0].id);expect(second.summary.neurons).toBe(snapshot.summary.neurons);
  await evictDurableObject(report,{webSockets:"close"});
  await runInDurableObject(report,async(a:any)=>{a.sql`UPDATE report_meta SET expiresAt=0`;await a.expire();});
  await runInDurableObject(main,async(a:any)=>{await a.clearSession("legacy");});
  const retained=await (await api(`?jobId=${job.id}`)).json<any>();expect(retained.summary).toEqual(snapshot.summary);
  const list=await (await api()).json<any>();expect(list.sessions).toHaveLength(1);expect(list.sessions[0].summary).toEqual(snapshot.summary);
});
it("saves and reviews a long draft after more than six inference rounds without duplicating usage on replay",async()=>{
  const {report,job}=await prepareJob();
  const body="## 当日の会話から考えたこと\n\n"+"会話で確認した事実と、そこから考えたことを区別して記録します。".repeat(130);
  expect(body.length).toBeGreaterThan(3000);
  await runInDurableObject(report,async(a:any)=>{
    let calls=0;a.onRunError=(error:unknown)=>{throw error;};
    a.env.AI={run:async()=>{
      calls++;
      const delta=calls<=7 ? {tool_calls:[{index:0,id:`step-${calls}`,function:calls===7
        ? {name:"journal_create_draft",arguments:JSON.stringify({title:"長い日報の保存検証",bodyMarkdown:body})}
        : {name:"read_today_chat_sessions",arguments:"{}"}}]} : {content:"長い下書きを保存しました"};
      return sse([{choices:[{delta}]},{usage:{prompt_tokens:100,completion_tokens:20,neurons:2}}]);
    }};
    expect(await a.run(job)).toBe("長い下書きを保存しました");
    expect((await a.review(job.id)).bodyMarkdown).toBe(body);
    await a.run(job);expect(calls).toBe(8);
  });
  const articles=await bindings.TEST_DB.prepare("SELECT body_markdown,status FROM articles").all();
  expect(articles.results).toEqual([{body_markdown:body,status:"draft"}]);
  const snapshot=await (await api(`?jobId=${job.id}`)).json<any>();
  expect(snapshot.summary).toMatchObject({attempts:8,complete:true,neurons:16,source:"reported"});
});
it.each(["no_usage","partial_stream","provider_failure"])("does not report missing or interrupted inference usage as zero (%s)",async(mode)=>{
  const {report,job}=await prepareJob();
  await runInDurableObject(report,async(a:any)=>{
    a.onRunError=()=>{};
    a.env.AI={run:async()=>{
      if(mode==="provider_failure")throw Error("4006: quota PRIVATE-ERROR");
      return sse([{choices:[{delta:{content:"回答"}}]},...(mode==="partial_stream" ? [{usage:{prompt_tokens:20,completion_tokens:10}}] : [])],mode!=="partial_stream");
    }};
    await a.run(job);
  });
  const snapshot=await (await api(`?jobId=${job.id}`)).json<any>();
  expect(snapshot.summary).toMatchObject({attempts:1,complete:false,neurons:null});
  expect(snapshot.summary.unmeasuredAttempts).toBe(mode==="partial_stream" ? 0 : 1);
  expect(snapshot.summary.incompleteAttempts).toBe(mode==="no_usage" ? 0 : 1);
  expect(JSON.stringify(snapshot)).not.toContain("PRIVATE-ERROR");
});
it("keeps pre-tracking jobs unknown and records zero for a tracked job that used no inference",async()=>{
  const {report,job}=await prepareJob();
  await runInDurableObject(report,async(a:any)=>{
    // A legacy receipt existed before usage instrumentation.
    a.sql`INSERT INTO report_turns(id,status,result) VALUES (${job.id},'done','legacy')`;
  });
  expect((await (await api(`?jobId=${job.id}`)).json<any>()).summary).toMatchObject({untrackedJobs:1,complete:false,neurons:null});
  await runInDurableObject(report,async(a:any)=>{
    const id=crypto.randomUUID();await a.run({...job,id,expiresAt:0});
    expect((await a.usage({jobId:id})).summary).toMatchObject({complete:true,source:"no_inference",neurons:0,attempts:0});
  });
});
it("authenticates usage reads, rejects invalid/foreign IDs and never starts inference to inspect cost",async()=>{
  expect((await api("",{})).status).toBe(401);
  expect((await api("",{method:"POST",headers:{Authorization:`Bearer ${token}`}})).status).toBe(405);
  for(const query of ["?limit=999","?before=-1","?jobId=wrong",`?jobId=${crypto.randomUUID()}&reportSessionId=${crypto.randomUUID()}`])expect((await api(query)).status).toBe(400);
  expect((await api(`?reportSessionId=${crypto.randomUUID()}`)).status).toBe(404);
  expect((await api(`?jobId=${crypto.randomUUID()}`)).status).toBe(404);
  const list=await (await api()).json<any>();expect(list.sessions).toEqual([]);
  expect(measureUsage({neurons:NaN,prompt_tokens:-1,completion_tokens:Infinity})).toEqual({neurons:null,source:"unavailable"});
});

it("keeps the twelve-inference budget across a retry of an interrupted job",async()=>{
  const {report,job}=await prepareJob();
  await runInDurableObject(report,async(a:any)=>{
    let calls=0;a.onRunError=(error:unknown)=>{throw error;};
    a.env.AI={run:async()=>{
      calls++;if(calls===12)throw Error("provider interrupted");
      return sse([{choices:[{delta:{tool_calls:[{index:0,id:`chat-${calls}`,function:{name:"read_today_chat_sessions",arguments:"{}"}}]}}]},
        {usage:{prompt_tokens:100,completion_tokens:10}}]);
    }};
    await expect(a.run(job)).rejects.toThrow();expect(calls).toBe(12);
  });
  await evictDurableObject(report,{webSockets:"close"});
  await runInDurableObject(report,async(a:any)=>{
    let calls=0;a.onRunError=()=>{};a.env.AI={run:async()=>{calls++;throw Error("unexpected inference");}};
    await a.run(job);expect(calls).toBe(0);
    expect((await a.usage({jobId:job.id})).summary).toMatchObject({attempts:12,incompleteAttempts:1,neurons:null});
  });
});
