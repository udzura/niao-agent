import {webFetchInput} from "./contracts";
import {clipCharacters,extractReadableContent,normalizeWebContent} from "./web-extract";
import {fetchWebResource,webLimits,WebFetchError,type WebFetchSettings,type WebRequest} from "./web-resource";

export interface WebFetchResult {
  ok:true;url:string;finalUrl:string;title?:string;byline?:string;excerpt?:string;
  content:string;contentType:string;truncated:boolean;
}
function boundResult(result: WebFetchResult, maxChars: number, maxBytes: number): WebFetchResult {
  if (result.content.length > maxChars) {
    result.content = clipCharacters(result.content,maxChars); result.truncated = true;
  }
  const size = () => new TextEncoder().encode(JSON.stringify({untrusted_reference_data:true,result})).byteLength;
  if (size() > maxBytes) {
    result.truncated = true;
    const content = result.content; let lo = 0, hi = content.length;
    while (lo < hi) {
      const mid = Math.ceil((lo+hi)/2);
      result.content = clipCharacters(content,mid);
      if (size() <= maxBytes) lo = mid; else hi = mid-1;
    }
    result.content = clipCharacters(content,lo);
    if (size() > maxBytes) throw new WebFetchError("web_fetch_result_too_large");
  }
  return result;
}
export class WebFetchService {
  constructor(private settings: WebFetchSettings = {}, private request: WebRequest = fetch.bind(globalThis)) {}
  async get(request: unknown): Promise<WebFetchResult | {ok:false;error:string}> {
    const parsed = webFetchInput.safeParse(request);
    if (!parsed.success) return {ok:false,error:"invalid_tool_arguments"};
    const limits = webLimits(this.settings);
    const controller = new AbortController();
    const timer = setTimeout(()=>controller.abort(new DOMException("Web fetch deadline exceeded","TimeoutError")),limits.timeoutMs);
    const signal = controller.signal;
    const start = Date.now();
    try {
      const resource = await fetchWebResource(parsed.data.url,limits,this.request,signal);
      signal.throwIfAborted();
      const article = resource.contentType === "text/html" ? extractReadableContent(resource.text,resource.finalUrl,limits)
        : {content:normalizeWebContent(resource.text)};
      if (!article.content.trim()) throw new WebFetchError("web_fetch_empty_content");
      signal.throwIfAborted();
      const result = boundResult({ok:true,url:resource.url,finalUrl:resource.finalUrl,contentType:resource.contentType,
        ...article,truncated:false},limits.maxContentChars,limits.maxResultBytes);
      // Workers clocks may not advance during synchronous work: durationMs is wall time, not CPU time.
      console.log(JSON.stringify({event:"misc.web_fetch",ok:true,durationMs:Date.now()-start,downloadBytes:resource.downloadBytes,
        contentChars:result.content.length,truncated:result.truncated}));
      return result;
    } catch (error) {
      const code = signal.aborted || error instanceof Error && ["AbortError","TimeoutError"].includes(error.name) ? "web_fetch_timeout"
        : error instanceof WebFetchError ? error.message : "web_fetch_unavailable";
      console.warn(JSON.stringify({event:"misc.web_fetch",ok:false,error:code,durationMs:Date.now()-start}));
      return {ok:false,error:code};
    } finally { clearTimeout(timer); controller.abort(); }
  }
}
