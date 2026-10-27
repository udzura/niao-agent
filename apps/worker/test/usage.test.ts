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
    expect(options.redirect).toBe("error");
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
    expect((await network.today()).errorCode).toBe("analytics_unavailable");
    const limit = new UsageAnalytics(credentials, async () => new Response(null, {status: 429}));
    expect((await limit.today()).errorCode).toBe("analytics_rate_limited");
  });
});
