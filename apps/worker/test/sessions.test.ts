import {SELF,env,runInDurableObject,reset,evictDurableObject} from "cloudflare:test";
import {getAgentByName} from "agents";
import {afterEach,expect,it} from "vitest";
import {NiaoAgent} from "../src/niao-agent";
import {sessionLimits} from "../src/sessions";
const base="https://test/agents/niao-agent/personal";
const auth={Authorization:"Bearer test-only-token-000000000000000000000000"};
const sockets:WebSocket[]=[];
afterEach(async()=>{for(const ws of sockets.splice(0)) ws.close();await reset();});
const stub=()=>getAgentByName((env as any).NiaoAgent,"personal");
async function api(path="",method="GET",body?:unknown,epoch?:number) {
  const response=await SELF.fetch(`${base}/sessions${path}`,{method,headers:{...auth,...(body!==undefined ? {"Content-Type":"application/json"} : {}),...(epoch!==undefined ? {"If-Match":`"${epoch}"`} : {})},...(body!==undefined ? {body:JSON.stringify(body)} : {})});
  return new Response(await response.arrayBuffer(),{status:response.status,headers:response.headers});
}
async function create(title="新しい会話") {const response=await api("","POST",{title});expect(response.status).toBe(201);return (await response.json<any>()).session;}
async function history(id:string,query="") {const response=await api(`/${id}/history${query}`);expect(response.status).toBe(200);return response.json<any>();}
async function model() {
  await runInDurableObject(await stub(),(a:NiaoAgent)=>{
    (a as any).createModel=()=>({async *stream(messages:any[]) {
      yield {text:messages.filter(m=>m.role==="user").map(m=>m.content).join("|")};
    }});
  });
}
async function connect(v=2) {
  const response=await SELF.fetch(`${base}?protocol=${v}`,{headers:{...auth,Upgrade:"websocket"}});
  expect(response.status).toBe(101);const ws=response.webSocket!,events:any[]=[];
  ws.addEventListener("message",e=>{events.push(JSON.parse(e.data as string));});ws.accept();sockets.push(ws);
  async function until(predicate:(e:any)=>boolean) {
    for(let i=0;i<250;i++){const found=events.find(predicate);if(found)return found;await new Promise(r=>setTimeout(r,5));}
    throw new Error("missing session event");
  }
  await until(e=>e.type==="ready");return {ws,events,until};
}
function send(ws:WebSocket,sessionId:string,content:string,requestId=crypto.randomUUID(),epoch=0) {
  ws.send(JSON.stringify({v:2,type:"send",sessionId,content,requestId,epoch}));return requestId;
}
it("authenticates session endpoints before routing and validates payloads",async()=>{
  expect((await SELF.fetch(`${base}/sessions`)).status).toBe(401);
  for(const body of [{title:""},{title:"a".repeat(101)},{id:"injected"},null]) expect((await api("","POST",body)).status).toBe(400);
  const s=await create();expect((await api(`/${s.id}`,"PATCH",{archived:"yes"})).status).toBe(400);
  expect((await api(`/${s.id}/history?after=-1`)).status).toBe(400);
  expect((await api(`/${s.id}`,"DELETE")).status).toBe(428);
});
it("multiplexes one socket, isolates context and retries, and excludes other sessions from v1",async()=>{
  const a=await create(),b=await create();await model();const client=await connect(),legacy=await connect(1);
  const id=send(client.ws,a.id,"秘密A");await client.until(e=>e.type==="committed"&&e.requestId===id);
  const id2=send(client.ws,b.id,"質問B");const second=await client.until(e=>e.type==="committed"&&e.requestId===id2);
  expect(second).toMatchObject({v:2,sessionId:b.id,epoch:0});expect(second.messages[1].content).toBe("質問B");
  send(client.ws,b.id,"秘密A",id);expect(await client.until(e=>e.type==="error"&&e.requestId===id)).toMatchObject({code:"id_conflict",sessionId:b.id});
  send(client.ws,a.id,"秘密A",id);await new Promise(r=>setTimeout(r,20));
  expect((await history(a.id)).messages).toHaveLength(2);expect((await history(b.id)).messages).toHaveLength(2);
  expect(legacy.events.some(e=>["partial","accepted","committed","sessions_updated"].includes(e.type))).toBe(false);
  expect((await (await SELF.fetch(`${base}/history`,{headers:auth})).json<any>()).messages).toEqual([]);
  expect((await api()).status).toBe(200);
});
it("negotiates v2 explicitly instead of accepting session sends on v1",async()=>{
  const s=await create(),client=await connect(1);send(client.ws,s.id,"wrong connection");
  expect(await client.until(e=>e.type==="error")).toMatchObject({code:"protocol_mismatch"});
  expect((await history(s.id)).messages).toEqual([]);
});
it("keeps one inference gate while allowing other sessions to be browsed and created",async()=>{
  const a=await create(),b=await create();
  await runInDurableObject(await stub(),(agent:NiaoAgent)=>{(agent as any).createModel=()=>({async *stream(){await new Promise(r=>setTimeout(r,150));yield {text:"done"};}});});
  const c=await connect();const id=send(c.ws,a.id,"first");await c.until(e=>e.type==="accepted");
  const other=send(c.ws,b.id,"second");expect(await c.until(e=>e.type==="error"&&e.requestId===other)).toMatchObject({code:"busy",sessionId:b.id});
  expect((await api(`/${a.id}`,"DELETE",undefined,0)).status).toBe(409);
  expect((await history(b.id)).messages).toEqual([]);await create("during inference");
  await c.until(e=>e.type==="committed"&&e.requestId===id);
});
it("preserves migrated IDs, sequence, epoch, thinking and pending jobs across eviction",async()=>{
  await stub();await runInDurableObject(await stub(),(a:NiaoAgent)=>{
    a.sql`INSERT INTO niao_messages (seq,id,requestId,role,content,createdAt) VALUES (42,'old','old','assistant','saved','2026-11-01T00:00:00.000Z')`;
    a.sql`INSERT INTO niao_thinking VALUES ('old',0,'thought','legacy')`;
    a.sql`INSERT INTO niao_turns (requestId,status) VALUES ('old','completed')`;
    a.sql`UPDATE niao_settings SET epoch=4 WHERE id=1`;
    a.sql`INSERT INTO niao_reminders (id,epoch,requestId,minutes,message,dueAt,status) VALUES ('job',4,'old',5,'future',${Date.now()+300000},'pending')`;
    a.sql`DROP TABLE niao_sessions`;a.sql`DROP TABLE niao_session_state`;
  });
  await evictDurableObject(await stub());const page=await history("legacy");
  expect(page.epoch).toBe(4);expect(page.messages[0]).toMatchObject({id:"old",seq:42,content:"saved",thinking:[{text:"thought",generation:0,active:false}]});
  expect(page.jobs.items[0]).toMatchObject({id:"job",sessionId:"legacy"});
  await evictDurableObject(await stub());expect((await history("legacy")).messages[0].seq).toBe(42);
  await runInDurableObject(await stub(),async(a:NiaoAgent)=>{expect((await a.listSchedules()).filter(s=>s.callback==="expireSessions")).toHaveLength(1);});
});
it("paginates newest messages and older pages without gaps or crossing sessions",async()=>{
  const a=await create(),b=await create();await runInDurableObject(await stub(),(agent:NiaoAgent)=>{
    for(let i=0;i<205;i++) agent.sql`INSERT INTO niao_messages (id,requestId,role,content,createdAt,sessionId) VALUES (${`m${i}`},${`m${i}`},'assistant',${String(i)},${new Date().toISOString()},${a.id})`;
    agent.sql`INSERT INTO niao_messages (id,requestId,role,content,createdAt,sessionId) VALUES ('other','other','assistant','other',${new Date().toISOString()},${b.id})`;
  });
  const latest=await history(a.id,"?latest=1");expect(latest.messages).toHaveLength(100);expect(latest.hasOlder).toBe(true);
  const previous=await history(a.id,`?before=${latest.beforeCursor}`),first=await history(a.id,`?before=${previous.beforeCursor}`);
  expect([...first.messages,...previous.messages,...latest.messages].map(m=>m.content)).toEqual(Array.from({length:205},(_,i)=>String(i)));
  expect(first.hasOlder).toBe(false);expect((await history(a.id,`?after=${latest.cursor}`)).messages).toEqual([]);
});
it("separates metadata updates and reads from activity, and expires inactive archives",async()=>{
  const a=await create(),b=await create();const old=new Date(Date.now()-31*86400000).toISOString();
  await runInDurableObject(await stub(),(agent:NiaoAgent)=>{agent.sql`UPDATE niao_sessions SET lastActivityAt=${old} WHERE id=${a.id}`;});
  expect((await api(`/${a.id}`,"PATCH",{title:"renamed",archived:true})).status).toBe(200);
  const page=await history(a.id);expect(page.sessions.items.find((s:any)=>s.id===a.id)).toMatchObject({lastActivityAt:old,title:"renamed"});
  const client=await connect();await runInDurableObject(await stub(),async(agent:NiaoAgent)=>{await agent.expireSessions();});
  expect(await client.until(e=>e.type==="session_deleted"&&e.sessionId===a.id)).toMatchObject({reason:"expired"});
  expect((await api(`/${a.id}/history`)).status).toBe(404);expect((await api(`/${b.id}/history`)).status).toBe(200);
});
it("defers expiry for pending reminders, then refreshes activity on delivery",async()=>{
  const a=await create();const old=new Date(Date.now()-31*86400000).toISOString();
  await runInDurableObject(await stub(),async(agent:NiaoAgent)=>{
    agent.sql`UPDATE niao_sessions SET lastActivityAt=${old} WHERE id=${a.id}`;
    agent.sql`INSERT INTO niao_reminders (id,epoch,requestId,minutes,message,dueAt,status,sessionId) VALUES ('reminder',0,'origin',1,'お茶',${Date.now()+60000},'pending',${a.id})`;
    await agent.expireSessions();
  });
  expect((await api(`/${a.id}/history`)).status).toBe(200);
  await runInDurableObject(await stub(),async(agent:NiaoAgent)=>{
    agent.sql`UPDATE niao_reminders SET dueAt=0 WHERE id='reminder'`;
    await agent.maintainReminder({jobId:"reminder"});await agent.expireSessions();
  });
  const page=await history(a.id);expect(page.messages[0].content).toContain("お茶");
  expect(page.sessions.items.find((s:any)=>s.id===a.id).lastActivityAt>old).toBe(true);
});
it("deletes only the target, cancels schedules, rejects stale sends and late fetch completion",async()=>{
  const a=await create(),b=await create();await model();const c=await connect();const id=send(c.ws,a.id,"delete me");await c.until(e=>e.type==="committed");
  const jobId=crypto.randomUUID();await runInDurableObject(await stub(),async(agent:NiaoAgent)=>{
    const now=Date.now();agent.sql`INSERT INTO niao_fetch_jobs (id,epoch,requestId,url,status,createdAt,updatedAt,sessionId,runToken) VALUES (${jobId},0,${id},'https://example.org','running',${now},${now},${a.id},'lease')`;
    await agent.scheduleEvery(60,"maintainFetchJob",{jobId});
  });
  expect((await api(`/${a.id}`,"DELETE",undefined,1)).status).toBe(409);
  expect((await api(`/${a.id}`,"DELETE",undefined,0)).status).toBe(200);
  await runInDurableObject(await stub(),async(agent:NiaoAgent)=>{
    await agent.completeFetchJob({v:1,kind:"web_fetch",jobId,epoch:0},"lease",{ok:false,error:"web_fetch_timeout"});
    expect(agent.sql`SELECT id FROM niao_fetch_jobs WHERE id=${jobId}`).toHaveLength(0);
    expect((await agent.listSchedules()).filter(s=>(s.payload as any)?.jobId===jobId)).toHaveLength(0);
  });
  const stale=send(c.ws,a.id,"stale");expect(await c.until(e=>e.type==="error"&&e.requestId===stale)).toMatchObject({code:"session_not_found"});
  expect((await history(b.id)).messages).toEqual([]);
  c.ws.close();await evictDurableObject(await stub(),{webSockets:"close"});expect((await api(`/${a.id}/history`)).status).toBe(404);
});
it("clears one history and fences its epoch without clearing other sessions or settings",async()=>{
  const a=await create(),b=await create();await model();const c=await connect();const id=send(c.ws,a.id,"A");await c.until(e=>e.type==="committed");
  const id2=send(c.ws,b.id,"B");await c.until(e=>e.type==="committed"&&e.requestId===id2);
  expect((await api(`/${a.id}/history`,"DELETE",undefined,0)).status).toBe(200);
  expect((await history(a.id)).epoch).toBe(1);expect((await history(b.id)).messages).toHaveLength(2);
  const stale=send(c.ws,a.id,"old",crypto.randomUUID(),0);expect(await c.until(e=>e.type==="error"&&e.requestId===stale)).toMatchObject({code:"history_changed"});
});
it("routes background fetch completion back to its originating session",async()=>{
  const a=await create(),b=await create(),jobId=crypto.randomUUID();const client=await connect(),legacy=await connect(1);
  await runInDurableObject(await stub(),async(agent:NiaoAgent)=>{
    const now=Date.now();agent.sql`INSERT INTO niao_fetch_jobs (id,epoch,requestId,url,status,createdAt,updatedAt,sessionId,runToken) VALUES (${jobId},0,'origin','https://example.org','running',${now},${now},${a.id},'lease')`;
    await agent.completeFetchJob({v:1,kind:"web_fetch",jobId,epoch:0},"lease",{ok:false,error:"web_fetch_timeout"});
    await agent.deliverFetchNotifications();
  });
  expect(await client.until(e=>e.type==="message_added")).toMatchObject({sessionId:a.id});
  expect((await history(a.id)).messages).toHaveLength(1);expect((await history(b.id)).messages).toEqual([]);
  expect(legacy.events.some(e=>e.type==="message_added")).toBe(false);
});
it("bounds the number of sessions and admission size without silently deleting history",async()=>{
  await api();await runInDurableObject(await stub(),(a:NiaoAgent)=>{
    const now=new Date().toISOString();for(let i=1;i<sessionLimits.count;i++) a.sql`INSERT INTO niao_sessions (id,title,createdAt,updatedAt,lastActivityAt,archivedAt,epoch) VALUES (${`limit-${i}`},'keep',${now},${now},${now},NULL,0)`;
    for(let i=0;i<8;i++) a.sql`INSERT INTO niao_messages (id,requestId,role,content,createdAt) VALUES (${`large-${i}`},${`large-${i}`},'assistant',${"x".repeat(1024*1024-100)},${now})`;
  });
  expect((await api("","POST",{})).status).toBe(409);
  const c=await connect();const id=send(c.ws,"legacy","more");expect(await c.until(e=>e.type==="error"&&e.requestId===id)).toMatchObject({code:"session_full"});
  expect((await history("legacy")).messages).toHaveLength(8);
});
it("captures the originating session when tools enqueue work with a different legacy epoch",async()=>{
  const session=await create();
  await runInDurableObject(await stub(),(agent:NiaoAgent)=>{
    agent.sql`UPDATE niao_settings SET epoch=7 WHERE id=1`;
    (agent as any).sendFetchJob=async()=>{};
    (agent as any).createModel=(_id:unknown,_thinking:unknown,tools:any[])=>({async *stream(){
      const fetch=tools.find(t=>t.definition.function.name==="web_fetch_async");
      const reminder=tools.find(t=>t.definition.function.name==="set_reminder");
      expect(await fetch.execute({url:"https://example.org"},new AbortController().signal)).toMatchObject({ok:true});
      expect(await reminder.execute({minutes:5,message:"確認する"},new AbortController().signal)).toMatchObject({ok:true});
      yield {text:"accepted"};
    }});
  });
  const c=await connect(),id=send(c.ws,session.id,"後で取得して");await c.until(e=>e.type==="committed"&&e.requestId===id);
  const page=await history(session.id);expect(page.jobs.items).toHaveLength(2);
  expect(page.jobs.items.every((j:any)=>j.sessionId===session.id)).toBe(true);
  await runInDurableObject(await stub(),(agent:NiaoAgent)=>{
    const job=agent.sql<{id:string;epoch:number;sessionId:string}>`SELECT id,epoch,sessionId FROM niao_fetch_jobs`[0];
    expect(job).toMatchObject({epoch:0,sessionId:session.id});
    expect(agent.claimFetchJob({v:1,kind:"web_fetch",jobId:job.id,epoch:0})).toMatchObject({action:"run"});
  });
  const legacy=await (await SELF.fetch(`${base}/jobs`,{headers:auth})).json<any>();expect(legacy.jobs.items).toEqual([]);
  expect((await api(`/${session.id}`,"DELETE",undefined,0)).status).toBe(200);
});
it("preserves active expired conversations until inference commits fresh activity",async()=>{
  const a=await create();await runInDurableObject(await stub(),(agent:NiaoAgent)=>{
    (agent as any).createModel=()=>({async *stream(){await new Promise(r=>setTimeout(r,100));yield {text:"fresh"};}});
  });
  const c=await connect(),id=send(c.ws,a.id,"active");await c.until(e=>e.type==="accepted"&&e.requestId===id);
  await runInDurableObject(await stub(),async(agent:NiaoAgent)=>{
    agent.sql`UPDATE niao_sessions SET lastActivityAt=${new Date(Date.now()-31*86400000).toISOString()} WHERE id=${a.id}`;
    await agent.expireSessions();expect(agent.sql`SELECT id FROM niao_sessions WHERE id=${a.id}`).toHaveLength(1);
  });
  await c.until(e=>e.type==="committed"&&e.requestId===id);
  const result=await history(a.id);expect(result.sessions.items.find((s:any)=>s.id===a.id).messageCount).toBe(2);
});
