// Verified against Cloudflare's live GraphQL schema (2026-10-28).
// Analytics is delayed/possibly sampled; this is not a billing ledger or quota gate.
export const USAGE_QUERY = `query NiaoDailyUsage($account: string!, $start: Time!, $end: Time!) {
  viewer { accounts(filter: {accountTag: $account}) {
    aiInferenceAdaptiveGroups(limit: 1, filter: {datetime_geq: $start, datetime_lt: $end}) {
      sum { totalNeurons }
    }
  } }
}`;
export interface AnalyticsEnv {
  CF_ACCOUNT_ID?: string;
  CF_ANALYTICS_TOKEN?: string;
}
export interface AccountUsage {
  status: "available" | "not_configured" | "unavailable";
  neurons: number | null;
  queriedAt: string | null;
  errorCode: string | null;
}
export function utcDay(now: Date) {
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  return {dayStart: start.toISOString(), dayEnd: new Date(start.getTime() + 86_400_000).toISOString()};
}
export function validNeurons(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
class AnalyticsError extends Error {}
export function parseAccountNeurons(value: unknown): number {
  const data = value as { errors?: unknown[]; data?: { viewer?: { accounts?: Array<{aiInferenceAdaptiveGroups?: Array<{sum?: {totalNeurons?: unknown}}>}> } } };
  if (!data || (data.errors && (!Array.isArray(data.errors) || data.errors.length))) throw new AnalyticsError("analytics_rejected");
  const accounts = data.data?.viewer?.accounts;
  if (!Array.isArray(accounts) || accounts.length !== 1) throw new AnalyticsError("analytics_invalid_response");
  const groups = accounts[0]?.aiInferenceAdaptiveGroups;
  if (!Array.isArray(groups) || groups.length > 1) throw new AnalyticsError("analytics_invalid_response");
  if (groups.length === 0) return 0; // Valid empty dataset, distinct from missing access/data.
  const neurons = groups[0]?.sum?.totalNeurons;
  if (!validNeurons(neurons)) throw new AnalyticsError("analytics_invalid_response");
  return neurons;
}

// One cache per personal Agent, never shared across accounts or credential rotations.
export class UsageAnalytics {
  private cache?: {day: string; expires: number; value: AccountUsage};
  private inFlight?: {day: string; promise: Promise<AccountUsage>};
  // Workers global fetch requires its global receiver. Keeping it as an unbound
  // property and calling this.request() throws Illegal invocation before any HTTP.
  constructor(private env: AnalyticsEnv, private request: typeof fetch = fetch.bind(globalThis)) {}
  async today(now = new Date()): Promise<AccountUsage> {
    if (!this.env.CF_ACCOUNT_ID || !this.env.CF_ANALYTICS_TOKEN) {
      return {status: "not_configured", neurons: null, queriedAt: null, errorCode: "analytics_not_configured"};
    }
    const day = utcDay(now).dayStart;
    if (this.cache?.day === day && this.cache.expires > now.getTime()) return this.cache.value;
    if (this.inFlight?.day === day) return this.inFlight.promise;
    const promise = this.query(now).then(value => {
      this.cache = {day, expires: now.getTime() + (value.status === "available" ? 60_000 : 15_000), value};
      return value;
    }).finally(() => { if (this.inFlight?.promise === promise) this.inFlight = undefined; });
    this.inFlight = {day, promise};
    return promise;
  }
  private async query(now: Date): Promise<AccountUsage> {
    const {dayStart} = utcDay(now);
    let phase = "configuration";
    let httpStatus: number | undefined;
    const started = Date.now();
    try {
      if (!/^[a-f0-9]{32}$/i.test(this.env.CF_ACCOUNT_ID!)) throw new AnalyticsError("analytics_configuration_invalid");
      phase = "fetch";
      const response = await this.request("https://api.cloudflare.com/client/v4/graphql", {
        // Workers supports follow/manual only. Never follow a redirect with this credential.
        method: "POST", redirect: "manual", signal: AbortSignal.timeout(8_000),
        headers: {"Content-Type": "application/json", Authorization: `Bearer ${this.env.CF_ANALYTICS_TOKEN}`},
        body: JSON.stringify({query: USAGE_QUERY, variables: {account: this.env.CF_ACCOUNT_ID, start: dayStart, end: now.toISOString()}}),
      });
      httpStatus = response.status;
      if (!response.ok) {
        await response.body?.cancel();
        throw new AnalyticsError(response.status === 429 ? "analytics_rate_limited" : `analytics_http_${response.status}`);
      }
      phase = "decode";
      const body = await response.json();
      phase = "graphql";
      return {status: "available", neurons: parseAccountNeurons(body), queriedAt: now.toISOString(), errorCode: null};
    } catch (error) {
      const name = error instanceof Error ? error.name : "UnknownError";
      const code = error instanceof AnalyticsError ? error.message
        : name === "TimeoutError" || name === "AbortError" ? "analytics_timeout"
        : phase === "decode" ? "analytics_invalid_json" : "analytics_fetch_failed";
      // No headers, query variables, stack traces or upstream response bodies.
      // Fetch/runtime messages help diagnose e.g. Illegal invocation; redact secrets
      // and identifiers before truncating, including encoded representations.
      const redact = (value: string) => {
        for (const secret of [this.env.CF_ANALYTICS_TOKEN, this.env.CF_ACCOUNT_ID]) {
          if (secret) for (const variant of [secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1,-1)]) {
            value = value.split(variant).join("[redacted]");
          }
        }
        return value.replace(/Bearer\s+[^\s"']+/gi, "Bearer [redacted]").replace(/[\r\n\t]/g," ").slice(0,500);
      };
      console.warn(JSON.stringify({event:"analytics.error",code,phase,httpStatus,durationMs:Date.now()-started,
        errorType:redact(name),message:redact(error instanceof Error ? error.message : "Non-Error exception")}));
      return {status: "unavailable", neurons: null, queriedAt: null,
        errorCode: code};
    }
  }
}
