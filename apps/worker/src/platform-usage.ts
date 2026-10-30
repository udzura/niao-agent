import { AnalyticsError, readCloudflare, utcDay, validNeurons, type AnalyticsEnv, type AnalyticsResult } from "./usage";

// Verified with the live Cloudflare schema and the existing Analytics token.
// duration is already GB*s: do not multiply by memory or sum request wall times.
export const WORKERS_USAGE_QUERY = `query NiaoWorkersDaily($account: string!, $start: Time!, $end: Time!) {
  viewer { accounts(filter: {accountTag: $account}) {
    workersInvocationsAdaptive(limit: 1, filter: {datetime_geq: $start, datetime_lt: $end}) { sum { requests } }
  } }
}`;
export const DO_USAGE_QUERY = `query NiaoDurableObjectsDaily($account: string!, $start: Time!, $end: Time!) {
  viewer { accounts(filter: {accountTag: $account}) {
    durableObjectsPeriodicGroups(limit: 1, filter: {datetime_geq: $start, datetime_lt: $end}) { sum { duration } }
  } }
}`;
type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AnalyticsError("analytics_invalid_response");
  return value as ObjectValue;
}
export function parsePlatformMetric(value: unknown, dataset: string, field: string): number {
  const response = object(value);
  if (response.errors != null && (!Array.isArray(response.errors) || response.errors.length)) throw new AnalyticsError("analytics_rejected");
  const accounts = object(object(response.data).viewer).accounts;
  if (!Array.isArray(accounts) || accounts.length !== 1) throw new AnalyticsError("analytics_invalid_response");
  const groups = object(accounts[0])[dataset];
  if (!Array.isArray(groups) || groups.length > 1) throw new AnalyticsError("analytics_invalid_response");
  if (!groups.length) return 0;
  const metric = object(object(groups[0]).sum)[field];
  if (!validNeurons(metric)) throw new AnalyticsError("analytics_invalid_response");
  return metric;
}

interface Subscription {
  rate_plan: {id: string};
  state: string;
  current_period_end?: string;
}
interface SubscriptionPage { subscriptions: Subscription[]; nextPage: number | null }
export function parseSubscriptions(value: unknown): SubscriptionPage {
  const response = object(value);
  if (response.success !== true || !Array.isArray(response.result)
      || (response.errors != null && (!Array.isArray(response.errors) || response.errors.length))) {
    throw new AnalyticsError("plan_rejected");
  }
  const subscriptions = response.result.map(value => {
    const row = object(value), plan = object(row.rate_plan);
    if (typeof plan.id !== "string" || typeof row.state !== "string") throw new AnalyticsError("plan_invalid_response");
    if (row.current_period_end != null && (typeof row.current_period_end !== "string" || !Number.isFinite(Date.parse(row.current_period_end)))) {
      throw new AnalyticsError("plan_invalid_response");
    }
    return {rate_plan: {id: plan.id}, state: row.state, current_period_end: row.current_period_end as string | undefined};
  });
  let nextPage: number | null = null;
  if (response.result_info != null) {
    const info = object(response.result_info);
    if (info.total_count != null) {
      if (!Number.isSafeInteger(info.total_count) || (info.total_count as number) < 0) throw new AnalyticsError("plan_invalid_response");
      const page = info.page ?? 1, perPage = info.per_page ?? subscriptions.length;
      if (!Number.isSafeInteger(page) || (page as number) < 1 || !Number.isSafeInteger(perPage) || (perPage as number) < 1) {
        if (info.total_count !== 0 || subscriptions.length) throw new AnalyticsError("plan_invalid_response");
      } else if ((page as number) * (perPage as number) < (info.total_count as number)) {
        if (!subscriptions.length) throw new AnalyticsError("plan_incomplete_response");
        nextPage = (page as number) + 1;
      }
    }
  }
  return {subscriptions, nextPage};
}

// Account-level Workers subscriptions only; zone Free/Pro plans are unrelated.
// Free is inferred only after reading the complete successful subscription list.
export function workersPlan(subscriptions: Subscription[], now: Date): "free" | "paid" {
  const paidIDs = new Set(["WORKERS_PAID", "PARTNERS_WORKERS_ENT", "PARTNERS_WORKERS_SS", "PARTNERS_WORKERS_BASIC"]);
  let unknown = false;
  for (const row of subscriptions) {
    const id = row.rate_plan.id.toUpperCase();
    if (!id.includes("WORKERS")) continue;
    if (row.state === "Expired") continue;
    if (row.state === "Cancelled") {
      if (!row.current_period_end) { unknown = true; continue; }
      if (Date.parse(row.current_period_end) <= now.getTime()) continue;
    }
    if (id === "WORKERS_FREE") continue;
    if (paidIDs.has(id) && ["Paid", "Provisioned", "Trial", "Cancelled"].includes(row.state)) return "paid";
    unknown = true;
  }
  if (unknown) throw new AnalyticsError("plan_unrecognized_subscription");
  return "free";
}

// This cache is local to one Agent and credential set. Each metric can fail
// independently; a Billing permission failure must not hide working analytics.
export class PlatformAnalytics {
  private cache = new Map<string, {day: string; expires: number; value: AnalyticsResult<unknown>}>();
  private inFlight = new Map<string, Promise<AnalyticsResult<unknown>>>();
  constructor(private env: AnalyticsEnv, private request: typeof fetch = fetch.bind(globalThis)) {}
  private async cached<T>(key: string, now: Date, ttl: number, load: () => Promise<AnalyticsResult<T>>): Promise<AnalyticsResult<T>> {
    const day = key === "plan" ? "plan" : utcDay(now).dayStart;
    const cache = this.cache.get(key);
    if (cache?.day === day && cache.expires > now.getTime()) return cache.value as AnalyticsResult<T>;
    const flightKey = `${key}:${day}`;
    const existing = this.inFlight.get(flightKey);
    if (existing) return existing as Promise<AnalyticsResult<T>>;
    const promise = load().then(value => {
      this.cache.set(key, {day, expires: now.getTime() + (value.status === "available" ? ttl : 15_000), value});
      return value;
    }).finally(() => this.inFlight.delete(flightKey));
    this.inFlight.set(flightKey, promise);
    return promise;
  }
  private async plan(now: Date): Promise<AnalyticsResult<"free" | "paid">> {
    const subscriptions: Subscription[] = [];
    const signal = AbortSignal.timeout(8_000);
    for (let page = 1; page <= 10; page++) {
      const result = await readCloudflare(this.env, this.request, now, {
        path: `accounts/${this.env.CF_ACCOUNT_ID}/subscriptions?page=${page}&per_page=50`, operation: "workers_plan", signal, parse: parseSubscriptions,
      });
      if (!result.data) return {...result, data: null};
      subscriptions.push(...result.data.subscriptions);
      if (result.data.nextPage === null) {
        try { return {...result, data: workersPlan(subscriptions, now)}; }
        catch (error) { return {...result, status: "unavailable", data: null, queriedAt: null, errorCode: (error as Error).message}; }
      }
      if (result.data.nextPage !== page + 1) break;
    }
    return {status: "unavailable", data: null, queriedAt: null, errorCode: "plan_incomplete_response"};
  }
  async today(now = new Date()) {
    const period = utcDay(now);
    const metric = (operation: string, query: string, dataset: string, field: string) => this.cached(operation, now, 60_000, () =>
      readCloudflare(this.env, this.request, now, {
        path: "graphql", operation, body: {query, variables: {account: this.env.CF_ACCOUNT_ID, start: period.dayStart, end: now.toISOString()}},
        parse: body => parsePlatformMetric(body, dataset, field),
      }));
    const [workers, durableObjects, plan] = await Promise.all([
      metric("workers", WORKERS_USAGE_QUERY, "workersInvocationsAdaptive", "requests"),
      metric("durable_objects", DO_USAGE_QUERY, "durableObjectsPeriodicGroups", "duration"),
      this.cached("plan", now, 3_600_000, () => this.plan(now)),
    ]);
    const {data: requests, ...workersStatus} = workers;
    const {data: durationGbSeconds, ...doStatus} = durableObjects;
    const {data: name, ...planStatus} = plan;
    return {v: 1, ...period, asOf: now.toISOString(), workers: {...workersStatus, requests},
      durableObjects: {...doStatus, durationGbSeconds}, plan: {...planStatus, name}};
  }
}
