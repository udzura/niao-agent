import {WebFetchError} from "./web-resource";

export function clipCharacters(text: string, max: number): string {
  const cut = text.slice(0,max);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0,-1) : cut;
}
export function normalizeWebContent(text: string): string {
  const lines = text.replace(/\r\n?/g,"\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,"").split("\n");
  let fence = "", fenceSize = 0, blank = 0;
  return lines.filter(line => {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) { fence = marker[1][0]; fenceSize = marker[1].length; }
      else if (marker[1][0] === fence && marker[1].length >= fenceSize && /^ {0,3}(?:`+|~+)\s*$/.test(line)) fence = "";
      blank = 0; return true;
    }
    if (fence) return true;
    blank = line.trim() ? 0 : blank+1;
    return blank <= 1;
  }).join("\n").replace(/^\n+|\n+$/g,"");
}
export interface WebFetchResult {
  ok: true; url: string; finalUrl: string; title?: string; byline?: string; excerpt?: string;
  content: string; contentType: string; truncated: boolean;
}
export function boundResult(result: WebFetchResult, maxChars: number, maxBytes: number): WebFetchResult {
  if (result.content.length > maxChars) {
    result.content = clipCharacters(result.content, maxChars); result.truncated = true;
  }
  const size = () => new TextEncoder().encode(JSON.stringify({ untrusted_reference_data: true, result })).byteLength;
  if (size() > maxBytes) {
    result.truncated = true;
    const content = result.content; let lo = 0, hi = content.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      result.content = clipCharacters(content, mid);
      if (size() <= maxBytes) lo = mid; else hi = mid - 1;
    }
    result.content = clipCharacters(content, lo);
    if (size() > maxBytes) throw new WebFetchError("web_fetch_result_too_large");
  }
  return result;
}
