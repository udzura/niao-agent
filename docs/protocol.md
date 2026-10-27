# Niao protocol v1

Base URL is an HTTPS origin, or HTTP loopback in development. All requests require `Authorization: Bearer <NIAO_TOKEN>`, including the WebSocket HTTP upgrade. No credentials in URL parameters. Only one agent instance exists at the public API boundary.

## HTTP

- `GET /health` → `{ "ok": true, "protocol": 1 }`
- `GET /agents/niao-agent/personal/history?after=0`

```json
{
  "v": 1,
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
{"v":1,"type":"send","requestId":"d6f9b7a0-a8c9-4fae-8ea5-a677710ed3be","content":"Hello"}
```

Use a UUID and preserve it for retries. Content is trimmed and must contain 1–8,000 UTF-16 code units. No client-supplied role, timestamp, cursor, or full history is accepted. Application frames use `v:1`; unexpected SDK housekeeping frames may be ignored.

| Server type | Fields | Meaning |
| --- | --- | --- |
| `ready` | `bootId`, `active` | Connected; perform HTTP synchronization. `active` is a transient snapshot or null. |
| `accepted` | `requestId`, `message` | User row is durable; do not create another local duplicate. |
| `partial` | `requestId`, `text` | Replace transient assistant text with this **cumulative** snapshot. Not a delta or committed row. |
| `committed` | `requestId`, `messages` | Durable user/assistant pair. Merge by ID and clear transient display. |
| `error` | optional `requestId`, `code` | Request rejected or generation failed. Discard transient text; synchronize history. |

All server frames include `v:1`. Accepted/partial/committed/generation-error events broadcast to connected clients. An individual retry of an existing completed turn returns its pair only to the requester. Validation and busy errors also go only to the requester. Connections use the base SDK's hibernation support; no application RPC is exposed.

Error codes: `invalid_message`, `id_conflict`, `busy`, `interrupted`, `ai_rate_limited`, `ai_timeout`, `ai_unavailable`, `invalid_ai_response`, `incomplete_ai_stream`, `empty_ai_response`, `response_too_large`, `internal_error`. Some provider quota errors do not supply a numeric HTTP status and are safely classified as `ai_unavailable`; the raw provider error is intentionally withheld.

A failed turn can be retried with the same ID and identical trimmed content. A running duplicate cannot start another generation. Completed duplicates do not call the model. There is no cancel, delete, edit, or regeneration command in Phase 1. Partial stream replay is intentionally not durable: after a connection interruption, HTTP and `ready` provide the latest active snapshot or completed history; after an isolate crash the user explicitly retries an interrupted turn.
