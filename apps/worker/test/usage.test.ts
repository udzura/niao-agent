import { describe, expect, it, vi } from "vitest";
import { UsageAnalytics, parseAccountNeurons, utcDay } from "../src/usage";
const credentials = {CF_ACCOUNT_ID: "a".repeat(32), CF_ANALYTICS_TOKEN: "test-only-analytics-token"};
const reply = (neurons: number) => ({data: {viewer: {accounts: [{aiInferenceAdaptiveGroups: [{sum: {totalNeurons: neurons}}]}]}}, errors: null});

describe("account usage analytics", () => {
  it("uses UTC billing days across JST midnight and UTC rollover", () => {
    expect(utcDay(new Date("2026-10-28T00:30:00+09:00"))).toEqual({dayStart: "2026-10-27T00:00:00.000Z", dayEnd: "2026-10-28T00:00:00.000Z"});
    expect(utcDay(new Date("2026-10-28T09:00:00+09:00")).dayStart).toBe("2026-10-28T00:00:00.000Z");
  });
  it("distinguishes zero usage from missing permissions, partial errors and invalid data", () => {
    expect(parseAccountNeurons(reply(0))).toBe(0);
    expect(parseAccountNeurons({data: {viewer: {accounts: [{aiInferenceAdaptiveGroups: []}]}}})).toBe(0);
    expect(parseAccountNeurons(reply(23.35))).toBe(23.35);
    for (const input of [null, {}, {data: {viewer: {accounts: []}}}, {...reply(10), errors: [{message: "denied"}]}, reply(-1), reply(NaN)]) {
      expect(() => parseAccountNeurons(input)).toThrow();
    }
  });
  it("does not call Cloudflare when unconfigured or return a fabricated zero", async () => {
    const request = vi.fn();
    const usage = await new UsageAnalytics({}, request).today();
    expect(usage.status).toBe("not_configured"); expect(usage.neurons).toBeNull(); expect(request).not.toHaveBeenCalled();
  });
  it("sends a fixed aggregate query with header auth, caches and deduplicates concurrent reads", async () => {
    const request = vi.fn(async (_url: string, _options: RequestInit) => Response.json(reply(12.25)));
    const api = new UsageAnalytics(credentials, request as typeof fetch);
    const now = new Date("2026-10-27T12:00:00Z");
    const results = await Promise.all([api.today(now), api.today(now)]);
    expect(results[0].neurons).toBe(12.25); expect(results[0]).toEqual(results[1]);
    await api.today(new Date("2026-10-27T12:00:59Z"));
    expect(request).toHaveBeenCalledTimes(1);
    const [url, options] = request.mock.calls[0];
    expect(url).toBe("https://api.cloudflare.com/client/v4/graphql");
    expect(options.redirect).toBe("manual");
    expect(options.headers).toMatchObject({Authorization: "Bearer test-only-analytics-token"});
    const body = JSON.parse(options.body as string);
    expect(body.query).toContain("sum { totalNeurons }");
    expect(body.variables).toEqual({account: credentials.CF_ACCOUNT_ID, start: "2026-10-27T00:00:00.000Z", end: "2026-10-27T12:00:00.000Z"});
    await api.today(new Date("2026-10-27T12:01:00Z"));
    expect(request).toHaveBeenCalledTimes(2);
  });
  it("never reuses yesterday's cache, even within its TTL", async () => {
    const request = vi.fn(async () => Response.json(reply(1)));
    const api = new UsageAnalytics(credentials, request);
    await api.today(new Date("2026-10-27T23:59:59Z"));
    await api.today(new Date("2026-10-28T00:00:00Z"));
    expect(request).toHaveBeenCalledTimes(2);
  });
  it("sanitizes API failures and retries after a short negative cache", async () => {
    const request = vi.fn(async () => Response.json({errors: [{message: credentials.CF_ANALYTICS_TOKEN}]}));
    const api = new UsageAnalytics(credentials, request);
    const result = await api.today(new Date("2026-10-27T12:00:00Z"));
    expect(result.status).toBe("unavailable"); expect(result.neurons).toBeNull();
    expect(JSON.stringify(result)).not.toContain(credentials.CF_ANALYTICS_TOKEN);
    await api.today(new Date("2026-10-27T12:00:14Z")); expect(request).toHaveBeenCalledTimes(1);
    await api.today(new Date("2026-10-27T12:00:15Z")); expect(request).toHaveBeenCalledTimes(2);
  });
  it("handles network and rate limit failures without claiming zero usage", async () => {
    const network = new UsageAnalytics(credentials, async () => { throw new Error("secret provider body"); });
    expect((await network.today()).errorCode).toBe("analytics_fetch_failed");
    const limit = new UsageAnalytics(credentials, async () => new Response(null, {status: 429}));
    expect((await limit.today()).errorCode).toBe("analytics_rate_limited");
  });
});

it('binds the actual Workers global fetch rather than invoking it with the analytics instance',async () => {
  // A malformed URL rejects before networking. The native receiver check runs
  // first, so inspecting the failure distinguishes binding from URL validation.
  const api = new UsageAnalytics(credentials);
  const receiver = api as unknown as {request: typeof fetch};
  let message = '';
  try { await receiver.request('not a URL'); } catch(error) { message=String(error); }
  expect(message).not.toContain('Illegal invocation');
  expect(message).toMatch(/URL/i);
});

it('logs bounded redacted runtime diagnostics and distinguishes HTTP, timeout and decoding failures',async () => {
  const warn = vi.spyOn(console,'warn').mockImplementation(()=>{});
  try {
    const api = new UsageAnalytics(credentials,async () => { throw new TypeError(`Illegal invocation ${credentials.CF_ACCOUNT_ID} Bearer ${credentials.CF_ANALYTICS_TOKEN}`); });
    expect((await api.today()).errorCode).toBe('analytics_fetch_failed');
    const log = JSON.parse(warn.mock.calls[0][0] as string);
    expect(log).toMatchObject({event:'analytics.error',phase:'fetch',errorType:'TypeError',code:'analytics_fetch_failed'});
    expect(log.message).toContain('Illegal invocation');
    expect(JSON.stringify(warn.mock.calls)).not.toContain(credentials.CF_ACCOUNT_ID);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(credentials.CF_ANALYTICS_TOKEN);
    const http = new UsageAnalytics(credentials,async () => new Response('private upstream body',{status:403}));
    expect((await http.today()).errorCode).toBe('analytics_http_403');
    expect(JSON.parse(warn.mock.calls.at(-1)![0] as string)).toMatchObject({httpStatus:403,phase:'fetch'});
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private upstream body');
    const timeout = new UsageAnalytics(credentials,async () => {throw new DOMException('expired','TimeoutError');});
    expect((await timeout.today()).errorCode).toBe('analytics_timeout');
    const invalid = new UsageAnalytics(credentials,async () => new Response('not JSON'));
    expect((await invalid.today()).errorCode).toBe('analytics_invalid_json');
  } finally { warn.mockRestore(); }
});

it.each([301,302,303,307,308])('rejects HTTP %i without following the credential to a redirect target',async status => {
  const request = vi.fn(async (_url: string,options: RequestInit) => {
    expect(options.redirect).toBe('manual');
    return new Response('redirect body',{status,headers:{Location:'https://other.invalid/collect'}});
  });
  const result = await new UsageAnalytics(credentials,request as typeof fetch).today();
  expect(result).toMatchObject({status:'unavailable',neurons:null,errorCode:`analytics_http_${status}`});
  expect(request).toHaveBeenCalledTimes(1);
  expect(request.mock.calls[0][0]).toBe('https://api.cloudflare.com/client/v4/graphql');
});
