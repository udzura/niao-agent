import {Client, StreamableHTTPClientTransport} from "@modelcontextprotocol/client";
import {z} from "zod";
import type {AdditionalTool} from "../../worker/src/past-logs";
import type {Env} from "./index";

export const RELEASE_URL = "https://api.github.com/repos/udzura/niao-agent/releases/latest";
export class ReleaseFetchError extends Error {
  constructor(public code:string,public details:Record<string,number>={}){super(code);}
}
const numericHeader=(response:Response,name:string)=>{
  const value=response.headers.get(name);
  return value && /^\d{1,12}$/.test(value) ? Number(value) : undefined;
};
async function readBounded(response:Response,signal:AbortSignal) {
  const reader=response.body?.getReader(); if(!reader)throw Error("release_unavailable");
  let text="",size=0;const decoder=new TextDecoder();
  try {while(true){signal.throwIfAborted();const {value,done}=await reader.read();if(done)break;size+=value.byteLength;
    if(size>262144)throw Error("release_too_large");text+=decoder.decode(value,{stream:true});}return JSON.parse(text+decoder.decode());}
  finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
export async function latestRelease(signal:AbortSignal,network:typeof fetch=fetch,token?:string) {
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
  try {
    const callSignal=AbortSignal.any([signal,controller.signal]);
    const headers=new Headers({Accept:"application/vnd.github+json","User-Agent":"niao-journal-agent"});
    if(token){
      if(token.length>1024 || /[\r\n]/.test(token) || !token.trim())throw new ReleaseFetchError("release_invalid_token");
      headers.set("Authorization",`Bearer ${token.trim()}`);
    }
    const response=await network(RELEASE_URL,{signal:callSignal,redirect:"manual",headers});
    if(!response.ok){
      const remaining=numericHeader(response,"x-ratelimit-remaining"),reset=numericHeader(response,"x-ratelimit-reset"),retry=numericHeader(response,"retry-after");
      const limited=response.status===429 || response.status===403 && (remaining===0 || retry!==undefined);
      const code=limited ? "release_rate_limited" : response.status===401 ? "release_unauthorized" : response.status===403 ? "release_forbidden" : "release_unavailable";
      const details={httpStatus:response.status,...(remaining!==undefined ? {rateLimitRemaining:remaining} : {}),
        ...(reset!==undefined ? {rateLimitReset:reset} : {}),...(retry!==undefined ? {retryAfterSeconds:retry} : {})};
      await response.body?.cancel();
      // Only status and known numeric headers; never credentials or response bodies.
      console.warn(JSON.stringify({event:"journal_agent.release_failed",code,...details}));
      throw new ReleaseFetchError(code,details);
    }
    const data=await readBounded(response,callSignal);
    const release=z.object({tag_name:z.string(),name:z.string().nullable().optional(),body:z.string().nullable().optional(),
      html_url:z.string().url(),published_at:z.string().nullable()});
    const parsed=release.parse(data);
    return {untrusted_reference_data:true,sourceUrl:RELEASE_URL,...parsed,body:parsed.body?.slice(0,32000)};
  } catch(error) { signal.throwIfAborted();if(error instanceof ReleaseFetchError)throw error;throw new ReleaseFetchError("release_unavailable"); }
  finally { clearTimeout(timer);controller.abort(); }
}
export const localTool = (name:string,description:string,schema:z.ZodType,execute:AdditionalTool["execute"]):AdditionalTool => {
  const {$schema,...parameters}=z.toJSONSchema(schema);
  return {definition:{type:"function",function:{name,description,parameters}},execute:async(args,signal)=>{
    const parsed=schema.safeParse(args);if(!parsed.success)return {ok:false,error:"invalid_tool_arguments"};
    try{return await execute(parsed.data as Record<string,unknown>,signal);}catch(error){signal.throwIfAborted();
      return error instanceof ReleaseFetchError ? {ok:false,error:error.code,...error.details} : {ok:false,error:"reference_unavailable"};}
  }};
};
export async function withJournalMcp<T>(env:Env,signal:AbortSignal,wrap:(tool:AdditionalTool)=>AdditionalTool,run:(tools:AdditionalTool[])=>Promise<T>,publisher=false) {
  const token=publisher ? env.JOURNAL_PUBLISH_TOKEN : env.JOURNAL_AGENT_TOKEN;
  if(!token || token.length<32)throw Error("journal_not_configured");
  const endpoint=new URL(env.JOURNAL_MCP_URL ?? "https://journal.internal/mcp");
  if(endpoint.protocol!=="https:" || endpoint.pathname!=="/mcp" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash)throw Error("invalid_journal_endpoint");
  const client=new Client({name:"niao-journal-agent",version:"1.0.0"});
  const transport=new StreamableHTTPClientTransport(endpoint,{requestInit:{redirect:"manual"},fetch:async(input,init)=>{
    const request=new Request(input as RequestInfo,init as RequestInit);if(request.url!==endpoint.href)throw Error("unexpected_endpoint");
    const headers=new Headers(request.headers);headers.set("Authorization",`Bearer ${token}`);
    const requestInit={headers,signal,redirect:"manual" as const,cache:"no-store" as const};
    const response=await (env.JOURNAL_MCP_URL ? fetch(request,requestInit) : env.JOURNAL.fetch(request,requestInit));
    if(response.status>=300 && response.status<400){await response.body?.cancel();throw Error("journal_redirect_rejected");}
    return response;
  }});
  try{
    await client.connect(transport,{signal,timeout:20000});
    const catalog=await client.listTools({},{signal,timeout:20000});
    const allowed=new Set(["create_draft","update_draft","get_article","list_articles","publish_article"]);
    const tools=catalog.tools.filter(t=>allowed.has(t.name)).map(t=>{const {$schema,...parameters}=t.inputSchema as Record<string,unknown>;return wrap({
      definition:{type:"function",function:{name:`journal_${t.name}`,description:t.description??t.name,parameters}},
      execute:async(args,callSignal)=>{const result=await client.callTool({name:t.name,arguments:args},{signal:callSignal,timeout:20000});
        if(JSON.stringify(result).length>100000)throw Error("journal_result_too_large");return result;},
    });});
    return await run(tools);
  }finally{await client.close().catch(()=>{});}
}
