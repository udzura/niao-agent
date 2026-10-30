import { describe, expect, it, vi } from "vitest";
import { PlatformAnalytics, parsePlatformMetric, parseSubscriptions, workersPlan } from "../src/platform-usage";

const credentials = {CF_ACCOUNT_ID: "a".repeat(32), CF_ANALYTICS_TOKEN: "test-only-analytics-token"};
const now = new Date("2026-10-30T12:00:00Z");
const aggregate = (dataset: string, sum: unknown) => ({data: {viewer: {accounts: [{[dataset]: [{sum}]}]}}, errors: null});
const subscriptions = (result: unknown[] = []) => ({success: true, errors: [], result});
const paid = {rate_plan: {id: "WORKERS_PAID"}, state: "Paid"};
const respond = async (url: string | URL | Request, init?: RequestInit) => {
  if (String(url).includes("/subscriptions")) return Response.json(subscriptions());
  const query = JSON.parse(init!.body as string).query as string;
  return Response.json(query.includes("workersInvocationsAdaptive")
    ? aggregate("workersInvocationsAdaptive", {requests: 1454})
    : aggregate("durableObjectsPeriodicGroups", {duration: 210.633207296}));
};

describe("platform usage", () => {
  it("reads both daily aggregates with header auth and preserves GB-s without conversion", async () => {
    const fetcher = vi.fn(respond);
    const api = new PlatformAnalytics(credentials, fetcher as typeof fetch);
    const [a, b] = await Promise.all([api.today(now), api.today(now)]);
    expect(a).toEqual(b);
    expect(a).toMatchObject({v: 1, dayStart: "2026-10-30T00:00:00.000Z", dayEnd: "2026-10-31T00:00:00.000Z",
      workers: {status: "available", requests: 1454}, durableObjects: {status: "available", durationGbSeconds: 210.633207296},
      plan: {status: "available", name: "free"}});
    expect(fetcher).toHaveBeenCalledTimes(3);
    for (const [url, options] of fetcher.mock.calls) {
      expect(String(url)).toMatch(/^https:\/\/api\.cloudflare\.com\/client\/v4\//);
      expect(options).toMatchObject({redirect: "manual", headers: {Authorization: `Bearer ${credentials.CF_ANALYTICS_TOKEN}`}});
      expect(String(url)).not.toContain(credentials.CF_ANALYTICS_TOKEN);
      if (options!.body) expect(JSON.parse(options!.body as string).variables).toEqual({account: credentials.CF_ACCOUNT_ID,
        start: "2026-10-30T00:00:00.000Z", end: now.toISOString()});
    }
    await api.today(new Date(now.getTime() + 59_000)); expect(fetcher).toHaveBeenCalledTimes(3);
    await api.today(new Date(now.getTime() + 60_000)); expect(fetcher).toHaveBeenCalledTimes(5);
    await api.today(new Date(now.getTime() + 3_600_000)); expect(fetcher).toHaveBeenCalledTimes(8);
  });
  it("does not reuse yesterday's counts across midnight, but retains the plan cache", async () => {
    const fetcher = vi.fn(respond);
    const api = new PlatformAnalytics(credentials, fetcher as typeof fetch);
    await api.today(new Date("2026-10-30T23:59:59Z"));
    const result = await api.today(new Date("2026-10-31T00:00:00Z"));
    expect(fetcher).toHaveBeenCalledTimes(5);
    expect(result.dayStart).toBe("2026-10-31T00:00:00.000Z");
  });
  it("shows working metrics when billing permission is missing and negatively caches only the failure", async () => {
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => String(url).includes("/subscriptions")
      ? new Response(null, {status: 403}) : respond(url, init));
    const api = new PlatformAnalytics(credentials, fetcher as typeof fetch);
    const result = await api.today(now);
    expect(result.workers.requests).toBe(1454);
    expect(result.durableObjects.durationGbSeconds).toBe(210.633207296);
    expect(result.plan).toMatchObject({status: "unavailable", name: null, errorCode: "analytics_http_403"});
    await api.today(new Date(now.getTime() + 14_000)); expect(fetcher).toHaveBeenCalledTimes(3);
    await api.today(new Date(now.getTime() + 15_000)); expect(fetcher).toHaveBeenCalledTimes(4);
  });
  it("does not hide DO usage when the Workers query fails or claim the failure is zero", async () => {
    const fetcher = async (url: string | URL | Request, init?: RequestInit) => String(init?.body).includes("workersInvocationsAdaptive")
      ? Response.json({errors: [{message: "denied"}], data: null}) : respond(url, init);
    const result = await new PlatformAnalytics(credentials, fetcher as typeof fetch).today(now);
    expect(result.workers).toMatchObject({status: "unavailable", requests: null, errorCode: "analytics_rejected"});
    expect(result.durableObjects.status).toBe("available");
  });
  it("does not call Cloudflare or invent Free/zero when credentials are absent or malformed", async () => {
    const fetcher = vi.fn(respond);
    const result = await new PlatformAnalytics({}, fetcher as typeof fetch).today(now);
    expect(result.workers).toMatchObject({status: "not_configured", requests: null});
    expect(result.plan).toMatchObject({status: "not_configured", name: null});
    const invalid = await new PlatformAnalytics({...credentials, CF_ACCOUNT_ID: "invalid"}, fetcher as typeof fetch).today(now);
    expect(invalid.workers.errorCode).toBe("analytics_configuration_invalid");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("distinguishes a valid empty/zero aggregate from partial errors and invalid data", () => {
    const parse = (value: unknown) => parsePlatformMetric(value, "workersInvocationsAdaptive", "requests");
    expect(parse(aggregate("workersInvocationsAdaptive", {requests: 0}))).toBe(0);
    expect(parse({data: {viewer: {accounts: [{workersInvocationsAdaptive: []}]}}})).toBe(0);
    for (const value of [null, {}, {data: {viewer: {accounts: []}}}, aggregate("wrong", {requests: 5}),
      aggregate("workersInvocationsAdaptive", {requests: -1}), aggregate("workersInvocationsAdaptive", {requests: "100"}),
      {...aggregate("workersInvocationsAdaptive", {requests: 100}), errors: [{message: "partial failure"}]}]) {
      expect(() => parse(value)).toThrow();
    }
  });
});

describe("Workers plan verification", () => {
  it("uses account Workers subscriptions, ignoring unrelated zone plans", () => {
    expect(workersPlan([], now)).toBe("free");
    expect(workersPlan([{rate_plan: {id: "CF_FREE"}, state: "Paid"}], now)).toBe("free");
    expect(workersPlan([paid], now)).toBe("paid");
    expect(workersPlan([{...paid, rate_plan: {id: "PARTNERS_WORKERS_ENT"}}], now)).toBe("paid");
    expect(() => workersPlan([{...paid, rate_plan: {id: "WORKERS_UNKNOWN"}}], now)).toThrow("plan_unrecognized_subscription");
    expect(() => workersPlan([{...paid, state: "AwaitingPayment"}], now)).toThrow();
  });
  it("does not label a cancelled subscription Free until the paid period has ended", () => {
    expect(workersPlan([{...paid, state: "Cancelled", current_period_end: "2026-11-01T00:00:00Z"}], now)).toBe("paid");
    expect(workersPlan([{...paid, state: "Cancelled", current_period_end: "2026-10-01T00:00:00Z"}], now)).toBe("free");
    expect(() => workersPlan([{...paid, state: "Cancelled"}], now)).toThrow();
  });
  it("rejects failed/malformed subscription responses instead of inferring Free", () => {
    for (const value of [{}, {success: false, result: []}, subscriptions([{}]),
      {...subscriptions(), errors: [{message: "denied"}]}, subscriptions([{...paid, current_period_end: "invalid"}])]) {
      expect(() => parseSubscriptions(value)).toThrow();
    }
    expect(parseSubscriptions({...subscriptions(), result_info: {page: 1, per_page: 50, total_count: 0}}).nextPage).toBeNull();
  });
  it("reads every subscription page before inferring Free, including Paid on a later page", async () => {
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (!String(url).includes("/subscriptions")) return respond(url, init);
      const page = Number(new URL(String(url)).searchParams.get("page"));
      return Response.json({...subscriptions(page === 1 ? [{rate_plan: {id: "R2"}, state: "Paid"}] : [paid]),
        result_info: {page, per_page: 1, total_count: 2}});
    });
    const result = await new PlatformAnalytics(credentials, fetcher as typeof fetch).today(now);
    expect(result.plan.name).toBe("paid");
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
  it("fails closed on incomplete/repeated pagination or a later-page denial", async () => {
    for (const laterDenied of [false, true]) {
      const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
        if (!String(url).includes("/subscriptions")) return respond(url, init);
        const page = Number(new URL(String(url)).searchParams.get("page"));
        if (page > 1 && laterDenied) return new Response(null, {status: 403});
        return Response.json({...subscriptions([{rate_plan: {id: "R2"}, state: "Paid"}]), result_info: {page: 1, per_page: 1, total_count: 2}});
      };
      const result = await new PlatformAnalytics(credentials, fetcher as typeof fetch).today(now);
      expect(result.plan.status).toBe("unavailable"); expect(result.plan.name).toBeNull();
    }
  });
});
