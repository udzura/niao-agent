# 0002: Queue-driven journal-writing agent

Status: Accepted — 2026-11-03. Supersedes the generation/integration portions of ADR 0001; Journal publishing and review remain independent.

## Context and decision

Journal has been deployed. A structured one-shot daily generation inside the personal Agent cannot investigate releases, read room history on demand, or retain a writing conversation. Add `apps/journal-agent` as an independent Worker and SQLite-backed Agents SDK Durable Object, with no public HTTP interface. The personal Agent exposes only `ask_journal_agent` for journal work. It owns prompt admission, source-room epochs, durable dispatch outbox and result notification. Remove its direct Journal binding/client, old publication proxy endpoints and automatic 07:00 generation. Existing tables are retained, not destructively migrated.

Use two Cloudflare Queues: prompts and results, each with its own DLQ. Messages contain stable IDs; private prompts and results are claimed/read from their owning DO. Queue events await the work and acknowledgement. No unawaited inference promise is used as job ownership. Per-session serialization and idempotent result delivery handle duplicates and reordered Queue messages. A source-room epoch prevents deleted-history notifications and rejects further tool access from obsolete jobs.

## Session and model

A report session belongs to a source room/epoch. Its expiry is fixed at initial dispatch plus 12 hours, never extended by follow-ups. Explicit references to expired or foreign sessions fail; implicit new requests create a new session after expiry. Persist final assistant messages and completed tool continuations, not reasoning. Expiry clears private context/tool records; surviving Queue receipts become a generic expiry result.

Fix Workers AI to Qwen 3.8 27B with thinking enabled and xhigh reasoning, independently of the main chat's settings. Bound each turn to six minutes, 16 inference rounds and 24 tools; expiry is also checked before tool side effects and checkpoints. Bounded context exhaustion asks the user to start a new session instead of silently dropping context. Persist the first create intent and an operation-specific idempotency key before MCP creation; a job can create one draft and then update it. Publication requires a human approval of the presented revision.

## Tools and storage boundaries

Only this dedicated Worker receives the Journal authoring token and discovers Journal MCP tools. Remote reads/writes use the supported MCP SDK v2 transport; the main model sees none of these tools. The browser review and external trusted MCP clients continue to work. The draft authoring token cannot publish. LLM publication tool calls remain rejected. For an actual user approval following a delivered draft preview, the main Agent persists an article/revision-bound approval in that room/epoch/session. A dedicated, non-LLM publication branch uses a separate publisher token only after rechecking this approval; MCP publication atomically checks the reviewed updatedAt. Model-supplied prompts cannot mint approvals. Private preview snapshots are expired with the writing session.

Release access directly uses the official GitHub latest-release REST endpoint, `https://api.github.com/repos/udzura/niao-agent/releases/latest`. Bound bytes and network time, reject redirects, and treat all returned writing as reference data. Fetch failures return an error without trying other endpoints.

The chat source is existing personal-Agent DO SQLite, not D1. The user explicitly approved using this existing source rather than creating a D1 replica. A narrow read-only RPC formats today's Tokyo-date messages by room/time, includes archived rooms and excludes deleted rooms/reasoning. Pagination covers both message lists and long message bodies. The writing agent receives no direct source-database binding.

## Consequences and operations

The separate Worker isolates credentials and model/tool behavior, but requires two DO bindings across Workers, two Queues and two DLQs. The existing personal DO must exist when the writing Worker is first deployed; update the personal Worker once the JournalAgent namespace exists. Move/delete old Journal secrets on the personal Worker during the deployment migration. No production deployment, Queue creation or real article publication is part of this source change. Local tests share the classes in one test Worker to exercise real RPC/storage and MCP while mocking inference; deployment topology and real xhigh inference remain production verification steps.

See [operations](../journal-agent.md), [Qwen API](https://developers.cloudflare.com/workers-ai/models/qwen3.8-27b/), [Queues limits](https://developers.cloudflare.com/queues/platform/limits/).
