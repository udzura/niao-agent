import {env} from "cloudflare:test";
import {expect,it,vi} from "vitest";
import {WebFetchAsyncService,asyncWebLimits,browserInputHtml} from "../../tools-misc/src/web-fetch-async";
import {publicDnsFixture,webArticle} from "./fixtures/web";
const url="https://articles.example.org/posts/entry";
const browser=(quickAction:(action:string,options:any)=>Promise<Response>)=>({quickAction}) as Pick<BrowserRun,"quickAction">;
const ok=(text="# 日本語の技術メモ\n\nContent",title="日本語の技術メモ")=>Response.json({success:true,result:text,meta:{title}},{headers:{"X-Browser-Ms-Used":"45"}});
function upstream(text=webArticle(),type="text/html") {
  return vi.fn(async(input:RequestInfo|URL,options?:RequestInit)=>{
    const target=new URL(String(input));
    expect(options?.redirect).toBe("manual");
    expect(new Headers(options?.headers).has("Authorization")).toBe(false);
    expect(new Headers(options?.headers).has("Cookie")).toBe(false);
    if (target.hostname === "cloudflare-dns.com") return Response.json(publicDnsFixture(target.searchParams.get("type")!));
    if (target.pathname === "/redirect") return new Response(null,{status:302,headers:{Location:url}});
    return new Response(text,{headers:{"Content-Type":type}});
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}
it("separates async RPC and offloads HTML beyond synchronous size/DOM limits",async()=>{
  const html=webArticle("ja",500);
  expect(new TextEncoder().encode(html).byteLength).toBeGreaterThan(32768);
  const call=vi.fn(async(action,options)=>{
    expect(action).toBe("markdown");
    expect(options).toMatchObject({setJavaScriptEnabled:false,rejectRequestPattern:[".*"],cacheTTL:0});
    expect(options.html).toContain(`<base href="${url}">`);
    expect(options.html).toContain("Content-Security-Policy");
    expect(options.html).not.toContain("<script");
    expect(options).not.toHaveProperty("url");
    expect(options).not.toHaveProperty("cookies");
    expect(options).not.toHaveProperty("setExtraHTTPHeaders");
    return ok();
  });
  expect(await new WebFetchAsyncService({BROWSER:browser(call)},upstream(html)).get({url})).toMatchObject({ok:true,contentType:"text/markdown",title:"日本語の技術メモ",finalUrl:url,truncated:false});
  expect(call).toHaveBeenCalledOnce();
  // Actual compiled tools-misc RPC with a separate remote-browser fixture Worker.
  expect(await (env as any).TOOLS_MISC.webFetchAsync({url})).toMatchObject({ok:true,contentType:"text/markdown",content:expect.stringContaining("Browser Run test fixture")});
  expect(await (env as any).TOOLS_MISC.webFetch({url})).toMatchObject({ok:true,contentType:"text/html",byline:"Niao Test Author"});
});
it("preserves validated final URL after redirects",async()=>{
  const call=vi.fn(async(_action,options)=>{expect(options.html.includes(`<base href="${url}">`)).toBe(true);return ok();});
  expect(await new WebFetchAsyncService({BROWSER:browser(call)},upstream()).get({url:"https://articles.example.org/redirect"})).toMatchObject({ok:true,finalUrl:url});
});
it.each(["text/plain","text/markdown","text/x-markdown"])("handles %s without a browser invocation",async type=>{
  const call=vi.fn(async()=>ok());
  expect(await new WebFetchAsyncService({BROWSER:browser(call)},upstream("hello\r\nworld",type)).get({url})).toMatchObject({ok:true,content:"hello\nworld",contentType:type});
  expect(call).not.toHaveBeenCalled();
});
it("rejects unsafe destinations and unsupported content before Browser Run",async()=>{
  const call=vi.fn(async()=>ok());const request=upstream();
  const service=new WebFetchAsyncService({BROWSER:browser(call)},request);
  for(const value of ["http://127.0.0.1/","https://user:password@articles.example.org/","http://169.254.169.254/","https://metadata.google.internal/"])
    expect(await service.get({url:value})).toEqual({ok:false,error:"web_fetch_unsafe_url"});
  expect(request).not.toHaveBeenCalled();
  expect(await new WebFetchAsyncService({BROWSER:browser(call)},upstream("%PDF","application/pdf")).get({url})).toEqual({ok:false,error:"web_fetch_unsupported_content_type"});
  expect(call).not.toHaveBeenCalled();
});
it("fails closed for private DNS and redirects",async()=>{
  const call=vi.fn(async()=>ok());
  const request=vi.fn(async(input)=>String(input).includes("dns-query") ? Response.json(publicDnsFixture("A","10.0.0.1")) : ok()) as unknown as typeof fetch;
  expect(await new WebFetchAsyncService({BROWSER:browser(call)},request).get({url})).toEqual({ok:false,error:"web_fetch_unsafe_url"});
  const redirect=vi.fn(async(input)=>String(input).includes("dns-query") ? Response.json(publicDnsFixture("A")) : new Response(null,{status:302,headers:{Location:"http://localhost/"}})) as unknown as typeof fetch;
  expect(await new WebFetchAsyncService({BROWSER:browser(call)},redirect).get({url})).toEqual({ok:false,error:"web_fetch_unsafe_url"});
  expect(call).not.toHaveBeenCalled();
});
it("bounds source, response envelope and final result independently",async()=>{
  const call=vi.fn(async()=>ok("😀日本語".repeat(10000)));
  const service=new WebFetchAsyncService({BROWSER:browser(call),WEB_FETCH_ASYNC_MAX_CONTENT_CHARS:"32000",WEB_FETCH_ASYNC_MAX_RESULT_BYTES:"8192"},upstream());
  const result=await service.get({url});expect(result).toMatchObject({ok:true,truncated:true});
  expect(new TextEncoder().encode(JSON.stringify({untrusted_reference_data:true,result})).byteLength).toBeLessThanOrEqual(8192);
  if(result.ok)expect(result.content).not.toMatch(/[\uD800-\uDBFF]$/);
  call.mockClear();
  expect(await new WebFetchAsyncService({BROWSER:browser(call),WEB_FETCH_ASYNC_MAX_DOWNLOAD_BYTES:"1024"},upstream("x".repeat(1025))).get({url})).toEqual({ok:false,error:"web_fetch_response_too_large"});
  expect(call).not.toHaveBeenCalled();
  expect(await new WebFetchAsyncService({BROWSER:browser(async()=>ok("x".repeat(262145)))},upstream()).get({url})).toEqual({ok:false,error:"web_fetch_response_too_large"});
});
it.each([[429,"web_fetch_rate_limited"],[403,"web_fetch_browser_access_denied"],[503,"web_fetch_unavailable"],[504,"web_fetch_timeout"],[422,"web_fetch_browser_failed"]])("maps Browser Run HTTP %s safely",async(status,code)=>{
  const call=async()=>new Response("PRIVATE provider text",{status:Number(status)});
  expect(await new WebFetchAsyncService({BROWSER:browser(call)},upstream()).get({url})).toEqual({ok:false,error:code});
});
it.each(["invalid json",{success:false,errors:[{message:"PRIVATE exception"}]},{success:true,result:{text:"wrong"}},{success:true,result:""}])("rejects malformed or empty Browser Run results",async value=>{
  const call=async()=>typeof value === "string" ? new Response(value) : Response.json(value);
  expect(await new WebFetchAsyncService({BROWSER:browser(call)},upstream()).get({url})).toEqual({ok:false,error:typeof value === "object" && value.result === "" ? "web_fetch_empty_content" : "web_fetch_browser_invalid_response"});
});
it("times out even if quickAction does not expose cancellation, without falling back",async()=>{
  const call=vi.fn(async()=>new Promise<Response>(()=>{}));
  expect(await new WebFetchAsyncService({BROWSER:browser(call),WEB_FETCH_ASYNC_TIMEOUT_MS:"100"},upstream()).get({url})).toEqual({ok:false,error:"web_fetch_timeout"});
  expect(call).toHaveBeenCalledOnce();
});
it("requires browser configuration, validates schema and clamps output to the job contract",async()=>{
  const request=upstream();
  expect(await new WebFetchAsyncService({},request).get({url})).toEqual({ok:false,error:"web_fetch_browser_not_configured"});
  expect(await new WebFetchAsyncService({},request).get({url,html:"not accepted"})).toEqual({ok:false,error:"invalid_tool_arguments"});
  expect(request).not.toHaveBeenCalled();
  expect(asyncWebLimits({WEB_FETCH_MAX_DOWNLOAD_BYTES:"2048",WEB_FETCH_ASYNC_MAX_RESULT_BYTES:"9999999"})).toMatchObject({maxDownloadBytes:524288,maxResultBytes:65536});
});

it("removes active HTML and adds a leading CSP before sending it to the remote browser",async()=>{
  const input='<base href="https://evil.example.org/"><meta http-equiv="refresh" content="0;url=http://127.0.0.1/"><script>fetch("http://127.0.0.1/")</script><iframe src="http://127.0.0.1/"></iframe><noscript><meta http-equiv="refresh" content="0;url=http://127.0.0.1/"></noscript><article><h1>日本語の記事</h1><a href="../reference#section">link</a><a href="javascript:alert(1)">unsafe</a><p onclick="alert(1)">本文</p></article>';
  const html=await browserInputHtml(input,url);
  expect(html.startsWith('<meta http-equiv="Content-Security-Policy"')).toBe(true);
  expect(html).toContain("script-src 'none'");
  expect(html).toContain(`<base href="${url}">`);
  expect(html).toContain("日本語の記事");
  expect(html).toContain('href="https://articles.example.org/reference#section"');
  expect(html).not.toContain('href="javascript:');
  for(const removed of ["evil.example.org","http-equiv=\"refresh\"","<script","<iframe","<noscript","127.0.0.1"]) expect(html).not.toContain(removed);
});
