import {SELF,env,runInDurableObject,evictDurableObject,reset} from "cloudflare:test";
import {getAgentByName} from "agents";
import {afterEach,expect,it} from "vitest";
import {reminderTool} from "../src/reminder";
const headers={Authorization:"Bearer test-only-token-000000000000000000000000"};
const base="https://test/agents/niao-agent/personal";
const stub=()=>getAgentByName((env as any).NiaoAgent,"personal");
const sockets:WebSocket[]=[];
afterEach(async()=>{for(const ws of sockets.splice(0))ws.close();await reset();});
async function until<T>(fn:()=>T|Promise<T>):Promise<NonNullable<T>> {
  for(let i=0;i<400;i++){const v=await fn();if(v)return v as NonNullable<T>;await new Promise(r=>setTimeout(r,10));}throw Error("timed out");
}
async function setup(){
  await runInDurableObject(await stub(),(a:any)=>{a.createModel=(_m:any,_t:any,tools:any[])=>({async *stream(){
    const tool=tools.find((t:any)=>t.definition.function.name==="set_reminder");
    a.receipt=await tool.execute({minutes:5,message:"お茶を飲む"},new AbortController().signal);
    a.duplicate=await tool.execute({minutes:5,message:"お茶を飲む"},new AbortController().signal);
    yield {text:"設定しました"};
  }});});
  const response=await SELF.fetch(base,{headers:{...headers,Upgrade:"websocket"}});
  const ws=response.webSocket!,events:any[]=[];ws.addEventListener("message",e=>events.push(JSON.parse(String(e.data))));ws.accept();sockets.push(ws);
  await until(()=>events.find(e=>e.type==="ready"));ws.send(JSON.stringify({v:1,type:"send",requestId:crypto.randomUUID(),content:"5分後に教えて",epoch:0}));
  await until(()=>events.find(e=>e.type==="committed"));return {ws,events};
}
const history=async()=>await(await SELF.fetch(`${base}/history`,{headers})).json<any>();
it("persists and deduplicates, waits until due and delivers once after eviction",async()=>{
  const client=await setup();const id=await runInDurableObject(await stub(),async(a:any)=>{
    expect(a.receipt).toEqual(a.duplicate);const id=a.receipt.jobId;
    const scheduled=(await a.listSchedules()).filter((s:any)=>s.callback==="maintainReminder");
    expect(scheduled).toHaveLength(2);
    const dueAt=a.sql`SELECT dueAt FROM niao_reminders WHERE id=${id}`[0].dueAt;
    const firstWake=Math.min(...scheduled.map((s:any)=>s.time*1000));
    expect(firstWake).toBeGreaterThanOrEqual(dueAt);
    expect(firstWake-dueAt).toBeLessThan(1000);
    await a.maintainReminder({jobId:id});expect(a.sql`SELECT status FROM niao_reminders`[0].status).toBe("pending");return id;
  });
  const before=(await history()).jobs;
  expect(before.items).toEqual([{id,kind:"reminder",title:"お茶を飲む",status:"scheduled",dueAt:expect.any(String)}]);
  expect(client.events.some(e=>e.type==="jobs_updated" && e.jobs.items[0]?.id===id)).toBe(true);
  client.ws.close();await evictDurableObject(await stub(),{webSockets:"close"});
  const resumed=(await history()).jobs;
  expect(resumed.items).toEqual(before.items);expect(resumed.revision).toBeGreaterThan(before.revision);
  await runInDurableObject(await stub(),async(a:any)=>{a.sql`UPDATE niao_reminders SET dueAt=0 WHERE id=${id}`;await a.maintainReminder({jobId:id});await a.maintainReminder({jobId:id});});
  expect((await history()).messages.map((m:any)=>m.content)).toEqual(["5分後に教えて","設定しました","リマインダー: お茶を飲む"]);
  expect((await history()).jobs.items).toEqual([]);
});
it("defers during a turn and ignores jobs after history deletion",async()=>{
  await setup();const id=await runInDurableObject(await stub(),async(a:any)=>{
    const id=a.receipt.jobId;a.sql`UPDATE niao_reminders SET dueAt=0 WHERE id=${id}`;a.active={requestId:"busy",text:""};
    await a.maintainReminder({jobId:id});expect(a.sql`SELECT status FROM niao_reminders`[0].status).toBe("pending");a.active=null;return id;
  });
  expect((await SELF.fetch(`${base}/history`,{method:"DELETE",headers:{...headers,"If-Match":'"0"'}})).status).toBe(200);
  await runInDurableObject(await stub(),async(a:any)=>{await a.maintainReminder({jobId:id});});expect((await history()).messages).toEqual([]);
  expect((await history()).jobs.items).toEqual([]);
});
it("validates inputs before enqueueing",async()=>{
  let called=false;const tool=reminderTool(async()=>{called=true;});const signal=new AbortController().signal;
  for(const args of [{minutes:0,message:"x"},{minutes:1.5,message:"x"},{minutes:43201,message:"x"},{minutes:1,message:" "},{minutes:1,message:"x",extra:true}])
    expect(await tool.execute(args,signal)).toEqual({ok:false,error:"invalid_tool_arguments"});
  expect(called).toBe(false);
});
it("delivers an idle reminder from the SDK alarm without another user message",async()=>{
  const client=await setup();
  await runInDurableObject(await stub(),async(a:any)=>{
    const id=a.receipt.jobId;
    a.sql`UPDATE niao_reminders SET dueAt=${Date.now()-1} WHERE id=${id}`;
    await a.schedule(0,"maintainReminder",{jobId:id});
  });
  const event=await until(()=>client.events.find(e=>e.type==="message_added"));
  expect(event.requestId).toMatch(/^reminder:/);
  expect(event.message.content).toContain("お茶を飲む");
  expect(client.events.filter(e=>e.type==="committed")).toHaveLength(1);
});
it("repairs an early SDK wake and still delivers while the conversation is idle",async()=>{
  const client=await setup();
  await runInDurableObject(await stub(),async(a:any)=>{
    const id=a.receipt.jobId, dueAt=Date.now()+1200;
    a.sql`UPDATE niao_reminders SET dueAt=${dueAt} WHERE id=${id}`;
    // The SDK stores Date schedules in whole seconds, so callbacks may arrive
    // before a millisecond-precision row deadline. Reproduce that early wake.
    await a.maintainReminder({jobId:id});
    const wakes=(await a.listSchedules()).filter((s:any)=>s.callback==="maintainReminder" && s.payload?.jobId===id);
    expect(wakes.some((s:any)=>s.time*1000>=dueAt && s.time*1000<dueAt+1000)).toBe(true);
    expect(a.sql`SELECT status FROM niao_reminders WHERE id=${id}`[0].status).toBe("pending");
  });
  const event=await until(()=>client.events.find(e=>e.type==="message_added"));
  expect(event.requestId).toMatch(/^reminder:/);
  expect(client.events.filter(e=>e.type==="committed")).toHaveLength(1);
});

it("recovers overdue reminders on startup without another user submission",async()=>{
  const client=await setup();
  await runInDurableObject(await stub(),(a:any)=>{a.sql`UPDATE niao_reminders SET dueAt=0`;});
  client.ws.close();await evictDurableObject(await stub(),{webSockets:"close"});
  const resumed=await history();
  expect(resumed.messages.at(-1).content).toBe("リマインダー: お茶を飲む");
  expect(resumed.jobs.items).toEqual([]);
  expect(resumed.messages.filter((m:any)=>m.role==="user")).toHaveLength(1);
});
it("defers during a real response and delivers as soon as that response completes",async()=>{
  const client=await setup();
  await runInDurableObject(await stub(),(a:any)=>{
    a.createModel=()=>({async *stream(){await new Promise(r=>setTimeout(r,600));yield {text:"作業が終わりました"};}});
  });
  const requestId=crypto.randomUUID();
  client.ws.send(JSON.stringify({v:1,type:"send",requestId,content:"作業して",epoch:0}));
  await until(()=>client.events.find(e=>e.type==="accepted"&&e.requestId===requestId));
  await runInDurableObject(await stub(),async(a:any)=>{
    const id=a.receipt.jobId;a.sql`UPDATE niao_reminders SET dueAt=0 WHERE id=${id}`;
    await a.schedule(0,"maintainReminder",{jobId:id});
  });
  await until(()=>client.events.find(e=>e.type==="message_added"));
  const finished=client.events.findIndex(e=>e.type==="committed"&&e.requestId===requestId);
  const reminder=client.events.findIndex(e=>e.type==="message_added");
  expect(finished).toBeGreaterThanOrEqual(0);
  expect(reminder).toBeGreaterThan(finished);
  expect(client.events.filter(e=>e.type==="committed")).toHaveLength(2);
});
