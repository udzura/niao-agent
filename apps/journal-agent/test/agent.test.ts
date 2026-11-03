import {env,applyD1Migrations,reset,runInDurableObject,evictDurableObject} from "cloudflare:test";
import {getAgentByName} from "agents";
import {beforeEach,afterEach,expect,it} from "vitest";
import {latestRelease,RELEASE_URL,localTool} from "../src/tools";
import {z} from "zod";
import journalWorker from "../src/index";
import {consumeJournalResults} from "../../worker/src/journal-results";
import {Articles} from "../../journal/src/core/articles";
const bindings=env as any;
beforeEach(async()=>{await applyD1Migrations(bindings.TEST_DB,bindings.TEST_MIGRATIONS);});
afterEach(async()=>{await reset();});
it("reads the official GitHub latest-release API directly without fallback requests",async()=>{
  const urls:string[]=[];
  const result=await latestRelease(new AbortController().signal,async(input)=>{
    urls.push(String(input));return Response.json({tag_name:"1.0",body:"Release notes",html_url:"https://github.com/udzura/niao-agent/releases/tag/1.0",published_at:"2026-11-03T00:00:00Z"});
  });
  expect(urls).toEqual(["https://api.github.com/repos/udzura/niao-agent/releases/latest"]);expect(result.sourceUrl).toBe(RELEASE_URL);expect(result.untrusted_reference_data).toBe(true);
  urls.length=0;
  await expect(latestRelease(new AbortController().signal,async(input)=>{urls.push(String(input));return new Response(null,{status:503});})).rejects.toThrow("release_unavailable");
  expect(urls).toEqual([RELEASE_URL]);
});
it("uses Gemma with thinking off, 4096 output tokens and no more than six inference rounds",async()=>{
  const report=await getAgentByName(bindings.JournalAgent,crypto.randomUUID());
  await runInDurableObject(report,async(a:any)=>{
    let calls=0;
    a.env.AI={run:async(model:string,input:any)=>{
      calls++;expect(model).toBe("@cf/google/gemma-4-26b-a4b-it");expect(input.reasoning_effort).toBeUndefined();
      expect(input.chat_template_kwargs.enable_thinking).toBe(false);expect(input.max_completion_tokens).toBe(4096);
      expect(input.tool_choice).toBe(calls===6 ? "none" : "auto");
      return new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call","function":{"name":"read","arguments":"{}"}}]}}]}\n\ndata: [DONE]\n\n'));c.close();}});
    }};
    const model=a.createModel([{definition:{type:"function",function:{name:"read",parameters:{type:"object"}}},execute:async()=>({ok:true})}],()=>{});
    await expect((async()=>{for await(const _ of model.stream([{role:"user",content:"日報"}],new AbortController().signal)){}})()).rejects.toMatchObject({code:"tool_limit"});
    expect(calls).toBe(6);
  });
});
it("uses an optional GitHub credential and exposes safe rate-limit/authentication errors",async()=>{
  const token="test-github-token-0000000000000000",signal=new AbortController().signal;
  for(const configured of [undefined,token]){
    await expect(latestRelease(signal,async(input,init)=>{
      expect(String(input)).toBe(RELEASE_URL);expect(new Headers(init?.headers).get("Authorization")).toBe(configured ? `Bearer ${token}` : null);
      expect(init?.redirect).toBe("manual");return new Response("private response must not leak",{status:401});
    },configured)).rejects.toMatchObject({code:"release_unauthorized",details:{httpStatus:401}});
  }
  const tool=localTool("release","test",z.strictObject({}),(_args,s)=>latestRelease(s,async()=>new Response(token,{status:403,
    headers:{"x-ratelimit-remaining":"0","x-ratelimit-reset":"1793637405","retry-after":"60"}}),token));
  const error=await tool.execute({},signal);
  expect(error).toEqual({ok:false,error:"release_rate_limited",httpStatus:403,rateLimitRemaining:0,rateLimitReset:1793637405,retryAfterSeconds:60});
  expect(JSON.stringify(error)).not.toContain(token);
});
it("keeps context across queued prompts and isolate eviction, deduplicates MCP writes and expires at 12h",async()=>{
  const id=crypto.randomUUID(),jobId=crypto.randomUUID(),start=Date.now();
  const job={id:jobId,sessionId:"legacy",epoch:0,requestId:"r",prompt:"日報を書いて",reportSessionId:id,createdAt:start,expiresAt:start+12*3600000,status:"running",dispatchedAt:start,result:null};
  const main=await getAgentByName(bindings.NiaoAgent,"personal");
  await runInDurableObject(main,(a:any)=>{
    a.sql`INSERT INTO niao_report_jobs(id,sessionId,epoch,requestId,prompt,reportSessionId,createdAt,expiresAt,status) VALUES (${job.id},'legacy',0,'r',${job.prompt},${id},${start},${job.expiresAt},'running')`;
  });
  const report=await getAgentByName(bindings.JournalAgent,id);
  await runInDurableObject(report,async(a:any)=>{
    a.onRunError=(error:unknown)=>{throw error;};
    a.createModel=(tools:any[],checkpoint:any)=>({async *stream(messages:any[]){
      expect(tools.map(t=>t.definition.function.name)).toContain("read_today_chat_sessions");
      expect(tools.map(t=>t.definition.function.name)).toContain("get_niao_latest_release");
      const create=tools.find(t=>t.definition.function.name==="journal_create_draft");
      const args={title:"検証用の下書き",bodyMarkdown:"これは日報の検証です。"};
      const one=await create.execute(args,new AbortController().signal),two=await create.execute(args,new AbortController().signal);
      expect(one).toEqual(two);
      expect(await tools.find(t=>t.definition.function.name==="journal_publish_article").execute({},new AbortController().signal)).toMatchObject({error:"explicit_publication_instruction_required"});
      checkpoint([...messages,{role:"assistant",content:"下書きを保存しました"}]);yield {text:"下書きを保存しました"};
    }});
    expect(await a.run(job)).toBe("下書きを保存しました");expect(await a.run(job)).toBe("下書きを保存しました");
  });
  expect((await bindings.TEST_DB.prepare("SELECT COUNT(*) AS n FROM articles").first()).n).toBe(1);
  await evictDurableObject(report,{webSockets:"close"});
  await runInDurableObject(report,async(a:any)=>{
    a.createModel=(_tools:any[],checkpoint:any)=>({async *stream(messages:any[]){
      expect(messages.some(m=>m.content==="下書きを保存しました")).toBe(true);
      checkpoint([...messages,{role:"assistant",content:"続けて確認しました"}]);yield {text:"続けて確認しました"};
    }});
    expect(await a.run({...job,id:crypto.randomUUID(),prompt:"その続きを確認して"})).toBe("続けて確認しました");
    expect(a.sql`SELECT expiresAt FROM report_meta`[0].expiresAt).toBe(job.expiresAt);
    a.sql`UPDATE report_meta SET expiresAt=0`;await a.expire();
    const answer=await a.run({...job,id:crypto.randomUUID(),expiresAt:0});expect(answer).toContain("有効期限");
    expect(a.sql`SELECT context FROM report_meta`[0].context).toBe("[]");
  });
});
it("delivers a prompt Queue job and a result Queue job end to end without blocking the main turn",async()=>{
  const main=await getAgentByName(bindings.NiaoAgent,"personal");
  const receipt=await runInDurableObject(main,async(a:any)=>{
    a.env.JOURNAL_PROMPTS={send:async()=>{}};a.active={requestId:"queue-request",sessionId:"legacy"};
    const receipt=await a.enqueueJournalAgent({prompt:"今日の日記の下書きを作成して"},"queue-request",0);a.active=null;return receipt;
  });
  const report=await getAgentByName(bindings.JournalAgent,receipt.reportSessionId);
  await runInDurableObject(report,(a:any)=>{
    a.createModel=(tools:any[],checkpoint:any)=>({async *stream(messages:any[]){
      const chats=await tools.find(t=>t.definition.function.name==="read_today_chat_sessions").execute({},new AbortController().signal);
      expect(chats.timeZone).toBe("Asia/Tokyo");
      checkpoint([...messages,{role:"assistant",content:"日報の下書きを確認できます"}]);yield {text:"日報の下書きを確認できます"};
    }});
  });
  const replies:any[]=[];let ack=0;
  const envelope={v:1,kind:"journal_agent",jobId:receipt.jobId};
  await journalWorker.queue({messages:[{body:envelope,ack:()=>{ack++;},retry:()=>{throw Error("retry");}}]} as any,
    {...bindings,JOURNAL_RESULTS:{send:async(body:any)=>{replies.push(body);}}});
  expect(ack).toBe(1);expect(replies).toEqual([{v:1,kind:"journal_agent_result",jobId:receipt.jobId,reportSessionId:receipt.reportSessionId}]);
  for(let i=0;i<2;i++)await consumeJournalResults({messages:[{body:replies[0],ack:()=>{},retry:()=>{throw Error("retry");}}]} as any,bindings);
  await runInDurableObject(main,(a:any)=>{
    expect(a.sql`SELECT content FROM niao_messages WHERE requestId LIKE 'journal-agent:%'`).toEqual([{content:"日報の下書きを確認できます"}]);
  });
});
it("presents the draft and publishes only the user-approved revision through asynchronous jobs",async()=>{
  const main=await getAgentByName(bindings.NiaoAgent,"personal");
  const enqueue=async(content:string)=>runInDurableObject(main,async(a:any)=>{
    const requestId=crypto.randomUUID();a.env.JOURNAL_PROMPTS={send:async()=>{}};
    a.sql`INSERT INTO niao_messages(id,requestId,role,content,createdAt,sessionId) VALUES (${requestId},${requestId},'user',${content},${new Date().toISOString()},'legacy')`;
    a.active={requestId,sessionId:"legacy"};const receipt=await a.enqueueJournalAgent({prompt:content},requestId,0);a.active=null;return receipt;
  });
  const receipt=await enqueue("日報の下書きを作成して"),report=await getAgentByName(bindings.JournalAgent,receipt.reportSessionId);
  await runInDurableObject(report,(a:any)=>{
    a.env.JOURNAL_PUBLISH_TOKEN="journal-publisher-token-000000000000000";
    a.createModel=(tools:any[],checkpoint:any)=>({async *stream(messages:any[]){
      if(messages.at(-1).content.includes("作成"))await tools.find(t=>t.definition.function.name==="journal_create_draft").execute({title:"承認待ちの日記",description:"説明",bodyMarkdown:"人間が確認する本文"},new AbortController().signal);
      checkpoint([...messages,{role:"assistant",content:"下書きを作成しました"}]);yield {text:"下書きを作成しました"};
    }});
  });
  const process=async(jobId:string)=>{
    const replies:any[]=[];
    await journalWorker.queue({messages:[{body:{v:1,kind:"journal_agent",jobId},ack:()=>{},retry:()=>{throw Error("retry");}}]} as any,
      {...bindings,JOURNAL_RESULTS:{send:async(body:any)=>{replies.push(body);}}});
    for(const reply of replies)await consumeJournalResults({messages:[{body:reply,ack:()=>{},retry:()=>{throw Error("retry");}}]} as any,bindings);
  };
  await process(receipt.jobId);
  const article=await bindings.TEST_DB.prepare("SELECT id,updated_at FROM articles").first();
  await runInDurableObject(main,(a:any)=>{
    const text=a.sql`SELECT content FROM niao_messages WHERE requestId=${`journal-agent:${receipt.jobId}`}`[0].content;
    expect(text).toContain("人間が確認する本文");expect(text).toContain("公開して");expect(text).toContain(article.updated_at);
  });
  expect((await bindings.TEST_DB.prepare("SELECT status FROM articles").first()).status).toBe("draft");
  // An edit outside the conversation invalidates the reviewed revision at the MCP boundary.
  const edited=await new Articles(bindings.TEST_DB).update({articleId:article.id,expectedUpdatedAt:article.updated_at,bodyMarkdown:"更新された本文"});
  const stale=await enqueue("公開して");await process(stale.jobId);
  expect((await bindings.TEST_DB.prepare("SELECT status FROM articles").first()).status).toBe("draft");
  await runInDurableObject(report,(a:any)=>{
    a.createModel=(tools:any[],checkpoint:any)=>({async *stream(messages:any[]){
      await tools.find(t=>t.definition.function.name==="journal_get_article").execute({articleId:article.id},new AbortController().signal);
      checkpoint([...messages,{role:"assistant",content:"修正版を提示します"}]);yield {text:"修正版を提示します"};
    }});
  });
  const refreshed=await enqueue("最新の下書きを提示して");await process(refreshed.jobId);
  expect((await report.review(refreshed.jobId))?.updatedAt).toBe(edited.updatedAt);
  await runInDurableObject(report,(a:any)=>{a.createModel=()=>{throw Error("publication must not need inference");};});
  const approved=await enqueue("内容を確認しました。この内容で公開して下さい。");await process(approved.jobId);await process(approved.jobId);
  expect((await bindings.TEST_DB.prepare("SELECT status FROM articles").first()).status).toBe("published");
  await runInDurableObject(main,(a:any)=>{
    const rows=a.sql`SELECT content FROM niao_messages WHERE requestId=${`journal-agent:${approved.jobId}`}`;
    expect(rows).toHaveLength(1);expect(rows[0].content).toContain("下書きを公開しました");expect(rows[0].content).toContain("https://journal.example.org/journal/");
  });
});

it.each([false,true])("publishes an explicitly delegated request without a prior preview (model calls publish: %s)",async(callPublish)=>{
  const main=await getAgentByName(bindings.NiaoAgent,"personal");
  const receipt=await runInDurableObject(main,async(a:any)=>{
    a.env.JOURNAL_PROMPTS={send:async()=>{}};a.active={requestId:"delegated",sessionId:"legacy"};
    const result=await a.enqueueJournalAgent({prompt:"日報を作成して公開して下さい。"},"delegated",0);a.active=null;return result;
  });
  const claim=await main.claimJournalAgentJob(receipt.jobId);expect(claim.action).toBe("run");
  if(claim.action!=="run")throw Error("missing job");
  const report=await getAgentByName(bindings.JournalAgent,receipt.reportSessionId);
  await runInDurableObject(report,async(a:any)=>{
    a.onRunError=(error:unknown)=>{throw error;};a.env.JOURNAL_PUBLISH_TOKEN="journal-publisher-token-000000000000000";
    a.createModel=(tools:any[],checkpoint:any)=>({async *stream(messages:any[]){
      const response=await tools.find(t=>t.definition.function.name==="journal_create_draft").execute({title:"明示公開の日報",bodyMarkdown:"公開を依頼された本文"},new AbortController().signal);
      const article=JSON.parse(response.content[0].text);
      if(callPublish){
        const tool=tools.find(t=>t.definition.function.name==="journal_publish_article");
        const result=await tool.execute({articleId:article.articleId,expectedUpdatedAt:article.updatedAt,confirmPublication:true},new AbortController().signal);
        expect(JSON.parse(result.content[0].text).status).toBe("published");
        expect(await tool.execute({articleId:article.articleId},new AbortController().signal)).toEqual(result);
      }
      checkpoint([...messages,{role:"assistant",content:"保存しました"}]);yield {text:"保存しました"};
    }});
    const result=await a.run(claim.job);
    expect(result).toContain("下書きを公開しました");expect(result).toContain("https://journal.example.org/journal/");
    expect(await a.run(claim.job)).toBe(result);expect(await a.review(claim.job.id)).toBeNull();
  });
  const articles=await bindings.TEST_DB.prepare("SELECT status FROM articles").all();
  expect(articles.results).toEqual([{status:"published"}]);
});

it.each([false,true])("publishes requested revisions only after saving them (saved: %s)",async(saved)=>{
  const article=await new Articles(bindings.TEST_DB).create({title:"修正前",bodyMarkdown:"修正前の本文"});
  const main=await getAgentByName(bindings.NiaoAgent,"personal");
  const receipt=await runInDurableObject(main,async(a:any)=>{
    a.env.JOURNAL_PROMPTS={send:async()=>{}};a.active={requestId:"revise",sessionId:"legacy"};
    const result=await a.enqueueJournalAgent({prompt:"下書きを修正して公開して下さい。"},"revise",0);a.active=null;
    a.sql`UPDATE niao_report_jobs SET approval=${JSON.stringify({articleId:article.id,expectedUpdatedAt:article.updatedAt})} WHERE id=${result.jobId}`;
    return result;
  });
  const claim=await main.claimJournalAgentJob(receipt.jobId);if(claim.action!=="run")throw Error("missing job");
  const report=await getAgentByName(bindings.JournalAgent,receipt.reportSessionId);
  await runInDurableObject(report,async(a:any)=>{
    a.onRunError=(error:unknown)=>{throw error;};a.env.JOURNAL_PUBLISH_TOKEN="journal-publisher-token-000000000000000";
    a.createModel=(tools:any[],checkpoint:any)=>({async *stream(messages:any[]){
      if(saved)await tools.find(t=>t.definition.function.name==="journal_update_draft").execute({articleId:article.id,expectedUpdatedAt:article.updatedAt,bodyMarkdown:"修正済みの本文"},new AbortController().signal);
      else expect(await tools.find(t=>t.definition.function.name==="journal_publish_article").execute({articleId:article.id},new AbortController().signal)).toMatchObject({isError:true});
      checkpoint([...messages,{role:"assistant",content:"修正しました"}]);yield {text:"修正しました"};
    }});
    expect(await a.run(claim.job)).toContain(saved ? "下書きを公開しました" : "公開していません");
  });
  const after=await new Articles(bindings.TEST_DB).get({articleId:article.id});
  expect(after.status).toBe(saved ? "published" : "draft");expect(after.bodyMarkdown).toBe(saved ? "修正済みの本文" : "修正前の本文");
});
