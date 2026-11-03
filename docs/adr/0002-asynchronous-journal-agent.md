# 0002: Queue-driven journal-writing agent

Status: Accepted — 2026-11-03. Supersedes the generation/integration portions of ADR 0001; Journal publishing and review remain independent.

## Context and decision

Journal has been deployed. A structured one-shot daily generation inside the personal Agent cannot investigate releases, read room history on demand, or retain a writing conversation. Add `apps/journal-agent` as an independent Worker and SQLite-backed Agents SDK Durable Object, with no public HTTP interface. The personal Agent exposes only `ask_journal_agent` for journal work. It owns prompt admission, source-room epochs, durable dispatch outbox and result notification. Remove its direct Journal binding/client, old publication proxy endpoints and automatic 07:00 generation. Existing tables are retained, not destructively migrated.

Use two Cloudflare Queues: prompts and results, each with its own DLQ. Messages contain stable IDs; private prompts and results are claimed/read from their owning DO. Queue events await the work and acknowledgement. No unawaited inference promise is used as job ownership. Per-session serialization and idempotent result delivery handle duplicates and reordered Queue messages. A source-room epoch prevents deleted-history notifications and rejects further tool access from obsolete jobs.

## Session and model

A report session belongs to a source room/epoch. Its expiry is fixed at initial dispatch plus 12 hours, never extended by follow-ups. Explicit references to expired or foreign sessions fail; implicit new requests create a new session after expiry. Persist final assistant messages and completed tool continuations, not reasoning. Expiry clears private context/tool records; surviving Queue receipts become a generic expiry result.

Fix Workers AI to Gemma 4 26B A4B with thinking disabled and 4096 completion tokens per inference, independently of the main chat's settings. Bound each turn to six minutes, six inference rounds and 24 tools; expiry is also checked before tool side effects and checkpoints. Bounded context exhaustion asks the user to start a new session instead of silently dropping context. Persist the first create intent and an operation-specific idempotency key before MCP creation; a job can create one draft and then update it. Publication requires an explicit publication instruction in the current user message or delegated prompt; an earlier preview is optional.

## Tools and storage boundaries

Only this dedicated Worker receives the Journal authoring token and discovers Journal MCP tools. Remote reads/writes use the supported MCP SDK v2 transport; the main model sees none of these tools. The browser review and external trusted MCP clients continue to work. The draft authoring token cannot publish. The personal Agent persists a job-scoped publication capability when the actual user message or delegated prompt explicitly requests publishing, including Japanese prose containing `公開して下さい` or `公開してください`. An actual user's refusal overrides a delegated request. Quoted reference data, earlier conversation instructions and tool outputs do not grant this capability. A prior preview is no longer mandatory. The writing Agent permits its publication tool only with this capability, uses the separate publisher credential, and also performs a deterministic publication step after drafting if the model omits the call. It reads the target before publishing, retains revision preconditions, verifies the published content and returns actual URLs. A successful receipt survives Queue retries. Without an explicit instruction it only saves drafts. Private previews expire with the writing session.

Human operators can permanently delete drafts or published articles using a local Wrangler-backed CLI, authenticated by their own Cloudflare credentials. No deletion HTTP endpoint or MCP tool is registered. A D1 deletion receipt trigger atomically checks the expected revision, deletes article/sources and advances a public generation. The gateway reads this generation from the primary on every public request and includes it in the internal cache key. This adds one small D1 read even on cache hits, but prevents stale articles, feeds and indexes from being served following deletion without depending on a network purge. Published content remains immutable; the deletion receipt is the sole exception to the published-row DELETE guard.

Release access directly uses the official GitHub latest-release REST endpoint, `https://api.github.com/repos/udzura/niao-agent/releases/latest`. Bound bytes and network time, reject redirects, and treat all returned writing as reference data. Fetch failures return an error without trying other endpoints.

The chat source is existing personal-Agent DO SQLite, not D1. The user explicitly approved using this existing source rather than creating a D1 replica. A narrow read-only RPC formats today's Tokyo-date messages by room/time, includes archived rooms and excludes deleted rooms/reasoning. Pagination covers both message lists and long message bodies. The writing agent receives no direct source-database binding.

## Usage accounting

Record each inference attempt in the writing DO before the Workers AI call. Store only IDs, model, timestamps, state, numeric usage and the pricing snapshot. Cumulative stream samples replace previous values within an attempt; subsequent inference rounds create new attempts. Prefer returned neurons when supplied; otherwise estimate using the official input/output token rates, clearly marked as estimated. Interrupted/missing usage remains incomplete rather than becoming zero. Keep usage records beyond conversation expiry and source-chat deletion. A persistent six-attempt budget per job also spans eviction/retry, while duplicate completed deliveries do not infer again.

Expose authenticated GET `/agents/niao-agent/personal/journal-usage` through the existing main Worker bearer authentication and a content-free index of known report sessions. Optional jobId or reportSessionId selects detailed, paginated usage. Arbitrary unknown session IDs cannot instantiate writing DOs. Reading metrics never starts inference. Legacy jobs are explicitly untracked; no retroactive billing reconstruction is claimed. No dedicated public route or additional secret is required.

## Consequences and operations

The separate Worker isolates credentials and model/tool behavior, but requires two DO bindings across Workers, two Queues and two DLQs. The existing personal DO must exist when the writing Worker is first deployed; update the personal Worker once the JournalAgent namespace exists. Move/delete old Journal secrets on the personal Worker during the deployment migration. No production deployment, Queue creation or real article publication is part of this source change. Local tests share the classes in one test Worker to exercise real RPC/storage and MCP while mocking inference; deployment topology and real Gemma inference remain production verification steps.

See [operations](../journal-agent.md), [Gemma API](https://developers.cloudflare.com/workers-ai/models/gemma-4-26b-a4b-it/), [Queues limits](https://developers.cloudflare.com/queues/platform/limits/).
