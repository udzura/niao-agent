import {Readability} from "@mozilla/readability";
import {DOMParser, type HTMLElement} from "linkedom/worker";
import TurndownService from "turndown";
import {WebFetchError, type WebLimits, validateWebUrl} from "./web-resource";

import {clipCharacters, normalizeWebContent} from "./web-result";
export {clipCharacters, normalizeWebContent} from "./web-result";

export interface WebArticle {title?:string;byline?:string;excerpt?:string;content:string}
function metadata(text: string | null | undefined, max: number) {
  return text ? clipCharacters(text.replace(/\s+/g," ").trim(),max) || undefined : undefined;
}
export function extractReadableContent(html: string, finalUrl: string, limits: WebLimits): WebArticle {
  // Cheap preflight before DOM construction; the precise node/depth guard follows.
  if ((html.match(/</g)?.length ?? 0) > limits.maxDomElements*3) throw new WebFetchError("web_fetch_document_too_complex");
  const source = /<html[\s>]/i.test(html) ? html : `<html><head></head><body>${html}</body></html>`;
  const document = new DOMParser().parseFromString(source,"text/html");
  const stack = [{node:document.documentElement,depth:1}];
  let elements = 0, nodes = 0;
  while (stack.length) {
    const {node,depth} = stack.pop()!;
    if (++nodes > limits.maxDomElements*3 || depth > limits.maxDomDepth ||
        (node.nodeType === 1 && ++elements > limits.maxDomElements)) throw new WebFetchError("web_fetch_document_too_complex");
    for (const child of node.childNodes) stack.push({node:child as typeof node,depth:depth+1});
  }
  Object.defineProperty(document,"documentURI",{value:finalUrl});
  Object.defineProperty(document,"baseURI",{value:finalUrl});
  const title = metadata(document.querySelector("title")?.textContent,300);
  // LinkeDOM parses only: it does not execute scripts or load resources.
  for (const node of document.querySelectorAll("script,style,noscript,template,nav,aside,footer,form,svg,canvas,iframe,object,embed,base,link,[hidden],[aria-hidden='true']")) node.remove();
  for (const node of document.querySelectorAll("[style]")) {
    if (/(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(node.getAttribute("style") ?? "")) node.remove();
  }
  for (const link of document.querySelectorAll("a[href]")) {
    try {
      const resolved = new URL(link.getAttribute("href")!,finalUrl);
      const safe = validateWebUrl(resolved.href); safe.hash = resolved.hash;
      link.setAttribute("href",safe.href);
    }
    catch { link.removeAttribute("href"); }
  }
  // Return the extracted DOM directly to Turndown, avoiding a second HTML parse.
  const article = new Readability<HTMLElement>(document,{
    charThreshold:1, keepClasses:true, maxElemsToParse:limits.maxDomElements, disableJSONLD:true,
    serializer:node => node as unknown as HTMLElement,
  }).parse();
  if (!article?.content) throw new WebFetchError("web_fetch_extraction_failed");
  const converter = new TurndownService({headingStyle:"atx",codeBlockStyle:"fenced",bulletListMarker:"-"});
  converter.remove(["script","style","iframe","object","embed","img","input","button"]);
  // GFM's table plugin requires HTMLTableElement.rows, which LinkeDOM lacks.
  // Use a bounded rule for simple header tables, and readable rows for other tables.
  converter.addRule("simpleTables",{filter:"table",replacement:(_content,node) => {
    const table = node as unknown as HTMLElement;
    const rows = Array.from(table.querySelectorAll("tr")).filter(row => row.closest("table") === table);
    const cells = rows.map(row => Array.from(row.children as Iterable<HTMLElement>).filter(cell => ["TD","TH"].includes(cell.tagName)));
    const rendered = cells.map(row => row.map(cell => converter.turndown(cell as never).replace(/\|/g,"\\|").replace(/\n+/g," ").trim()));
    const simple = cells.length && cells[0].length && cells[0].every(cell=>cell.tagName === "TH") &&
      cells.every(row => row.length === cells[0].length && row.every(cell => !cell.hasAttribute("rowspan") && !cell.hasAttribute("colspan")));
    if (!simple) return "\n\n"+rendered.map(row=>row.join(" | ")).join("\n\n")+"\n\n";
    return "\n\n"+[rendered[0],rendered[0].map(()=>"---"),...rendered.slice(1)].map(row=>"| "+row.join(" | ")+" |").join("\n")+"\n\n";
  }});
  const content = normalizeWebContent(converter.turndown(article.content as never));
  if (!content.trim()) throw new WebFetchError("web_fetch_extraction_failed");
  return {title:metadata(article.title,300) ?? title,byline:metadata(article.byline,200),excerpt:metadata(article.excerpt,500),content};
}
