import {XMLParser, XMLValidator} from "fast-xml-parser";
import {kaniArticleInput,kaniLatestInput,kaniSearchInput,kaniUrl} from "./contracts";
class KaniError extends Error {}
const origin = "https://yota.kani.show";
export function articleUrl(value: unknown): string {
  const parsed = kaniUrl.safeParse(value);
  if (!parsed.success) throw new KaniError("kani_invalid_article_url");
  return `${origin}/${new URL(parsed.data).pathname.split("/")[1]}/`;
}
export function parseKaniIndex(markdown: string) {
  const result = new Map<string,{title:string;url:string;date:string}>();
  for (const line of markdown.split(/\r?\n/)) {
    const match = /^-\s+(\d{4}-\d{2}-\d{2})\s+\[(.+?)\]\((https:\/\/yota\.kani\.show\/e\d+\/(?:index\.md)?)\)/.exec(line);
    if (!match) continue;
    const url = articleUrl(match[3]);
    result.set(url,{title:match[2].replace(/\\([\[\]\\])/g,"$1"),url,date:match[1]});
  }
  if (!result.size) throw new KaniError("kani_invalid_index");
  return [...result.values()];
}
export function latestKaniArticle(xml: string) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml)!==true) throw new KaniError("kani_invalid_feed");
  const channel = new XMLParser({ignoreAttributes:true,parseTagValue:false,processEntities:true,trimValues:true}).parse(xml)?.rss?.channel;
  if (!channel || typeof channel !== "object") throw new KaniError("kani_invalid_feed");
  const raw = channel.item ?? [];
  const items = Array.isArray(raw) ? raw : [raw];
  if (items.length > 1000) throw new KaniError("kani_feed_too_large");
  const articles: {title:string;url:string;publishedAt:string}[] = [];
  for (const item of items) {
    if (typeof item?.title !== "string" || item.title.length > 1000 || typeof item.pubDate !== "string") continue;
    const date = Date.parse(item.pubDate);
    if (!Number.isFinite(date)) continue;
    try { articles.push({title:item.title,url:articleUrl(item.link),publishedAt:new Date(date).toISOString()}); }
    catch { /* Never follow links outside the configured article paths. */ }
  }
  articles.sort((a,b)=>b.publishedAt.localeCompare(a.publishedAt));
  if (!articles.length) throw new KaniError("kani_no_articles");
  return articles[0];
}
export class KaniService {
  constructor(private request: typeof fetch = fetch.bind(globalThis)) {}
  private async read(url: string, markdown = true) {
    const response = await this.request(url,{headers:{Accept:markdown ? "text/markdown" : "application/rss+xml, application/xml"},redirect:"manual",signal:AbortSignal.timeout(8000)});
    if (!response.ok) {
      await response.body?.cancel();
      throw new KaniError(response.status === 404 ? "kani_not_found" : response.status === 429 ? "kani_rate_limited" : "kani_upstream_error");
    }
    if (markdown && !response.headers.get("Content-Type")?.toLowerCase().includes("text/markdown")) {
      await response.body?.cancel(); throw new KaniError("kani_markdown_unavailable");
    }
    if (!response.body) throw new KaniError("kani_invalid_response");
    const reader = response.body.getReader(); const decoder = new TextDecoder();
    let result = "", size = 0;
    try {
      while (true) {
        const {done,value} = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > (markdown ? 262144 : 1048576)) {await reader.cancel();throw new KaniError("kani_response_too_large");}
        result += decoder.decode(value,{stream:true});
      }
      return result + decoder.decode();
    } finally {reader.releaseLock();}
  }
  private async run<T>(operation: string, action: () => Promise<T>) {
    const started = Date.now();
    try {
      const result = await action();
      console.log(JSON.stringify({event:"misc.kani",operation,ok:true,durationMs:Date.now()-started}));
      return {ok:true as const,fetchedAt:new Date().toISOString(),...result};
    } catch (error) {
      const code = error instanceof KaniError ? error.message
        : error instanceof Error && ["AbortError","TimeoutError"].includes(error.name) ? "kani_timeout" : "kani_unavailable";
      console.warn(JSON.stringify({event:"misc.kani",operation,ok:false,error:code,durationMs:Date.now()-started}));
      return {ok:false as const,error:code};
    }
  }
  private async readArticle(url: string, offset: number) {
    const text = await this.read(articleUrl(url));
    const title = /^#\s+(.+)$/m.exec(text)?.[1]?.trim();
    if (!title) throw new KaniError("kani_invalid_article");
    const date = /^date:\s*['"]?(\d{4}-\d{2}-\d{2})/m.exec(text)?.[1] ?? null;
    const characters = Array.from(text);
    if (offset > characters.length) throw new KaniError("kani_invalid_offset");
    const end = Math.min(offset+16000,characters.length);
    return {title,url:articleUrl(url),date,markdown:characters.slice(offset,end).join(""),offset,
      nextOffset:end < characters.length ? end : null,truncated:end < characters.length,totalCharacters:characters.length};
  }
  async article(request: unknown) {
    const input = kaniArticleInput.safeParse(request);
    if (!input.success) return {ok:false as const,error:"invalid_tool_arguments"};
    return this.run("article",()=>this.readArticle(input.data.url,input.data.offset));
  }
  async latest(request: unknown) {
    const input = kaniLatestInput.safeParse(request);
    if (!input.success) return {ok:false as const,error:"invalid_tool_arguments"};
    return this.run("latest",async()=>{
      const latest = latestKaniArticle(await this.read(`${origin}/feed.xml`,false));
      return {latest,article:input.data.includeArticle ? await this.readArticle(latest.url,0) : null};
    });
  }
  async search(request: unknown) {
    const input = kaniSearchInput.safeParse(request);
    if (!input.success) return {ok:false as const,error:"invalid_tool_arguments"};
    return this.run("search",async()=>{
      const normalize = (value: string) => value.normalize("NFKC").toLowerCase();
      const needle = normalize(input.data.query);
      const matches = parseKaniIndex(await this.read(`${origin}/`)).filter(article=>normalize(article.title).includes(needle));
      return {query:input.data.query,articles:matches.slice(0,input.data.limit),total:matches.length,hasMore:matches.length>input.data.limit};
    });
  }
}
