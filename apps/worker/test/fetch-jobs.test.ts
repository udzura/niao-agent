import {SELF,env,runInDurableObject,evictDurableObject,reset,createMessageBatch,createExecutionContext,getQueueResult} from "cloudflare:test";
import {getAgentByName} from "agents";
import {afterEach,expect,it,vi} from "vitest";
import worker from "../src/index";
import {NiaoAgent} from "../src/niao-agent";
import {asyncFetchTool,type FetchJobMessage} from "../src/fetch-jobs";

const headers={Authorization:"Bearer test-only-token-000000000000000000000000"};
const base="https://test/agents/niao-agent/personal";
const url="https://articles.example.org/posts/entry";
const sockets:WebSocket[]=[];
afterEach(async()=>{for(const ws of sockets.splice(0))ws.close();await reset();});
const stub=()=>getAgentByName((env as any).NiaoAgent,"personal");
const history=async()=> (await SELF.fetch(`${base}/history`,{headers})).json<any>();
async function until<T>(fn:()=>T|Promise<T>):Promise<NonNullable<T>> {
  for(let i=0;i<400;i++){const found=await fn();if(found)return found as NonNullable<T>;await new Promise(r=>setTimeout(r,10));}
  throw new Error("Expected async job state not reached");
}
async function connect(){
  const response=await SELF.fetch(base,{headers:{...headers,Upgrade:"websocket"}});
  const ws=response.webSocket!;const events:any[]=[];
  ws.addEventListener("message",e=>{events.push(JSON.parse(String(e.data)));});ws.accept();sockets.push(ws);
  await until(()=>events.find(e=>e.type==="ready"));return {ws,events};
}
async function setup(options:{realQueue?:boolean;slow?:boolean;failSummary?:boolean}={}){
  await runInDurableObject(await stub(),(agent:NiaoAgent)=>{
    const a=agent as any;
    a.sent=[];
    if(!options.realQueue)a.sendFetchJob=async(message:FetchJobMessage)=>{a.sent.push(message);};
    a.createModel=(_model:string,_thinking:boolean,tools:any[])=>({async *stream(){
      const tool=tools.find(t=>t.definition.function.name==="web_fetch_async");
      yield {toolStatus:"running",name:"web_fetch_async"};
      const receipt=await tool.execute({url},new AbortController().signal);
      a.receipt=receipt;
      yield {toolStatus:"completed",name:"web_fetch_async"};
      if(options.slow)await new Promise(r=>setTimeout(r,150));
      yield {text:"取得を開始しました"};yield {usage:{neurons:1}};
    }});
    a.createNotificationModel=()=>({async *stream(messages:any[]){
      a.summaryCalls=(a.summaryCalls??0)+1;
      a.summaryInput=messages;
      yield {usage:{neurons:2.5}};
      if(options.failSummary)throw new Error("PRIVATE provider content");
      yield {text:"取得した記事の要約です。[出典](https://articles.example.org/posts/entry)"};
    }});
  });
}
async function start(){
  const client=await connect();const id=crypto.randomUUID();
  client.ws.send(JSON.stringify({v:1,type:"send",requestId:id,content:"この記事を後で読んでおいて",epoch:0}));
  await until(()=>client.events.find(e=>e.type==="committed"));
  return {...client,id};
}
async function payload(){return runInDurableObject(await stub(),(a:any)=>a.sent[0] as FetchJobMessage);}
async function rows(){return runInDurableObject(await stub(),(a:NiaoAgent)=>a.sql<any>`SELECT * FROM niao_fetch_jobs`);}
async function batch(body:unknown,attempts=1,override:any=env){
  const messages=createMessageBatch("niao-fetch-jobs",[{id:crypto.randomUUID(),timestamp:new Date(),attempts,body}]);
  const ctx=createExecutionContext();
  await worker.queue(messages,override);
  return getQueueResult(messages,ctx);
}

it("delivers a real local Queue producer message without a manual consumer invocation",async()=>{
  await setup({realQueue:true});const client=await start();
  await until(()=>client.events.find(e=>e.type==="message_added"));
  expect((await rows())[0]).toMatchObject({status:"notified",dispatchAttempts:1});
  expect((await history()).messages).toHaveLength(3);
});

it("uses the production model/tool loop for enqueueing and a separate tool-free notification inference",async()=>{
  await runInDurableObject(await stub(),(a:any)=>{
    a.modelInputs=[];
    a.env.AI={run:async(_model:string,input:any)=>{
      a.modelInputs.push(input);
      let delta:any;
      if(!input.tools){
        expect(input.chat_template_kwargs.enable_thinking).toBe(false);
        expect(JSON.parse(input.messages[1].content).result.title).toBe("日本語の技術メモ");
        delta={content:"バックグラウンド取得の要約です"};
      }else if(input.messages.at(-1).role==="tool"){
        expect(JSON.parse(input.messages.at(-1).content)).toMatchObject({ok:true,jobId:expect.any(String)});
        delta={content:"取得を受け付けました"};
      }else{
        expect(input.tools.map((t:any)=>t.function.name)).toContain("web_fetch_async");
        expect(input.messages[0].content).toContain("only a job receipt");
        delta={tool_calls:[{index:0,id:"async-read",function:{name:"web_fetch_async",arguments:JSON.stringify({url})}}]};
      }
      return new ReadableStream({start(c){
        c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({choices:[{delta}],usage:{neurons:2}})}\n\ndata: [DONE]\n\n`));c.close();
      }});
    }};
  });
  const client=await start();await until(()=>client.events.find(e=>e.type==="message_added"));
  expect(client.events.filter(e=>e.type==="tool_status").map(e=>e.name)).toEqual(["web_fetch_async","web_fetch_async"]);
  expect((await history()).messages.map((m:any)=>m.content)).toEqual(["この記事を後で読んでおいて","取得を受け付けました","バックグラウンド取得の要約です"]);
  const usage=await(await SELF.fetch(`${base}/usage`,{headers})).json<any>();
  expect(usage.local).toMatchObject({attempts:3,neurons:6});
});

it("runs tool -> durable outbox -> Queue consumer -> real tools RPC -> persisted follow-up and usage",async()=>{
  await setup();const client=await start();const job=await payload();
  const delivery=await batch(job);
  expect(delivery.explicitAcks).toHaveLength(1);expect(delivery.retryMessages).toEqual([]);
  await until(()=>client.events.find(e=>e.type==="message_added"));
  const page=await history();
  expect(page.messages.map((m:any)=>m.role)).toEqual(["user","assistant","assistant"]);
  expect(page.messages[2].content).toContain("記事の要約");
  expect((await rows())[0]).toMatchObject({status:"notified",result:null});
  const usage=await (await SELF.fetch(`${base}/usage`,{headers})).json<any>();
  expect(usage.local).toMatchObject({attempts:2,neurons:3.5});
  await runInDurableObject(await stub(),(a:any)=>{
    expect(a.summaryInput[0].content).toContain("untrusted reference data");
    expect(JSON.parse(a.summaryInput[1].content)).toMatchObject({originalRequest:"この記事を後で読んでおいて",result:{title:"日本語の技術メモ"}});
  });
  await batch(job);await new Promise(r=>setTimeout(r,30));
  expect((await history()).messages).toHaveLength(3);
});

it("defers a fast result until the initiating turn completes",async()=>{
  await setup({slow:true});const client=await connect();const id=crypto.randomUUID();
  client.ws.send(JSON.stringify({v:1,type:"send",requestId:id,content:"後で読んで"}));
  const job=await until(async()=>runInDurableObject(await stub(),(a:any)=>a.sent[0] as FetchJobMessage));
  await batch(job);
  expect(client.events.some(e=>e.type==="message_added")).toBe(false);
  await until(()=>client.events.find(e=>e.type==="message_added"));
  expect(client.events.findIndex(e=>e.type==="committed")).toBeLessThan(client.events.findIndex(e=>e.type==="message_added"));
});

it("deduplicates submissions and the same URL within one turn, retaining distinct later requests",async()=>{
  await setup();
  await runInDurableObject(await stub(),(a:any)=>{
    a.createModel=(_m:any,_t:any,tools:any[])=>({async *stream(){
      const tool=tools.find((t:any)=>t.definition.function.name==="web_fetch_async");
      const first=await tool.execute({url},new AbortController().signal);
      const second=await tool.execute({url:url+"#section"},new AbortController().signal);
      expect(second.jobId).toBe(first.jobId);
      yield {text:"accepted"};
    }});
  });
  const client=await start();expect(await rows()).toHaveLength(1);
  client.ws.send(JSON.stringify({v:1,type:"send",requestId:client.id,content:"この記事を後で読んでおいて"}));
  await new Promise(r=>setTimeout(r,40));expect(await rows()).toHaveLength(1);
  client.ws.send(JSON.stringify({v:1,type:"send",requestId:crypto.randomUUID(),content:"もう一度後で読んで"}));
  await until(async()=> (await rows()).length===2);
});

it("fences concurrent deliveries and stale execution results with leases",async()=>{
  await setup();await start();const job=await payload();const a=await stub();
  const first=await a.claimFetchJob(job);expect(first.action).toBe("run");
  expect(await a.claimFetchJob(job)).toEqual({action:"busy"});
  await runInDurableObject(a,(agent:NiaoAgent)=>{agent.sql`UPDATE niao_fetch_jobs SET leaseUntil=0`;});
  const second=await a.claimFetchJob(job);expect(second.action).toBe("run");
  if(first.action!=="run"||second.action!=="run")throw new Error();
  await a.completeFetchJob(job,first.token,{ok:false,error:"web_fetch_http_error"});
  expect((await rows())[0].status).toBe("running");
  await a.completeFetchJob(job,second.token,{ok:false,error:"web_fetch_http_error"});
  await until(async()=> (await rows())[0].status==="notified");
  expect((await history()).messages.at(-1).content).toContain("取得できませんでした");
});

it("retries transient fetch failures, persists final failures, and drops malformed messages",async()=>{
  await setup();await start();const job=await payload();
  const fake={...(env as any),TOOLS_MISC:{webFetch:async()=>({ok:false,error:"web_fetch_timeout"})}};
  expect((await batch(job,1,fake)).retryMessages).toHaveLength(1);
  expect((await rows())[0].status).toBe("queued");
  expect((await batch(job,5,fake)).explicitAcks).toHaveLength(1);
  await until(async()=> (await rows())[0].status==="notified");
  expect((await batch({...job,url:"http://localhost"})).explicitAcks).toHaveLength(1);
});

it("recovers producer failure and a stale queued job through persisted maintenance",async()=>{
  await setup();
  await runInDurableObject(await stub(),(a:any)=>{a.sendFetchJob=async()=>{throw new Error("PRIVATE queue");};});
  await start();let job=(await rows())[0];expect(job.status).toBe("pending");
  await runInDurableObject(await stub(),async(a:any)=>{
    a.sendFetchJob=async(message:FetchJobMessage)=>a.sent.push(message);
    await a.maintainFetchJob({jobId:job.id});
  });
  expect((await rows())[0].status).toBe("queued");
  await runInDurableObject(await stub(),async(a:any)=>{
    a.sql`UPDATE niao_fetch_jobs SET updatedAt=0`;
    await a.maintainFetchJob({jobId:job.id});
    expect(a.sent).toHaveLength(2);
  });
  expect((await rows())[0].dispatchAttempts).toBe(3);
});

it("preserves an unfinished job and its recovery schedule across eviction",async()=>{
  await setup();const client=await start();const job=await payload();client.ws.close();
  await evictDurableObject(await stub(),{webSockets:"close"});
  expect((await rows())[0]).toMatchObject({id:job.jobId,status:"queued"});
  await runInDurableObject(await stub(),async(a:NiaoAgent)=>{
    const schedules=await a.listSchedules();
    expect(schedules.some(s=>s.callback==="maintainFetchJob"&&(s.payload as any).jobId===job.jobId)).toBe(true);
  });
  const claim=await(await stub()).claimFetchJob(job);expect(claim.action).toBe("run");
  if(claim.action!=="run")throw new Error();
  await(await stub()).completeFetchJob(job,claim.token,{ok:false,error:"web_fetch_http_error"});
  await until(async()=> (await rows())[0].status==="notified");
});

it("expires stale/poisoned jobs and stops recovery schedules after notification",async()=>{
  await setup();await start();const job=await payload();
  await runInDurableObject(await stub(),async(a:any)=>{
    a.sql`UPDATE niao_fetch_jobs SET updatedAt=0,createdAt=0`;
    const schedule=(await a.listSchedules()).find((s:any)=>s.callback==="maintainFetchJob");
    await a.maintainFetchJob({jobId:job.jobId},schedule);
    expect((await a.listSchedules()).some((s:any)=>s.id===schedule.id)).toBe(false);
  });
  expect((await history()).messages.at(-1).content).toContain("web_fetch_job_expired");
});

it("caps outstanding jobs and cannot let background summaries invoke tools",async()=>{
  await setup();
  await runInDurableObject(await stub(),(a:any)=>{
    a.createModel=(_m:any,_t:any,tools:any[])=>({async *stream(){
      const tool=tools.find((t:any)=>t.definition.function.name==="web_fetch_async");
      for(let i=0;i<4;i++){
        const value=await tool.execute({url:url+`?page=${i}`},new AbortController().signal);
        if(i<3)expect(value.ok).toBe(true);else expect(value).toEqual({ok:false,error:"web_fetch_job_limit"});
      }
      yield {text:"accepted"};
    }});
    a.AIInputs=[];
    a.env.AI={run:async(_model:string,input:any)=>{
      a.AIInputs.push(input);
      const data={choices:[{delta:{content:"summary"}}]};
      return new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\ndata: [DONE]\n\n`));c.close();}});
    }};
    // Exercise the production notification model, not the fixture override.
    a.createNotificationModel=NiaoAgent.prototype["createNotificationModel"];
  });
  await start();expect(await rows()).toHaveLength(3);
  await batch(await payload());await until(async()=> (await rows())[0].status==="notified");
  await runInDurableObject(await stub(),(a:any)=>{
    expect(a.AIInputs).toHaveLength(1);expect(a.AIInputs[0].tools).toBeUndefined();
    expect(a.AIInputs[0].chat_template_kwargs.enable_thinking).toBe(false);
  });
});

it("does not refetch after summary failure, retries notification, then provides a bounded fallback",async()=>{
  await setup({failSummary:true});const client=await start();const job=await payload();await batch(job);
  await until(()=>client.events.find(e=>e.type==="notification_deferred"));
  expect((await rows())[0]).toMatchObject({status:"ready",notificationAttempts:1});
  for(let i=0;i<3;i++)await runInDurableObject(await stub(),async(a:any)=>{
    a.sql`UPDATE niao_fetch_jobs SET notificationAfter=0`;
    await a.deliverFetchNotifications();
  });
  expect((await rows())[0].status).toBe("notified");
  expect((await history()).messages.at(-1).content).toContain("要約を生成できませんでした");
  await runInDurableObject(await stub(),(a:any)=>{expect(a.sent).toHaveLength(1);expect(a.summaryCalls).toBe(3);});
});

it("survives offline delivery/Agent eviction and includes notifications in later model context",async()=>{
  await setup();const client=await start();const job=await payload();client.ws.close();
  await batch(job);await until(async()=> (await rows())[0].status==="notified");
  await evictDurableObject(await stub(),{webSockets:"close"});
  const page=await history();expect(page.messages).toHaveLength(3);expect(page.active).toBeNull();
  await runInDurableObject(await stub(),(a:any)=>{
    a.createModel=()=>({async *stream(messages:any[]){
      expect(messages.some(m=>m.content.includes("取得した記事の要約"))).toBe(true);yield {text:"follow-up"};
    }});
  });
  const next=await connect();next.ws.send(JSON.stringify({v:1,type:"send",requestId:crypto.randomUUID(),content:"その記事について"}));
  await until(()=>next.events.find(e=>e.type==="committed"));
});

it("discards late work after history cleanup and does not expose internal completion RPC over HTTP",async()=>{
  await setup();await start();const job=await payload();const a=await stub();const claim=await a.claimFetchJob(job);
  expect((await SELF.fetch(`${base}/history`,{method:"DELETE",headers:{...headers,"If-Match":'"0"'}})).status).toBe(200);
  if(claim.action!=="run")throw new Error();
  await a.completeFetchJob(job,claim.token,{ok:false,error:"web_fetch_http_error"});
  expect(await rows()).toEqual([]);expect((await history()).messages).toEqual([]);
  expect((await batch(job)).explicitAcks).toHaveLength(1);
  expect((await SELF.fetch(`${base}/completeFetchJob`,{method:"POST",headers})).status).toBe(404);
  expect((await SELF.fetch(`${base}/jobs`)).status).toBe(401);
});

it("enforces URL/schema limits and aborts before accepting jobs",async()=>{
  const enqueue=vi.fn();const tool=asyncFetchTool(enqueue);const signal=new AbortController().signal;
  for(const args of [{url:"http://127.0.0.1"},{url:"https://user:pass@example.org"},{url:"file:///etc/passwd"},{url,url2:url}])
    expect(await tool.execute(args,signal)).toMatchObject({ok:false});
  const abort=new AbortController();abort.abort();await expect(tool.execute({url},abort.signal)).rejects.toThrow();
  expect(enqueue).not.toHaveBeenCalled();
});
