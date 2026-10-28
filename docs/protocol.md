# Niao protocol v1

Base URL is an HTTPS origin, or HTTP loopback in development. All requests require `Authorization: Bearer <NIAO_TOKEN>`, including the WebSocket HTTP upgrade. No credentials in URL parameters. Only one agent instance exists at the public API boundary.

## HTTP

- `GET /health` → `{ "ok": true, "protocol": 1 }`
- `GET /agents/niao-agent/personal/history?after=0&epoch=0`

```json
{
  "v": 1,
  "epoch": 0,
  "settings": {"v":1,"modelId":"@cf/google/gemma-4-26b-a4b-it","epoch":0,"models":[{"id":"@cf/google/gemma-4-26b-a4b-it","name":"Gemma 4 · 26B A4B"},{"id":"@cf/zai-org/glm-4.7-flash","name":"GLM 4.7 Flash"}]},
  "messages": [{
    "seq": 1, "id": "UUID", "requestId": "UUID", "role": "user",
    "content": "Hello", "createdAt": "2026-10-27T00:00:00.000Z"
  }],
  "cursor": 1,
  "hasMore": false,
  "turns": [{ "requestId": "UUID", "status": "running", "errorCode": null }],
  "active": { "requestId": "UUID", "text": "Partial answer" }
}
```

`messages` are committed, ordered by increasing `seq`, maximum 100/page. Iterate until `hasMore=false`, using the returned cursor. `turns` contains all noncompleted turns, including retryable failures; `active` is null when idle. All application HTTP JSON responses use `Cache-Control: no-store`. Invalid cursors return 400, failed auth 401, unconfigured server 503, unknown routes 404, unsupported method 405.

## WebSocket

Connect to `/agents/niao-agent/personal`. Client sends text JSON:

```json
{"v":1,"type":"send","requestId":"d6f9b7a0-a8c9-4fae-8ea5-a677710ed3be","content":"Hello","epoch":0}
```

Use a UUID and preserve it for retries. Content is trimmed and must contain 1–8,000 UTF-16 code units. No client-supplied role, timestamp, cursor, or full history is accepted. Application frames use `v:1`; unexpected SDK housekeeping frames may be ignored.

| Server type | Fields | Meaning |
| --- | --- | --- |
| `ready` | `bootId`, `active` | Connected; perform HTTP synchronization. `active` is a transient snapshot or null. |
| `accepted` | `requestId`, `message` | User row is durable; do not create another local duplicate. |
| `partial` | `requestId`, `text` | Replace transient assistant text with this **cumulative** snapshot. Not a delta or committed row. |
| `committed` | `requestId`, `messages` | Durable user/assistant pair. Merge by ID and clear transient display. |
| `tool_status` | `requestId`, `name`, `status` | Transient tool activity (`running` or `completed`); no code/output is sent to the UI. |
| `settings_updated` | `settings` | Persisted model selection changed. |
| `history_cleared` | `epoch` | Reset local conversation, cursor, transient output, and old outbox. |
| `error` | optional `requestId`, `code` | Request rejected or generation failed. Discard transient text; synchronize history. |

All server frames include `v:1` and the current `epoch`. Accepted/partial/committed/generation-error events broadcast to connected clients. An individual retry of an existing completed turn returns its pair only to the requester. Validation and busy errors also go only to the requester. Connections use the base SDK's hibernation support; no application RPC is exposed.

Error codes: `tool_limit`, `invalid_tool_call`, `invalid_message`, `id_conflict`, `busy`, `interrupted`, `ai_rate_limited`, `ai_timeout`, `ai_unavailable`, `invalid_ai_response`, `incomplete_ai_stream`, `empty_ai_response`, `response_too_large`, `internal_error`. Some provider quota errors do not supply a numeric HTTP status and are safely classified as `ai_unavailable`; the raw provider error is intentionally withheld.

A failed turn can be retried with the same ID and identical trimmed content. A running duplicate cannot start another generation. Completed duplicates do not call the model. There is no cancel, edit, or regeneration command. Whole-history deletion is available over HTTP. Partial stream replay is intentionally not durable: after a connection interruption, HTTP and `ready` provide the latest active snapshot or completed history; after an isolate crash the user explicitly retries an interrupted turn.

## Usage snapshot

`GET /agents/niao-agent/personal/usage` uses the same Bearer authentication as history. It returns `v`, `dayStart`, `dayEnd` (UTC), `asOf`, `account` (`status`, nullable `neurons`, nullable `queriedAt`, nullable safe `errorCode`) and `local` (`neurons`, `attempts`, `unmeasuredAttempts`, `trackingSince`). `account.status` is `available`, `not_configured`, or `unavailable`. Only `available` identifies a valid account-wide total. Empty data with a valid account returns zero; inaccessible/malformed data does not. Responses are `no-store`; the Agent caches upstream Analytics results internally for up to 60 seconds. See [usage.md](usage.md).

## Settings and cleanup

`GET /agents/niao-agent/personal/settings` returns `{v,modelId,epoch,models:[{id,name}]}`. `PUT` on the same path accepts JSON `{modelId}` from the advertised list, persists it, broadcasts `settings_updated`, and returns the settings. Unsupported models return 400 `unsupported_model`; malformed JSON returns 400 `invalid_settings`. Each inference snapshots the model at its start; retries of a failed turn use the current model, while retries of completed turns still return the persisted response.

`DELETE /agents/niao-agent/personal/history` requires `If-Match: "<epoch>"`, using the numeric epoch from settings/history. Missing or malformed preconditions return 428 `precondition_required`, stale epochs return 409 `history_changed`, and active inference returns 409 `busy`. Success atomically deletes messages/turns and increments the epoch, then broadcasts `history_cleared` and returns `{v,epoch}`. Model selection, usage records, and the monotonically increasing SQLite sequence remain intact. Repeating an old DELETE cannot clear a newly started conversation.

Clients send the current epoch with each submission and HTTP history query. An epoch mismatch on history resets the server-side cursor to zero; the client must reset its cache before merging the new epoch. Ignore older-epoch HTTP responses and buffered socket events. Drop persisted outbox submissions belonging to an older epoch. Mismatching submissions are rejected as `history_changed` before deduplication or generation. Missing epochs are treated as zero for compatibility until the first cleanup; upgrade older clients before clearing history. See [API examples](chat-controls.md).
