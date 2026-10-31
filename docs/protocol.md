# Niao protocol v1

Base URL is an HTTPS origin, or HTTP loopback in development. All requests require `Authorization: Bearer <NIAO_TOKEN>`, including the WebSocket HTTP upgrade. No credentials in URL parameters. Only one agent instance exists at the public API boundary.

## HTTP

- `GET /health` → `{ "ok": true, "protocol": 1 }`
- `GET /agents/niao-agent/personal/history?after=0&epoch=0`

```json
{
  "v": 1,
  "epoch": 0,
  "settings": {"v":1,"modelId":"@cf/google/gemma-4-26b-a4b-it","thinkingMode":"off","thinkingPolicy":{"offThreshold":0.35,"onThreshold":0.65,"ambiguity":"on","timeoutMs":3000},"thinkingEnabled":false,"epoch":0,"models":[{"id":"@cf/google/gemma-4-26b-a4b-it","name":"Gemma 4 · 26B A4B","supportsThinking":true},{"id":"@cf/zai-org/glm-4.7-flash","name":"GLM 4.7 Flash","supportsThinking":false}]},
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
| `partial` | `requestId`, `text`, optional `thinking` | Replace transient assistant text/thinking with this **cumulative** snapshot. Not a delta or committed row. |
| `committed` | `requestId`, `messages` | Durable user/assistant pair. Merge by ID and clear transient display. |
| `message_added` | `requestId`, `message` | Persisted background assistant follow-up. Merge by ID; clear only the matching partial. No user submission/outbox is completed. |
| `notification_deferred` | `requestId` | Background summary will retry; clear only the matching partial. Ordinary turns/outbox are unchanged. |
| `tool_status` | `requestId`, `name`, `status` | Transient tool activity (`running` or `completed`); no code/output is sent to the UI. |
| `settings_updated` | `settings` | Persisted model selection changed. |
| `history_cleared` | `epoch` | Reset local conversation, cursor, transient output, and old outbox. |
| `error` | optional `requestId`, `code`, optional `details` | Request rejected or generation failed. Discard transient text; synchronize history. |

All server frames include `v:1` and the current `epoch`. Accepted/partial/committed/generation-error events broadcast to connected clients. An individual retry of an existing completed turn returns its pair only to the requester. Validation and busy errors also go only to the requester. Connections use the base SDK's hibernation support; no application RPC is exposed.

Error codes: `tool_limit`, `invalid_tool_call`, `invalid_message`, `id_conflict`, `busy`, `interrupted`, `ai_rate_limited`, `ai_timeout`, `ai_unavailable`, `invalid_ai_response`, `incomplete_ai_stream`, `empty_ai_response`, `response_too_large`, `internal_error`. Recognized quota/capacity failures use `ai_rate_limited` even when the binding omits HTTP status. Optional safe details distinguish these causes; the raw provider error is intentionally withheld.

A failed turn can be retried with the same ID and identical trimmed content. A running duplicate cannot start another generation. Completed duplicates do not call the model. There is no cancel, edit, or regeneration command. Whole-history deletion is available over HTTP. Partial stream replay is intentionally not durable: after a connection interruption, HTTP and `ready` provide the latest active snapshot or completed history; after an isolate crash the user explicitly retries an interrupted turn.

## Workers AI error details

Workers AI failures may include an additive `details` object in `error` and `notification_deferred` events:

```json
{
  "v": 1,
  "type": "error",
  "code": "ai_rate_limited",
  "details": {
    "provider": "cloudflare",
    "reason": "daily_quota_exceeded",
    "providerCode": 4006,
    "httpStatus": 429,
    "message": "The daily free allocation of 10,000 Workers AI Neurons has been exhausted. It resets at 00:00 UTC.",
    "retryAt": "2026-11-01T00:00:00.000Z"
  }
}
```

`providerCode` and `httpStatus` are present only when the provider supplies them in a recognized form. Binding errors often supply an internal code in their message without an HTTP status. `reason` is `daily_quota_exceeded`, `capacity_exceeded`, `rate_limited`, `paid_plan_required`, `access_denied`, `timeout`, or `unknown`. `retryAt` is the next UTC midnight for the daily-quota case; it is not a guarantee that a later request will succeed.

The provider's numeric code is preserved, while `message` is application-owned explanatory text. Raw exception strings, echoed input, arbitrary response fields, headers, credentials, and stacks are never returned or logged. Code 4006 has been observed for both daily quota and temporary capacity: classification uses the recognized quota/capacity wording, not 4006 alone. Unknown failures still expose bounded numeric diagnostics when available. See [Cloudflare's error catalog](https://developers.cloudflare.com/workers-ai/platform/errors/) and [the binding error implementation](https://github.com/cloudflare/workerd/blob/main/src/cloudflare/internal/ai-api.ts).

Failed ordinary turns persist the same object as optional `turns[].errorDetails` in HTTP history, so reconnect/hibernation retains the explanation beside the retry button. A retry clears the previous details, and an interrupted turn does not retain stale provider details. The SQL column is added in place without clearing history. Existing `code` values remain compatible; older clients can ignore `details`. Mac/iOS clients translate the reason to Japanese and display available HTTP/Cloudflare codes. Judge failures and background-summary failures log the same safe details. Background-summary retries retain their existing policy.

## Optional thinking output

`partial`, HTTP/`ready` `active` snapshots, and committed assistant message objects may include:

```json
{
  "thinking": [
    {"generation":0,"text":"Before tool execution\n  Indentation is preserved.","active":false},
    {"generation":1,"text":"Considering the result…","active":true}
  ]
}
```

`text` on partial/active and `content` on committed messages always contain only answer text. `thinking` is a cumulative array, not a sequence of deltas. `generation` is zero-based within one request/turn, increasing for each model invocation after a tool call (maximum 3). Segment text retains whitespace and has no channel delimiters; `active` indicates thinking in progress. Committed segments always have `active:false`. Blank completed segments are omitted; messages with no thinking need not include the field. Older clients can ignore this additive field, and newer clients accept older messages without it.

Thinking is saved separately only when the assistant turn successfully commits. History and completed-duplicate replies restore the same segments. Cleanup deletes thinking along with messages/turns. Failed/interrupted output is discarded, and thinking is never part of the normal model conversation context. Tool status/schema/results remain unchanged. See [normalization and limitations](architecture.md#gemma-thinking-output-2026-10-29).

## Usage snapshot

`GET /agents/niao-agent/personal/usage` uses the same Bearer authentication as history. It returns `v`, `dayStart`, `dayEnd` (UTC), `asOf`, `account` (`status`, nullable `neurons`, nullable `queriedAt`, nullable safe `errorCode`) and `local` (`neurons`, `attempts`, `unmeasuredAttempts`, `trackingSince`). `account.status` is `available`, `not_configured`, or `unavailable`. Only `available` identifies a valid account-wide total. Empty data with a valid account returns zero; inaccessible/malformed data does not. Responses are `no-store`; the Agent caches upstream Analytics results internally for up to 60 seconds. See [usage.md](usage.md).

`local` totals include judge attempts. Its additive `judge` object contains `neurons`, `attempts`, `unmeasuredAttempts`, `calculatedAttempts`, `totalDurationMs`, and `timedAttempts`. Judge neurons may use the official input-token conversion rate when not reported by the provider. `calculatedAttempts` identifies those entries. Durations are separate wall-clock waiting measurements, not neurons or CPU time. Never add the subset to `local.neurons` again, or add local values to `account.neurons`. Older servers may omit `judge`.

## Settings and cleanup

`GET /agents/niao-agent/personal/settings` returns `{v,modelId,thinkingMode,thinkingPolicy,thinkingEnabled,epoch,models:[{id,name,supportsThinking}]}`. `PUT` accepts `{modelId,thinkingMode?,thinkingPolicy?}`, validates and atomically saves all settings, broadcasts `settings_updated`, and returns the settings. Modes are `auto/on/off`; omitted fields preserve existing values, and policy fields merge with existing policy. Defaults are OFF, thresholds 0.35/0.65, ambiguity ON and timeout 3000ms. Require `0 <= offThreshold < onThreshold <= 1`, ambiguity `on/off`, and integer timeout 100–10000ms. Unsupported models return 400 `unsupported_model`; malformed JSON/invalid values return 400 `invalid_settings` without changing any setting.

The mode/policy is stored with the selected model (not per-model preferences) and only applied when that model advertises `supportsThinking:true` (currently Gemma 4). GLM skips judging/thinking and preserves the saved mode. A turn snapshots model/mode/policy and judges once in auto, including all tool continuations. Failed retries use current settings and a new judge attempt; completed replays invoke neither judge nor model. See [automatic thinking](automatic-thinking.md) for score boundaries, fallback and accounting.

Legacy `thinkingEnabled:true/false` updates remain accepted as manual `on/off`; sending it together with `thinkingMode` is invalid. The legacy response field is true only for manual ON. Existing boolean settings migrate to the corresponding manual mode without clearing history. Native clients accept older settings without a mode by falling back to the boolean, then OFF. Upgrade Worker and app together to use auto.

`DELETE /agents/niao-agent/personal/history` requires `If-Match: "<epoch>"`, using the numeric epoch from settings/history. Missing or malformed preconditions return 428 `precondition_required`, stale epochs return 409 `history_changed`, and active inference returns 409 `busy`. Success atomically deletes messages/turns and increments the epoch, then broadcasts `history_cleared` and returns `{v,epoch}`. Model selection, usage records, and the monotonically increasing SQLite sequence remain intact. Repeating an old DELETE cannot clear a newly started conversation.

Clients send the current epoch with each submission and HTTP history query. An epoch mismatch on history resets the server-side cursor to zero; the client must reset its cache before merging the new epoch. Ignore older-epoch HTTP responses and buffered socket events. Drop persisted outbox submissions belonging to an older epoch. Mismatching submissions are rejected as `history_changed` before deduplication or generation. Missing epochs are treated as zero for compatibility until the first cleanup; upgrade older clients before clearing history. See [API examples](chat-controls.md).
