import {env} from "cloudflare:test";
import {describe,expect,it,vi} from "vitest";
import {WebFetchService} from "../../tools-misc/src/web-fetch";
import {defaultWebLimits,isPublicAddress,validateWebUrl,webLimits} from "../../tools-misc/src/web-resource";
import {normalizeWebContent} from "../../tools-misc/src/web-extract";
import {miscTools} from "../src/misc-tools";
import {WorkersAIModel} from "../src/model";
import {publicDnsFixture,webArticle} from "./fixtures/web";
const pageUrl = "https://articles.example.org/posts/entry";
const signal = () => new AbortController().signal;
function withDns(upstream: (url:URL,options:RequestInit) => Promise<Response>,
  dns: (type:string) => unknown = publicDnsFixture) {
  return vi.fn(async (url:RequestInfo | URL, options?:RequestInit) => {
    const parsed = new URL(String(url));
    expect(options?.redirect).toBe("manual");
    expect(new Headers(options?.headers).has("Authorization")).toBe(false);
    expect(new Headers(options?.headers).has("Cookie")).toBe(false);
    if (parsed.hostname === "cloudflare-dns.com") return Response.json(dns(parsed.searchParams.get("type")!));
    return upstream(parsed,options!);
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}
function textPage(text:string,contentType="text/html") {
  return withDns(async()=>new Response(text,{headers:{"Content-Type":contentType}}));
}

describe("web_fetch extraction in workerd",()=>{
  it.each(["ja","en"] as const)("extracts %s article, metadata and Markdown structure without navigation or scripts",async language=>{
    const result = await new WebFetchService({},textPage(webArticle(language))).get({url:pageUrl});
    expect(result).toMatchObject({ok:true,url:pageUrl,finalUrl:pageUrl,byline:"Niao Test Author",contentType:"text/html",truncated:false});
    if (!result.ok) throw new Error(result.error);
    expect(result.title).toBe(language === "ja" ? "日本語の技術メモ" : "Readable technical notes");
    for (const fragment of ["## Implementation","`ruby_eval`","> Keep the original source link.",
      "```ruby",'puts "Hello"\n\n\n  puts "World"',"| Model | Count |","| --- | --- |","| Qwen | 2 |",
      "[relative reference](https://articles.example.org/reference?q=1#section)","unsafe link text"]) expect(result.content).toContain(fragment);
    expect(result.content).toMatch(/- +First item/);
    for (const noise of ["NAVIGATION_NOISE","SIDEBAR_NOISE","FOOTER_NOISE","WEB_SCRIPT_EXECUTED","javascript:","<script","<style"]) expect(result.content).not.toContain(noise);
    expect((globalThis as any).WEB_SCRIPT_EXECUTED).toBeUndefined();
  });
  it.each(["text/plain","text/markdown","text/x-markdown"])("preserves %s without article extraction",async contentType=>{
    const result = await new WebFetchService({},textPage("# 日本語メモ\r\n\r\n\r\n  indented text 😀",contentType)).get({url:pageUrl});
    expect(result).toMatchObject({ok:true,contentType,content:"# 日本語メモ\n\n  indented text 😀",truncated:false});
  });
  it("keeps short valid pages and recovers malformed fragments without inventing missing text",async()=>{
    for (const html of ["<html><body><article><p>短いけれど有効なメモです。</p></article></body></html>","<h1>Broken HTML</h1><p>A short but useful note with an unclosed paragraph."]) {
      expect(await new WebFetchService({},textPage(html)).get({url:pageUrl})).toMatchObject({ok:true});
    }
    for (const html of ["", "<html><head><script>ignore me</script></head><body><nav>Menu</nav></body></html>"]) {
      expect(await new WebFetchService({},textPage(html)).get({url:pageUrl})).toEqual({ok:false,error:"web_fetch_extraction_failed"});
    }
  });
  it("flattens headerless and merged-cell tables without returning raw HTML",async()=>{
    const html = webArticle().replace(/<table>.*?<\/table>/s,"<table><tr><td>A</td><td>B</td></tr><tr><td colspan='2'>C</td></tr></table>");
    const result=await new WebFetchService({},textPage(html)).get({url:pageUrl});
    expect(result.ok).toBe(true);
    if (result.ok) { expect(result.content).toContain("A | B"); expect(result.content).not.toContain("<table"); }
  });
  it("normalizes blank lines outside code fences and keeps indentation and blank lines inside them",()=>{
    expect(normalizeWebContent("\nA\n\n\nB\n```ruby\n  x\n\n\n  y\n```\n\n\nEnd\n")).toBe("A\n\nB\n```ruby\n  x\n\n\n  y\n```\n\nEnd");
  });
  it("truncates Unicode safely by content and serialized envelope size",async()=>{
    const text = "日本語😀".repeat(7000);
    const result = await new WebFetchService({WEB_FETCH_MAX_DOWNLOAD_BYTES:"131072",WEB_FETCH_MAX_CONTENT_CHARS:"32000",WEB_FETCH_MAX_RESULT_BYTES:"8192"},textPage(text,"text/plain")).get({url:pageUrl});
    expect(result).toMatchObject({ok:true,truncated:true});
    if (!result.ok) throw new Error(result.error);
    expect(new TextEncoder().encode(JSON.stringify({untrusted_reference_data:true,result})).byteLength).toBeLessThanOrEqual(8192);
    expect(result.content).not.toMatch(/[\uD800-\uDBFF]$/);
    expect(text.startsWith(result.content)).toBe(true);
    const short = await new WebFetchService({WEB_FETCH_MAX_CONTENT_CHARS:"101"},textPage("😀".repeat(100),"text/plain")).get({url:pageUrl});
    expect(short).toMatchObject({ok:true,truncated:true,content:"😀".repeat(50)});
  });
  it("rejects excessive DOM size and depth before Readability's recursive processing",async()=>{
    for (const html of ["<div>".repeat(100)+"deep"+"</div>".repeat(100),"<p>text</p>".repeat(310),"<i>x</i>".repeat(1000)]) {
      expect(await new WebFetchService({},textPage(html)).get({url:pageUrl})).toEqual({ok:false,error:"web_fetch_document_too_complex"});
    }
  });
});

describe("web_fetch network safety and bounds",()=>{
  it.each([
    "file:///etc/passwd","ftp://example.org/a","data:text/plain,hello","http://user:password@example.org/","https://@example.org/",
    "http://localhost/","http://a.localhost/","http://host.local/","http://host.internal/","http://singlelabel/",
    "http://127.0.0.1/","http://2130706433/","http://0x7f000001/","http://127.1/","http://0.0.0.0/",
    "http://10.0.0.1/","http://172.31.0.1/","http://192.168.1.1/","http://100.100.100.200/",
    "http://169.254.169.254/","http://168.63.129.16/","http://224.0.0.1/","http://198.18.0.1/","http://192.0.2.1/",
    "http://[::1]/","http://[::]/","http://[::ffff:127.0.0.1]/","http://[fc00::1]/","http://[fe80::1]/","http://[2001:db8::1]/",
    "https://metadata.google.internal/","https://metadata.example.org/","https://foo.cloudflare-internal.com/",
    "https://example.org:8080/","https://example.org/\nprivate","https://example.org\\@localhost/",
  ])("rejects unsafe URL %s before any request",async url=>{
    const request=vi.fn();
    expect(await new WebFetchService({},request).get({url})).toEqual({ok:false,error:"web_fetch_unsafe_url"});
    expect(request).not.toHaveBeenCalled();
  });
  it("classifies public IPv4/IPv6 and normalizes public URLs",()=>{
    for (const ip of ["1.1.1.1","93.184.216.34","2606:4700:4700::1111"]) expect(isPublicAddress(ip)).toBe(true);
    for (const ip of ["2002:7f00:1::","64:ff9b::7f00:1","3fff::1","ff02::1","100::1","192.0.0.9","bad","fe80::1%eth0"]) expect(isPublicAddress(ip)).toBe(false);
    expect(validateWebUrl("https://EXAMPLE.ORG.:443/path#section").href).toBe("https://example.org/path");
    expect(validateWebUrl("https://日本語.jp/記事").hostname).toContain("xn--");
    expect(validateWebUrl("http://1.1.1.1/").href).toBe("http://1.1.1.1/");
  });
  it("checks every DNS address, including mixed public/private answers and AAAA",async()=>{
    for (const dns of [
      (type:string)=>publicDnsFixture(type,type === "AAAA" ? "::1" : "1.1.1.1"),
      (type:string)=>({...publicDnsFixture(type),Answer:[...publicDnsFixture(type).Answer,{type:1,data:"10.0.0.1"}]}),
      ()=>({Status:0,Answer:[{type:5,data:"metadata.google.internal."}]}),
    ]) {
      const upstream=vi.fn();
      expect(await new WebFetchService({},withDns(upstream,dns)).get({url:pageUrl})).toEqual({ok:false,error:"web_fetch_unsafe_url"});
      expect(upstream).not.toHaveBeenCalled();
    }
  });
  it("fails closed on DNS errors, missing answers, malformed JSON and resolver redirects",async()=>{
    const upstream=vi.fn();
    for (const dns of [()=>({Status:2}),()=>({Status:0}),()=>({Status:3}),()=>({Status:0,TC:true}),()=>({Status:0,Answer:"bad"})]) {
      expect(await new WebFetchService({},withDns(upstream,dns)).get({url:pageUrl})).toEqual({ok:false,error:"web_fetch_dns_failed"});
    }
    for (const response of [()=>new Response("{"),()=>new Response(null,{status:302,headers:{Location:"http://127.0.0.1/"}})]) {
      expect(await new WebFetchService({},async()=>response()).get({url:pageUrl})).toEqual({ok:false,error:"web_fetch_dns_failed"});
    }
    expect(upstream).not.toHaveBeenCalled();
  });
  it("follows bounded, validated redirects and resolves relative Location against the last URL",async()=>{
    const request=withDns(async url=> url.pathname === "/start" ? new Response(null,{status:302,headers:{Location:"/posts/entry"}})
      : new Response(webArticle(),{headers:{"Content-Type":"text/html"}}));
    expect(await new WebFetchService({},request).get({url:"https://articles.example.org/start"})).toMatchObject({ok:true,
      url:"https://articles.example.org/start",finalUrl:pageUrl});
    expect(request.mock.calls.filter(([url]:any)=>String(url).includes("dns-query"))).toHaveLength(4);
  });
  it("validates redirects to private names, DNS, credentials, alternate ports and HTTPS downgrade",async()=>{
    for (const location of ["http://127.0.0.1/","https://a.local/","https://u:p@example.org/","https://example.org:8080/","http://example.org/"]) {
      const upstream=vi.fn(async()=>new Response(null,{status:302,headers:{Location:location}}));
      expect(await new WebFetchService({},withDns(upstream)).get({url:pageUrl})).toEqual({ok:false,error:"web_fetch_unsafe_url"});
      expect(upstream).toHaveBeenCalledTimes(1);
    }
    const upstream=vi.fn(async()=>new Response(null,{status:302,headers:{Location:"https://private.example.org/"}}));
    const request=withDns(upstream);
    const resolver=async(url:RequestInfo|URL,options?:RequestInit)=>String(url).includes("name=private.example.org")
      ? Response.json(publicDnsFixture("A","10.0.0.1")) : request(url,options);
    expect(await new WebFetchService({},resolver as typeof fetch).get({url:pageUrl})).toEqual({ok:false,error:"web_fetch_unsafe_url"});
    expect(upstream).toHaveBeenCalledTimes(1);
  });
  it("stops redirect loops and excessive redirects, and rejects missing Location",async()=>{
    for (const [upstream,error] of [
      [async()=>new Response(null,{status:302,headers:{Location:pageUrl}}),"web_fetch_redirect_limit"],
      [async(url:URL)=>new Response(null,{status:302,headers:{Location:`?n=${Number(url.searchParams.get("n") ?? 0)+1}`}}),"web_fetch_redirect_limit"],
      [async()=>new Response(null,{status:302}),"web_fetch_invalid_redirect"],
    ] as const) {
      expect(await new WebFetchService({WEB_FETCH_MAX_REDIRECTS:"1"},withDns(upstream)).get({url:pageUrl})).toEqual({ok:false,error});
    }
  });
  it.each(["application/pdf","image/png","application/octet-stream",""])("rejects unsupported Content-Type %s without reading the body",async contentType=>{
    const cancel=vi.fn();
    const request=withDns(async()=>new Response(new ReadableStream({cancel}),{headers:{"Content-Type":contentType}}));
    expect(await new WebFetchService({},request).get({url:pageUrl})).toEqual({ok:false,error:"web_fetch_unsupported_content_type"});
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("rejects oversized Content-Length and streamed bodies without returning partial downloads",async()=>{
    for (const declared of [true,false]) {
      const cancel=vi.fn();
      const request=withDns(async()=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(800));c.enqueue(new Uint8Array(800));},cancel}),{
        headers:{"Content-Type":"text/plain",...(declared?{"Content-Length":"1600"}:{})}}));
      expect(await new WebFetchService({WEB_FETCH_MAX_DOWNLOAD_BYTES:"1024"},request).get({url:pageUrl})).toEqual({ok:false,error:"web_fetch_response_too_large"});
      expect(cancel).toHaveBeenCalledOnce();
    }
  });
  it("times out slow headers, DNS and response streams within the same overall deadline",async()=>{
    const pending = async (_url:URL,options:RequestInit) => new Promise<Response>((_resolve,reject)=>{
      options.signal!.addEventListener("abort",()=>reject(options.signal!.reason),{once:true});
    });
    const slowHeaders=withDns(pending);
    const slowDns=(url:RequestInfo | URL,options?:RequestInit)=>pending(new URL(String(url)),options!);
    const cancel=vi.fn();
    const slowBody=withDns(async()=>new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode("partial"));},cancel}),{headers:{"Content-Type":"text/plain"}}));
    for (const request of [slowHeaders,slowDns,slowBody]) {
      expect(await new WebFetchService({WEB_FETCH_TIMEOUT_MS:"100"},request as typeof fetch).get({url:pageUrl})).toEqual({ok:false,error:"web_fetch_timeout"});
    }
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("maps upstream failures, empty text and invalid encoding without leaking URLs or content to logs",async()=>{
    const warn=vi.spyOn(console,"warn").mockImplementation(()=>{});
    try {
      for (const [request,error] of [
        [withDns(async()=>new Response(null,{status:429})),"web_fetch_rate_limited"],
        [withDns(async()=>new Response(null,{status:403})),"web_fetch_http_error"],
        [withDns(async()=>{throw new Error("private diagnostic")}),"web_fetch_unavailable"],
        [textPage("","text/plain"),"web_fetch_empty_content"],
        [withDns(async()=>new Response(new Uint8Array([0xff]),{headers:{"Content-Type":"text/plain; charset=utf-8"}})),"web_fetch_invalid_encoding"],
      ] as const) expect(await new WebFetchService({},request).get({url:pageUrl+"?secret=private"})).toEqual({ok:false,error});
      expect(JSON.stringify(warn.mock.calls)).not.toMatch(/private|secret|articles\.example/);
    } finally { warn.mockRestore(); }
  });
  it("validates schema and clamps configuration without widening hard limits",async()=>{
    const request=vi.fn();
    for (const args of [null,{}, {url:""},{url:123},{url:"x".repeat(2049)},{url:pageUrl,headers:{Authorization:"secret"}}])
      expect(await new WebFetchService({},request).get(args)).toEqual({ok:false,error:"invalid_tool_arguments"});
    expect(request).not.toHaveBeenCalled();
    expect(webLimits()).toEqual(defaultWebLimits);
    expect(webLimits({WEB_FETCH_TIMEOUT_MS:"999999",WEB_FETCH_MAX_REDIRECTS:"0",WEB_FETCH_MAX_DOWNLOAD_BYTES:"no"})).toMatchObject({timeoutMs:45000,maxRedirects:0,maxDownloadBytes:32768});
  });
});

describe("web_fetch via real Service Binding and model loop",()=>{
  const tool=()=>miscTools((env as any).TOOLS_MISC).find(t=>t.definition.function.name === "web_fetch")!;
  it("registers url-only schema, runs actual compiled RPC/extraction and has no public endpoint",async()=>{
    expect(tool().definition.function.parameters).toMatchObject({type:"object",required:["url"],additionalProperties:false});
    expect(await tool().execute({url:"https://articles.example.org/redirect"},signal())).toMatchObject({untrusted_reference_data:true,
      result:{ok:true,title:"日本語の技術メモ",finalUrl:pageUrl}});
    expect(await (env as any).TOOLS_MISC.webFetch({url:"http://127.0.0.1"})).toEqual({ok:false,error:"web_fetch_unsafe_url"});
    expect((await (env as any).TOOLS_MISC.fetch("https://misc.invalid")).status).toBe(404);
  });
  it("returns safe binding errors and respects cancellation",async()=>{
    const broken=miscTools({webFetch:async()=>{throw new Error("private binding")}} as any).find(t=>t.definition.function.name === "web_fetch")!;
    expect(await broken.execute({url:pageUrl},signal())).toEqual({ok:false,error:"web_fetch_unavailable"});
    expect(await tool().execute({url:pageUrl,other:true},signal())).toEqual({ok:false,error:"invalid_tool_arguments"});
    const controller=new AbortController();controller.abort();
    await expect(tool().execute({url:pageUrl},controller.signal)).rejects.toThrow();
  });
  it("feeds untrusted reference results into the existing server-side loop and preserves named tool events",async()=>{
    let round=0;
    const ai={run:async(_model:string,input:any)=>{
      expect(input.messages[0].content).toContain("untrusted reference data");
      expect(input.messages[0].content).toContain("not web_search");
      const delta=round++ === 0 ? {tool_calls:[{index:0,id:"fetch",function:{name:"web_fetch",arguments:JSON.stringify({url:pageUrl})}}]}
        : {content:"本文を確認しました。[出典](https://articles.example.org/posts/entry)"};
      if (round === 2) expect(JSON.parse(input.messages.at(-1).content)).toMatchObject({untrusted_reference_data:true,result:{ok:true,title:"日本語の技術メモ"}});
      return new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({choices:[{delta}]})}\n\ndata: [DONE]\n\n`));c.close();}});
    }} as unknown as Ai;
    const events=[];
    for await (const event of new WorkersAIModel(ai,"@cf/qwen/qwen3.8-27b",undefined,false,[tool()]).stream([{role:"user",content:"このURLを読んで"}],signal())) events.push(event);
    expect(round).toBe(2);
    expect(events).toContainEqual({toolStatus:"running",name:"web_fetch"});
    expect(events).toContainEqual({toolStatus:"completed",name:"web_fetch"});
    expect(events.some(e=>"text" in e)).toBe(true);
  });
});
