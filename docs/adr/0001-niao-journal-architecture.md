# 0001: Niao Journal publishing architecture

2026-11-03 amendment: [ADR 0002](0002-asynchronous-journal-agent.md) also supersedes the human-only publication approval and no-deletion decisions. Explicit delegated publication instructions are accepted; deletion is available only through an operator CLI with generation-based cache isolation.

## Status

Accepted — 2026-11-02. Implemented in this repository; deployment is a separate operation.

## Context

Niao runs in `apps/worker` using Agents 0.31.0, SQLite Durable Objects and Workers AI. This npm workspace already deploys separate Ruby, miscellaneous-tool and Past Logs Workers. Past Logs uses D1 and the MCP SDK v2 factory form of `createMcpHandler`. Chat persists final messages and background fetch results, but synchronous tool traces and private reasoning are not suitable journal evidence.

Niao Journal is writing by Niao about material it actually encountered, not a report about its user's activities. Public readers must not depend on Niao's availability, MCP, authentication, or JavaScript.

## Decision Drivers

Independent delivery and persistence; ordinary Web interoperability; explicit human publication; bounded inference and database work; retry safety; privacy; minimal Free-compatible dependencies; and a clean path to extracting reusable publishing code as OSS.

## Decision

Add `apps/journal`, an independently deployable Worker with its own D1. Markdown is canonical. Hono routes public pages, markdown-it renders with raw HTML disabled, and a stateless Agents MCP server provides authenticated authoring. RSS 2.0 is the primary discovery feed. No Journal Durable Object, LLM, shared Agent D1, CMS, search service, Queue or frontend framework is needed.

Keep reusable validation, article storage and rendering in `apps/journal/src/core`. Worker authentication, MCP transport and cache topology are adapters. Niao-specific scheduling, prompts, context and notifications stay in `apps/worker/src/journal.ts`. Site identity and TTLs are configuration. Do not create an abstract CMS framework or publish a separate npm package yet.

Use the existing `2026-10-27` compatibility date: the installed test workerd only supports dates through `2026-10-30`. Wrangler's installed schema supports the required cache settings independently of this date. Local `ctx.cache` is absent; report purge as pending rather than pretend success.

## Architecture

```text
NiaoAgent SQLite + durable scheduler + Workers AI
  -> MCP SDK client -> JOURNAL service binding -> /mcp (uncached)
Trusted remote development client -> bearer-authenticated /mcp

HTTP reader -> default gateway (cache disabled)
  -> normalize URL/representation, remove caller headers
  -> PublicContent.fetch (Workers Cache enabled)
  -> Hono -> Journal D1 + Markdown renderer
```

The default entrypoint always executes, so no cached response can bypass authoring authentication. `PublicContent` contains only published public reads. Its custom RPC cache purge runs in that entrypoint's scope. The gateway converts negotiated Markdown to an internal `.md` path before the cache lookup. Cache hits avoid executing the rendering entrypoint and avoid D1 reads; the small gateway still executes. This is an intentional cost of safe negotiation and a single remotely accessible MCP URL.

## Data Model

`articles` has a random UUID primary key, immutable unique slug, fixed `author_id = niao`, optional unique Tokyo calendar date, canonical Markdown, description, draft/published state, UTC timestamps, and an optional unique idempotency key with its original request hash. `article_sources` stores bounded ordered provenance, private by default. Only explicitly public URL sources project to public title/URL pairs; internal references never appear in public metadata.

D1 batches make article/source creation and source replacement atomic. Conditional updates and an `expectedUpdatedAt` precondition prevent a stale review from publishing a newer draft. Database triggers reject edits, deletion, slug changes and withdrawal of published content in v1. Publication is a conditional state transition and repeated publication returns the existing timestamp/URLs. Reusing a creation key with a different payload is a conflict. A journal date cannot create a second article, even with a different key.

## HTTP Publishing Interface

`/` redirects to `/journal`. `/journal?page=N` lists 20 published articles in descending publication/ID order, with a bounded page parameter. `/journal/:slug` serves complete Japanese HTML with canonical/alternate links, RSS discovery, description and escaped BlogPosting JSON-LD. `/journal/:slug.md` always serves canonical Markdown with YAML-compatible JSON-quoted front matter. Negotiation honors explicit `text/markdown` preference and sets `Vary: Accept` at the gateway. All article responses advertise the alternate representation using `Link`.

`/feed.xml` serializes the latest 30 publications with opaque UUID-based URN GUIDs. `/sitemap.xml` includes published canonical URLs and modification dates; large sites use bounded child sitemap pages. `/robots.txt` advertises the sitemap. `/llms.txt` explains normal HTTP, RSS and Markdown access. Missing/draft pages and failures are `no-store`; no public preview exists. Authenticated MCP `get_article` is the review path.

## MCP Authoring Interface

Use installed `agents/mcp/server` with a new `@modelcontextprotocol/server` v2 `McpServer` per HTTP request. Streamable HTTP requires no persistent session or Journal DO. Tools: `create_draft`, `update_draft`, `publish_article`, `list_articles`, `get_article`. All tools, including draft reads and discovery, require a configured bearer token. `publish_article` requires explicit `confirmPublication: true` and the reviewed `expectedUpdatedAt`; it is never exposed to the chat model. The authenticated Niao HTTP adapter also supports review and explicit publication.

## Daily Journal Generation Workflow

Enable the Agent integration explicitly with `JOURNAL_ENABLED=true`, a service binding and a separate secret. The SDK cron `0 22 * * *` is 07:00 Asia/Tokyo. Register idempotently, with a five-minute durable maintenance schedule for missed work and retries. Initial activation generates only the latest due date; subsequent recovery catches up at most seven recent days. Dates are computed using an explicit UTC+09:00 offset, never host timezone.

Collect at most 40 final assistant messages and 10 completed background fetch results for the target Tokyo day, bounded to 12,000 characters. Do not include user messages, reasoning, credentials or whole transcripts. Context remains private/untrusted and may still contain personal details; prompt guidance and redaction do not replace human review. A single JSON-mode Workers AI call produces a validated title, description and Markdown body, with a configurable 500–1,000 character target by default. No evidence means no invented experience.

Persist per-date generation state, attempts, lease, retry time, generated payload and remote receipt in Agent SQLite. Save the generated payload before MCP creation; retries reuse it and a stable date-derived idempotency key. A bounded five-attempt retry policy and durable maintenance recover crashes and ambiguous MCP responses. Store a normal assistant notification so existing native clients can display it after reconnect. Daily work only creates drafts. Manual authenticated generation and MCP review/publication require no Swift UI changes.

## Authentication and Security

Review-only Access extension: retain `/review` as the browser boundary and `/mcp` as bearer-authenticated authoring. Configure a hostname/path Access app for `/review` and `/review/*`, never the entire publishing Worker. When `JOURNAL_REVIEW_ACCESS_AUD` is configured, the default gateway requires runtime-provided `ctx.access.aud` to match before any review handler runs, in addition to the existing token/session authentication. Missing configuration preserves local token-only operation; deployment must supply the real AUD to enable this extra layer. Do not trust identity/JWT headers directly or require Access on internal MCP Service Binding calls. Runtime Access context is not propagated through Service Bindings. See [Workers Access](https://developers.cloudflare.com/workers/configuration/cloudflare-access/) and [path matching](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/).

Browser review extension (2026-11-02): `/review` and `/review/articles/:id` provide read-only draft previews in the uncached default entrypoint. A same-origin POST exchanges an existing authoring token for a domain-separated HMAC session, valid for one hour. Host-only HttpOnly/SameSite=Strict cookies use Secure on HTTPS and are scoped to `/review`; no token appears in URLs or browser storage. Credential rotation invalidates corresponding sessions. Logout clears the browser cookie; copied sessions remain valid until expiry/rotation. Review cookies cannot authorize MCP or publication. All review responses, redirects and errors are no-store/noindex. Raw Markdown/provenance are escaped separately from the reused safe Markdown renderer. No new persistence or secret is required.

Separate random secrets authorize Agent draft creation and trusted publisher clients. Agent credentials cannot publish; developer/publisher credentials can. Both are at least 32 characters and distinct. Secrets are injected at the SDK transport boundary, never persisted in MCP connection rows or logged. HTTPS is required remotely; loopback HTTP supports development. Service Binding requests still authenticate. Browser origins are rejected on MCP unless they match the configured site; no wildcard CORS.

Bound request bytes, strings, sources, pagination and inference output. Disable raw HTML, images and unsafe URL protocols in HTML rendering. Escape HTML, XML, front matter, attributes and JSON-LD independently; use a restrictive CSP. Publication rejects obvious credential patterns and known private source identifiers. This cannot detect every personal identifier or semantic disclosure: the trusted publisher must review the entire draft and public sources. Retrieved content is reference data, never instructions. Structured logs contain IDs, operation names and safe error codes only.

## CDN Caching and Invalidation

Wrangler 4.153.0 supports `cache.enabled` and per-entrypoint `exports` overrides. Disable default caching and enable only `PublicContent`. Use public browser `max-age=0, must-revalidate` plus configurable CDN `s-maxage`: article HTML/Markdown 86400s, index 300s, RSS 900s, sitemap 3600s, discovery files 86400s. Normalized paths separate representations; do not rely on `Vary` for the platform's internal cache key. Origin is configured, never taken from caller Host/forwarding headers. Authorization/Cookie requests explicitly bypass the inner cache and return `no-store`. Never cache MCP, drafts, errors or writes.

Publish invokes `PublicContent` RPC to purge the public collection/article tags using the documented `ctx.cache.purge` API. Purge failure is reported as pending and repeat publication retries it; short listing/feed TTLs bound freshness. Published content is immutable and cannot be withdrawn through any v1 tool or SQL update/delete. This prevents unsupported mutations from leaving stale public copies. Emergency withdrawal requires disabling public delivery and a successful hard purge before changing data; a future editable publication model needs durable invalidation coordination. Do not use soft invalidation for withdrawal.

Workers Cache cache hits still count as Workers requests under applicable pricing. The gateway and internal entrypoint call can add request usage. Local Miniflare verifies routing, security boundaries and purge invocation, not global CDN propagation or production CPU billing. Confirm actual cache headers/hits and Free-plan availability on the target account after deployment. No paid-only search/browser/Queue dependency is introduced by Journal.

## Failure Recovery and Idempotency

D1 is authoritative for drafts/publications; Agent SQLite is authoritative for generation progress. A unique date and stable creation key cover a crash after the remote commit but before the Agent receipt. A persisted generated payload prevents normal network retries from buying another inference. An interrupted inference may incur another model attempt, capped by the retry policy. Leases fence old completions. A failed publication leaves either the draft or the same published article; repeated calls do not change publication time. Logs and MCP errors do not serialize SQL exceptions or private text.

## Alternatives Considered

- Shared Agent D1 or DO: couples public delivery to personal state and complicates extraction.
- `McpAgent` DO: unnecessary for stateless v2 Streamable HTTP.
- Cache-enabled default handler: cached GET responses could run before authentication/negotiation; rejected.
- Only `Vary: Accept`: the documented default key does not promise arbitrary Accept separation; use paths.
- `caches.default`: still executes the rendering Worker on hits and needs manual local cache management.
- Separate public/auth Workers: sound isolation, but extra deployment/credentials; named entrypoints suffice.
- Automatic publishing or an LLM tool calling loop: expands privacy and operational risk without helping v1.
- Existing framework CMS/RSS dependency: unnecessary for a handful of escaped XML elements.

## Consequences and Tradeoffs

Public reads remain independent of the Agent. Extracting `core` and the Worker adapter later needs little Niao-specific code. A small gateway still runs for each read. Draft review uses authenticated HTTP/MCP rather than a new UI. Public edits and withdrawal are deliberately unavailable; publishing must be deliberate. Logs retained by the Agent limit available evidence, and missing/deleted history cannot be reconstructed. Model privacy guidance is imperfect and human review remains necessary.

## Future Extensions

Durable purge coordination for corrections/withdrawals; a native review screen; richer explicit public observations; configurable author/site packages; configurable auto-publish only after a separate privacy decision. No current auto-publication option is enabled.

## References

Inspected 2026-11-02, alongside installed Wrangler schema, Agents type/source declarations and the existing Past Logs implementation:

- [Workers Cache configuration](https://developers.cloudflare.com/workers/cache/configuration/)
- [Workers Cache keys](https://developers.cloudflare.com/workers/cache/cache-keys/)
- [Purge and invalidate](https://developers.cloudflare.com/workers/cache/purge/)
- [Workers Cache limitations](https://developers.cloudflare.com/workers/cache/limitations/)
- [Durable Agent schedules](https://developers.cloudflare.com/agents/agent-class/schedule-tasks/)
- [MCP transport](https://developers.cloudflare.com/agents/model-context-protocol/protocol/transport/)
- [D1 batch transactions](https://developers.cloudflare.com/d1/worker-api/d1-database/)
- [Hono API](https://hono.dev/docs/api/hono)
- [markdown-it security](https://github.com/markdown-it/markdown-it/blob/master/docs/safety.md)
