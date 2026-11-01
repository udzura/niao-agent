import {webFetchInput} from "./contracts";
import {fetchWebResource, readWebBytes, WebFetchError, defaultWebLimits, validateWebUrl, type WebFetchSettings, type WebRequest} from "./web-resource";
import {boundResult, clipCharacters, normalizeWebContent, type WebFetchResult} from "./web-result";

export interface BrowserWebFetchSettings extends WebFetchSettings {
  BROWSER?: Pick<BrowserRun,"quickAction">;
  WEB_FETCH_ASYNC_TIMEOUT_MS?: string;
  WEB_FETCH_ASYNC_MAX_DOWNLOAD_BYTES?: string;
  WEB_FETCH_ASYNC_MAX_CONTENT_CHARS?: string;
  WEB_FETCH_ASYNC_MAX_RESULT_BYTES?: string;
}
export function asyncWebLimits(settings: BrowserWebFetchSettings = {}) {
  const bounded = (value:string|undefined, fallback:number, min:number, max:number) =>
    value !== undefined && /^\d+$/.test(value) ? Math.min(max,Math.max(min,Number(value))) : fallback;
  return {
    ...defaultWebLimits,
    timeoutMs:bounded(settings.WEB_FETCH_ASYNC_TIMEOUT_MS,45000,100,60000),
    maxDownloadBytes:bounded(settings.WEB_FETCH_ASYNC_MAX_DOWNLOAD_BYTES,524288,1024,1048576),
    maxContentChars:bounded(settings.WEB_FETCH_ASYNC_MAX_CONTENT_CHARS,12000,100,32000),
    // Must also fit the Agent's persisted fetchJobResult contract (64 KiB).
    maxResultBytes:bounded(settings.WEB_FETCH_ASYNC_MAX_RESULT_BYTES,32768,8192,65536),
  };
}
const escapeAttribute = (value:string) => value.replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/</g,"&lt;").replace(/>/g,"&gt;");

// Quick Actions can populate supplied HTML before applying page options.
// Do not rely on setJavaScriptEnabled/rejectRequestPattern alone at that stage.
export async function browserInputHtml(html:string,finalUrl:string):Promise<string> {
  const cleaned = await new HTMLRewriter()
    .on("script, iframe, frame, frameset, object, embed, base, meta[http-equiv], noscript", {element(element) { element.remove(); }})
    .on("a[href], img[src]", {element(element) {
      const attribute=element.tagName === "img" ? "src" : "href";
      try {
        const resolved=new URL(element.getAttribute(attribute)!,finalUrl);
        const safe=validateWebUrl(resolved.href);safe.hash=resolved.hash;
        element.setAttribute(attribute,safe.href);
      } catch { element.removeAttribute(attribute); }
    }})
    .transform(new Response(html,{headers:{"Content-Type":"text/html; charset=utf-8"}})).text();
  return `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; object-src 'none'; connect-src 'none'; frame-src 'none'; form-action 'none'">` +
    `<base href="${escapeAttribute(finalUrl)}">${cleaned}`;
}

export class WebFetchAsyncService {
  constructor(private settings:BrowserWebFetchSettings = {}, private request:WebRequest = fetch.bind(globalThis)) {}
  async get(input:unknown):Promise<WebFetchResult|{ok:false;error:string}> {
    const parsed = webFetchInput.safeParse(input);
    if (!parsed.success) return {ok:false,error:"invalid_tool_arguments"};
    // No silent fallback to the CPU-heavy local extractor.
    if (!this.settings.BROWSER) return {ok:false,error:"web_fetch_browser_not_configured"};
    const limits = asyncWebLimits(this.settings);
    const controller = new AbortController(), signal = controller.signal;
    let timer:ReturnType<typeof setTimeout>|undefined;
    const started = Date.now();
    let browserMs:number|undefined;
    const run = async():Promise<WebFetchResult> => {
      // Reuse URL/DNS/manual redirect checks. Only bounded text is buffered here;
      // neither Readability, LinkeDOM nor Turndown runs on the asynchronous path.
      const resource = await fetchWebResource(parsed.data.url,limits,this.request,signal);
      signal.throwIfAborted();
      let content = resource.text, contentType = resource.contentType, title:string|undefined;
      let truncated = false;
      if (contentType === "text/html") {
        const preparedHtml=await browserInputHtml(resource.text,resource.finalUrl);
        signal.throwIfAborted();
        const response = await this.settings.BROWSER!.quickAction("markdown",{
          // The first base element preserves relative citation links after redirects.
          html:preparedHtml,
          setJavaScriptEnabled:false,
          // Browser Run parses supplied HTML only. No scripts, subresources,
          // frames or meta-refresh destinations may initiate new network reads.
          rejectRequestPattern:[".*"],
          gotoOptions:{waitUntil:"domcontentloaded",timeout:20000},actionTimeout:20000,cacheTTL:0,
        });
        if (signal.aborted) { void response.body?.cancel().catch(()=>{}); signal.throwIfAborted(); }
        const measured = response.headers.get("X-Browser-Ms-Used");
        if (measured !== null && /^\d+(?:\.\d+)?$/.test(measured) && Number.isFinite(Number(measured))) browserMs=Number(measured);
        if (!response.ok) {
          void response.body?.cancel().catch(()=>{});
          throw new WebFetchError(response.status === 429 ? "web_fetch_rate_limited" :
            [408,504].includes(response.status) ? "web_fetch_timeout" :
            [401,403].includes(response.status) ? "web_fetch_browser_access_denied" :
            response.status >= 500 ? "web_fetch_unavailable" : "web_fetch_browser_failed");
        }
        // Bound the API envelope before JSON parsing as well as the LLM result.
        const bytes = await readWebBytes(response,262144,signal);
        let envelope:unknown;
        try { envelope=JSON.parse(new TextDecoder("utf-8",{fatal:true,ignoreBOM:false}).decode(bytes)); }
        catch { throw new WebFetchError("web_fetch_browser_invalid_response"); }
        const data = envelope as {success?:unknown;result?:unknown;meta?:{title?:unknown}}|null;
        if (!data || data.success !== true || typeof data.result !== "string")
          throw new WebFetchError("web_fetch_browser_invalid_response");
        content=data.result; contentType="text/markdown";
        if (typeof data.meta?.title === "string") title=clipCharacters(data.meta.title.replace(/\s+/g," ").trim(),300) || undefined;
      }
      // Do not normalize arbitrarily large returned text before clipping it.
      if (content.length > limits.maxContentChars) { content=clipCharacters(content,limits.maxContentChars);truncated=true; }
      content=normalizeWebContent(content);
      if (!content.trim()) throw new WebFetchError("web_fetch_empty_content");
      signal.throwIfAborted();
      return boundResult({ok:true,url:resource.url,finalUrl:resource.finalUrl,contentType,content,...(title ? {title} : {}),truncated},limits.maxContentChars,limits.maxResultBytes);
    };
    try {
      // quickAction has no AbortSignal argument. Bound our wait explicitly; remote
      // work is additionally bounded by its own action/navigation timeouts.
      const result = await Promise.race([run(),new Promise<never>((_,reject)=>{
        timer=setTimeout(()=>{controller.abort();reject(new WebFetchError("web_fetch_timeout"));},limits.timeoutMs);
      })]);
      console.log(JSON.stringify({event:"misc.web_fetch_async",ok:true,durationMs:Date.now()-started,browserMs,contentChars:result.content.length,truncated:result.truncated}));
      return result;
    } catch (error) {
      const code=signal.aborted || error instanceof Error && ["AbortError","TimeoutError"].includes(error.name) ? "web_fetch_timeout"
        : error instanceof WebFetchError ? error.message : "web_fetch_unavailable";
      console.warn(JSON.stringify({event:"misc.web_fetch_async",ok:false,error:code,durationMs:Date.now()-started,browserMs}));
      return {ok:false,error:code};
    } finally { if (timer !== undefined) clearTimeout(timer);controller.abort(); }
  }
}
