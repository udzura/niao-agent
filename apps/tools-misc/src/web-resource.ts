import ipaddr from "ipaddr.js";

export class WebFetchError extends Error { }
export const defaultWebLimits = {
  timeoutMs: 8000, maxRedirects: 3, maxDownloadBytes: 32768, maxContentChars: 12000,
  maxResultBytes: 32768, maxDomElements: 300, maxDomDepth: 48,
};
export type WebLimits = typeof defaultWebLimits;
export interface WebFetchSettings {
  WEB_FETCH_TIMEOUT_MS?: string;
  WEB_FETCH_MAX_REDIRECTS?: string;
  WEB_FETCH_MAX_DOWNLOAD_BYTES?: string;
  WEB_FETCH_MAX_CONTENT_CHARS?: string;
  WEB_FETCH_MAX_RESULT_BYTES?: string;
  WEB_FETCH_MAX_DOM_ELEMENTS?: string;
  WEB_FETCH_MAX_DOM_DEPTH?: string;
}
export function webLimits(settings: WebFetchSettings = {}): WebLimits {
  const number = (value: string | undefined, fallback: number, min: number, max: number) =>
    value !== undefined && /^\d+$/.test(value) ? Math.min(max, Math.max(min, Number(value))) : fallback;
  return {
    timeoutMs: number(settings.WEB_FETCH_TIMEOUT_MS, 8000, 100, 45000),
    maxRedirects: number(settings.WEB_FETCH_MAX_REDIRECTS, 3, 0, 5),
    maxDownloadBytes: number(settings.WEB_FETCH_MAX_DOWNLOAD_BYTES, 32768, 1024, 524288 * 4),
    maxContentChars: number(settings.WEB_FETCH_MAX_CONTENT_CHARS, 12000, 100, 32000),
    maxResultBytes: number(settings.WEB_FETCH_MAX_RESULT_BYTES, 32768, 8192, 65536 * 4),
    maxDomElements: number(settings.WEB_FETCH_MAX_DOM_ELEMENTS, 300, 100, 10000),
    maxDomDepth: number(settings.WEB_FETCH_MAX_DOM_DEPTH, 48, 8, 96),
  };
}
const internalSuffixes = ["localhost", "local", "internal", "localdomain", "lan", "home", "corp", "intranet",
  "test", "invalid", "example", "onion", "arpa", "svc", "cloudflare-internal.com"];
function publicHostname(hostname: string) {
  return hostname.length <= 253 && hostname.includes(".") && !internalSuffixes.some(suffix => hostname === suffix || hostname.endsWith(`.${suffix}`)) &&
    hostname.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) &&
    !["metadata", "instance-data"].includes(hostname.split(".")[0]);
}
export function isPublicAddress(value: string): boolean {
  if (value === "168.63.129.16" || value.includes("%") || !ipaddr.isValid(value)) return false;
  const address = ipaddr.parse(value);
  if (address.range() !== "unicast") return false;
  // Restrict IPv6 to currently allocated global unicast, excluding special ranges above.
  return address.kind() === "ipv4" || address.match(ipaddr.parse("2000::"), 3);
}
export function validateWebUrl(value: string): URL {
  if (value.length > 2048 || /[\u0000-\u0020\u007f\\]/.test(value)) throw new WebFetchError("web_fetch_unsafe_url");
  let url: URL;
  try { url = new URL(value); } catch { throw new WebFetchError("web_fetch_unsafe_url"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.port || value.match(/^[a-z]+:\/\/([^/?#]+)/i)?.[1].includes("@")) throw new WebFetchError("web_fetch_unsafe_url");
  // URL canonicalization also catches integer, hexadecimal and short IPv4 forms.
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  const literal = hostname.replace(/^\[|\]$/g, "");
  if (ipaddr.isValid(literal)) {
    if (!isPublicAddress(literal)) throw new WebFetchError("web_fetch_unsafe_url");
  } else if (!publicHostname(hostname)) throw new WebFetchError("web_fetch_unsafe_url");
  url.hostname = hostname;
  url.hash = "";
  return url;
}

// Fetch implementations are injected only in tests. Production always uses native fetch.
export type WebRequest = typeof fetch;
export async function readWebBytes(response: Response, limit: number, signal: AbortSignal): Promise<Uint8Array> {
  const length = response.headers.get("Content-Length");
  if (length && /^\d+$/.test(length) && Number(length) > limit) {
    void response.body?.cancel().catch(() => { });
    throw new WebFetchError("web_fetch_response_too_large");
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  const cancel = () => { void reader.cancel().catch(() => { }); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { cancel(); throw new WebFetchError("web_fetch_response_too_large"); }
      chunks.push(value);
    }
  } finally { signal.removeEventListener("abort", cancel); reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
async function publicDns(url: URL, request: WebRequest, signal: AbortSignal) {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (ipaddr.isValid(hostname)) return; // Already classified by validateWebUrl.
  // A fixed public DoH endpoint avoids assuming Node DNS support. Check BOTH families.
  // This is preflight validation, not IP pinning: native fetch resolves again.
  const results = await Promise.all(["A", "AAAA"].map(async type => {
    const resolver = new URL("https://cloudflare-dns.com/dns-query");
    resolver.search = new URLSearchParams({ name: hostname, type }).toString();
    const response = await request(resolver.href, { redirect: "manual", signal, headers: { Accept: "application/dns-json" } });
    if (!response.ok) { void response.body?.cancel().catch(() => { }); throw new WebFetchError("web_fetch_dns_failed"); }
    let data: { Status?: unknown; TC?: unknown; Answer?: { type?: unknown; data?: unknown }[] };
    try { data = JSON.parse(new TextDecoder().decode(await readWebBytes(response, 16384, signal))); }
    catch (error) { if (signal.aborted) throw signal.reason; if (error instanceof WebFetchError) throw error; throw new WebFetchError("web_fetch_dns_failed"); }
    if (!data || ![0, 3].includes(data.Status as number) || data.TC === true ||
      (data.Answer !== undefined && (!Array.isArray(data.Answer) || data.Answer.length > 64))) throw new WebFetchError("web_fetch_dns_failed");
    const addresses: string[] = [];
    for (const answer of data.Answer ?? []) {
      if (answer.type === 1 || answer.type === 28) {
        if (typeof answer.data !== "string" || !isPublicAddress(answer.data)) throw new WebFetchError("web_fetch_unsafe_url");
        addresses.push(answer.data);
      } else if (answer.type === 5) {
        if (typeof answer.data !== "string" || !publicHostname(answer.data.toLowerCase().replace(/\.$/, ""))) throw new WebFetchError("web_fetch_unsafe_url");
      }
    }
    return addresses;
  }));
  if (!results.some(addresses => addresses.length)) throw new WebFetchError("web_fetch_dns_failed");
}
export interface WebResource { url: string; finalUrl: string; contentType: string; text: string; downloadBytes: number }
export async function fetchWebResource(input: string, limits: WebLimits, request: WebRequest,
  signal: AbortSignal): Promise<WebResource> {
  let target = validateWebUrl(input);
  const original = target.href;
  const visited = new Set<string>();
  for (let redirects = 0; ; redirects++) {
    signal.throwIfAborted();
    if (visited.has(target.href)) throw new WebFetchError("web_fetch_redirect_limit");
    visited.add(target.href);
    await publicDns(target, request, signal);
    const response = await request(target.href, {
      redirect: "manual", signal, headers: {
        Accept: "text/html, text/markdown;q=0.9, text/plain;q=0.8",
        "User-Agent": "Niao-WebFetch/1.0",
      }
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      void response.body?.cancel().catch(() => { });
      if (redirects >= limits.maxRedirects) throw new WebFetchError("web_fetch_redirect_limit");
      const location = response.headers.get("Location");
      if (!location || location.length > 2048) throw new WebFetchError("web_fetch_invalid_redirect");
      let resolved: string;
      try { resolved = new URL(location, target).href; } catch { throw new WebFetchError("web_fetch_invalid_redirect"); }
      const next = validateWebUrl(resolved);
      if (target.protocol === "https:" && next.protocol !== "https:") throw new WebFetchError("web_fetch_unsafe_url");
      target = next;
      continue;
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => { });
      throw new WebFetchError(response.status === 429 ? "web_fetch_rate_limited" : "web_fetch_http_error");
    }
    const header = response.headers.get("Content-Type") ?? "";
    const contentType = header.split(";", 1)[0].trim().toLowerCase();
    if (!["text/html", "text/plain", "text/markdown", "text/x-markdown"].includes(contentType)) {
      void response.body?.cancel().catch(() => { });
      throw new WebFetchError("web_fetch_unsupported_content_type");
    }
    const bytes = await readWebBytes(response, limits.maxDownloadBytes, signal);
    const charset = header.match(/;\s*charset\s*=\s*["']?([^;\s"']+)/i)?.[1] ?? "utf-8";
    let text: string;
    try { text = new TextDecoder(charset, { fatal: true, ignoreBOM: false }).decode(bytes); }
    catch { throw new WebFetchError("web_fetch_invalid_encoding"); }
    return { url: original, finalUrl: target.href, contentType, text, downloadBytes: bytes.byteLength };
  }
}
