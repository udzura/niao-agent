# Verification — 2026-10-27 (JST)

## Results

| Check | Result |
| --- | --- |
| TypeScript (`npm run typecheck`) | Pass |
| Workers runtime (`npm test`) | 11 tests pass, 2 files |
| Swift XCTest (`swift test --package-path apps/macos`) | 4 tests pass |
| Worker bundle (`npm run build:worker`) | Pass; Wrangler dry-run, no production upload |
| Native app (`npm run build:macos`) | Pass; arm64 + x86_64 Debug, ad-hoc signing |
| Dependencies (`npm audit`) | 0 vulnerabilities reported |
| Launch built `Niao.app` | macOS `open` command succeeded |
| Native URLSession → local Worker → real GLM | Pass; 9 partial snapshots, 2 committed messages |
| Native WebSocket disconnect/reconnect | Pass; same committed messages recovered |
| Duplicate completed submission | Pass; same IDs/content, no extra persisted rows |
| Stop/restart Wrangler, then replay same request ID | Pass; history 2 → 2, no new model stream |
| Production deployment | Not performed |

The live request used `@cf/zai-org/glm-4.7-flash` through the real remote `AI` binding, not a mocked provider. Observed provider duration was approximately 1.24 seconds; reported usage was 40 prompt tokens, 10 completion tokens, and 0.584 Neurons. These numbers describe one test, not a performance guarantee. Neither credential nor conversation body was printed by the smoke check.

The live test used the same `Models.swift` and `Backend.swift` files as the app, including `URLSessionWebSocketTask`, HTTP Authorization headers and the HTTP sync endpoint. A new native smoke process after stopping/restarting Wrangler recovered the persisted messages and replayed the existing result with zero partial frames. The local SQLite database retains this small test conversation.

## What automated tests establish

The Workers tests run actual `NiaoAgent`, SDK routing, WebSocket transport, and SQLite inside workerd. The model factory is explicitly replaced only inside tests to exercise success, partial failure, rate-limit handling, and overlapping submissions deterministically. The production code has no test-model environment switch or fallback.

Coverage includes unauthenticated HTTP and upgrades, forbidden agent identities, method/cursor validation, split UTF-8/CRLF provider frames, truncated/malformed SSE, safe usage extraction, bounded context and historical retries, in-flight duplicates and ID conflicts, completed duplicates, retry after failure, HTTP pagination, actual Durable Object eviction and storage reconstruction, and interrupted-turn recovery.

Swift tests cover HTTPS/loopback credential destination policy, history/WebSocket duplicate merging and ordering, transient frame decoding, and failed-turn/cursor decoding.

## Remaining manual verification / limitations

- Computer Use was not authorized to inspect or operate Niao's GUI in this environment. Main-window rendering, menu-item activation/focus, Keychain dialogs, and interactive sleep/wake behavior need a human smoke pass. The application builds and its launch command succeeded; that is not a claim of completed GUI automation.
- The app's `ChatStore` lifecycle is implemented but not exercised by the transport-only live smoke executable. Physical sleep/wake and OS Keychain round trips were not automatically tested.
- No production Worker was deployed, so hosted WSS, production cold starts and hibernation have not been observed live. Local workerd eviction and actual local-process restart were tested.
- Native app distribution signing and notarization are not included. Local builds use ad-hoc signing, which may trigger Keychain permission prompts after rebuilds.
- Streaming text does not survive isolate termination; the saved user row becomes retryable. Active snapshots recover ordinary socket reconnects. There is no automatic paid model replay after a crash.
- A provider may report quota exhaustion without a numeric status; such an error becomes safe `ai_unavailable` rather than exposing a raw provider body.
- Conversation retrieval is paginated, but the macOS view eventually loads all persisted history. There is no retention/delete UI or semantic memory in Phase 1.

## Manual checklist

1. Start Worker with `npm run dev`, build and launch Niao, then enter the local URL/token in Settings.
2. Send a message and observe progressive text, then a final row.
3. Close the main window; open it using the menu-bar item; verify it focuses the existing window.
4. Quit and relaunch Niao; confirm the history returns and the token is read from Keychain.
5. Interrupt the network or sleep/wake the Mac; verify reconnect and history reconciliation.
6. Stop and restart Worker with the same `.wrangler/state`; verify the app recovers.
7. Try an invalid token; check that the error remains visible and automatic retry stops.

Wrangler and Xcode initially encountered this execution environment's filesystem/macro sandbox restrictions. Their final checks were run with approved normal host permissions. One harmless Xcode warning states AppIntents metadata extraction was skipped because no AppIntents dependency exists; SDK dependency source-map warnings also do not affect the test results.

## Icon and daily usage follow-up — 2026-10-28

- Backend: 19 tests across 3 files pass, including Analytics error/zero distinction, caching, UTC rollover, authentication, duplicate accounting and eviction persistence.
- Swift: 5 tests pass, including millisecond ISO 8601 timestamps and account/local usage labels. The initial date parsing failure was fixed before the final successful run.
- macOS app with AppIcon asset catalog and usage UI: build succeeded.
- Worker dry-run and TypeScript: succeeded; no production deployment performed by this implementation session.
- Cloudflare's live introspection confirmed `AccountAiInferenceAdaptiveGroupsSum.totalNeurons`; an authenticated aggregate query returned an account-wide daily value during investigation. This used existing local Wrangler authentication for read-only investigation, not a deployed Analytics secret.
- Dedicated server-side Analytics credentials still need user configuration as described in [usage.md](usage.md). No credentials were copied into source or embedded in the native app.
- User reported the added functionality working. Automated GUI interaction remains unverified.
