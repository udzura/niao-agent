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
- Conversation retrieval is paginated, but the macOS view eventually loads all persisted history. There is a whole-history delete UI; automatic retention and semantic memory remain out of scope.

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

## Model selection and cleanup follow-up — 2026-10-28

- Backend: all 24 tests pass across 3 files. New coverage verifies authenticated mutations, unsupported models, persistent model selection after real Durable Object eviction, per-inference model snapshots, rejection of cleanup during generation, preservation of usage/settings, stale submission fencing, conditional DELETE retries, cursor recovery, and clean context after deletion. Inference in these tests uses explicit fixtures, not live paid Workers AI.
- Swift: all 7 tests pass, including epoch persistence/backward-compatible outbox decoding and settings event decoding.
- TypeScript typecheck, Worker deployment dry-run, macOS Xcode build, and git whitespace checks pass.
- Tests initially exposed undrained test HTTP response bodies blocking Durable Object eviction; consuming those responses fixed the test harness. Swift's generic function scope restriction was also resolved before successful builds.
- New settings/cleanup GUI interaction and model switching against live Workers AI were not automated. No production deployment or deletion of existing user conversation data was performed.
- Manual follow-up: update both Worker and app, change model in Settings and send a message, relaunch to verify selection, then use a disposable conversation to check the trash confirmation and empty history after reconnect. A second connected client should reflect both operations. Usage should remain unchanged by cleanup.

## PicoRuby tool follow-up — 2026-10-28 (historical Dynamic Worker implementation)

- Niao-owned build configuration and C extension built against the pinned PicoRuby/compiler/mruby/Prism revisions in `tools/ruby-sandbox/sources.json`; Emscripten 6.0.13. Source checkouts were copied into Niao before building, and no upstream sources were edited.
- All 39 backend tests pass. Twelve tests execute the real generated Wasm via the real Worker Loader: calculation, exact instruction-budget traps (including rescue/retry and ensure), recursion, memory and output limits, syntax errors, external capabilities, and fresh-instance state isolation. Additional adapter/Agent tests cover streamed function arguments, nullable provider fields, round limits, unknown tools and per-inference usage accounting.
- Swift's 7 tests pass, and the macOS application builds with the Ruby activity label. Interactive GUI operation was not automated.
- TypeScript typecheck and Wrangler deployment dry-run pass with the Worker Loader binding and bundled Wasm (~871 KiB uncompressed Wasm). No production deployment was performed.
- Live test used a separate local SQLite persistence directory and real remote Workers AI. Both Gemma 4 and GLM 4.7 Flash invoked `ruby_eval` once and returned the verified sum of squares, 338350. Gemma produced 13 partial events and GLM 3. The development server was stopped after verification. Existing user conversation data was not cleared or modified.
- Local live testing exposed nullable `tool_calls`/function fields in the provider SSE; handling and a regression fixture were added. One development-server reload interrupted an earlier smoke run; the final verification ran after reload and passed.
- Production Dynamic Worker CPU enforcement, account availability, billing and hosted lifecycle remain unverified. Local tests prove VM instruction traps and fixed Wasm memory behavior; they do not stand in for production CPU-limit enforcement.

## Static Runner migration — 2026-10-28

- Moved generated Wasm/JS and the reusable execution wrapper into `apps/ruby-runner/`; replaced Worker Loader with `RUBY_RUNNER.execute()` via Service Binding. The `ruby_eval` schema and tool result shape remain compatible. Existing SwiftUI changes from the previous feature were not modified by this migration.
- Rebuilt PicoRuby with Niao-owned phase instrumentation. Upstream checkouts remain unchanged. Both TypeScript workspaces pass typechecking.
- All **44 tests** pass. Tests build the actual Runner bundle and load it as a second workerd Worker. Coverage includes basic arithmetic, stdout, syntax/runtime errors, trapped infinite loops including rescue/ensure, memory/output limits, invalid RPC input, class/global isolation, HTTP 404, compatible tool results, and a model fixture → real Service Binding RPC → real Wasm → model fixture round trip. No AI inference charges were needed for migration tests.
- Wrangler multi-worker dev started with the Agent and Runner. A separate local-only smoke Worker calling the actual application tool adapter via the same Runner Service Binding returned `{ok:true,value:"2",instructions:3,stdout:""}`. No production deployment was performed.
- Agent and Runner deployment dry-runs pass. Runner has no bindings, secrets, public workers.dev URL or preview URL; the Agent bundle no longer contains the Ruby Wasm. Service Binding does not impose a host network denial policy.
- `npm run bench:ruby` measured local Node/V8 thread CPU and per-stage wall time. Final raw results: [ruby-static-local.json](benchmarks/ruby-static-local.json). Warm CPU medians: arithmetic 0.366ms, stdout 0.407ms, sum100 0.397ms, sum1000 0.889ms, fuel exhaustion 2.791ms. First arithmetic call: 9.107ms (another run: 10.018ms). Module load: 4.822ms CPU, separately measured.
- **Unmet acceptance condition:** hosted Workers Free cold/warm CPU-limit validation. Local workerd does not enforce the production CPU budget, Node timing excludes RPC overhead, and deployment is not authorized. Removal of paid-only features/build success is not evidence of Free-plan runtime reliability. The current evidence supports lightweight-workload experimentation, not a guarantee.
- Security limitations: no preemptive application timeout for C/compiler work, no equivalent of the removed outbound policy, and no immediate whole-isolate memory reclamation. Fixed Wasm memory and instruction traps remain verified. See [ruby-tool.md](ruby-tool.md) for mitigation choices and deployment order.

## Analytics fetch receiver fix — 2026-10-28

- Reproduced `Illegal invocation` in the real Workers runtime when global `fetch` was stored unbound and called as an Analytics instance property. This failed before any HTTP request; token permissions were not the cause of this code path.
- Bound the default fetch implementation to `globalThis`. Added a native-fetch regression test that exercises the instance receiver with an invalid URL, so it needs no external network or credential and distinguishes receiver failure from URL validation.
- All 45 backend tests, TypeScript typecheck and Agent Worker deployment dry-run passed. The fix requires redeploying only `niao-agent`; no Runner, app rebuild or credential changes are needed. No production deployment was performed.

## Analytics production diagnostics — 2026-10-28

- User reported the deployed receiver fix still returning `analytics_unavailable`; the actual production cause remains unconfirmed.
- Added bounded/redacted structured catch logging (phase, HTTP status, duration, exception type/message) and distinct HTTP/timeout/fetch/JSON error codes. Never log request headers, stacks or upstream response bodies. Failed HTTP response streams are cancelled.
- All 46 backend tests, both TypeScript checks and Agent dry-run passed. New coverage verifies redaction and error classification. No deployment performed; production diagnosis requires a new tail capture as documented in usage.md.

## Analytics redirect compatibility — 2026-10-28

- Production diagnostic log identified a second failure: Workers rejects `fetch` with `redirect:"error"` before issuing HTTP. The prior receiver fix alone could not resolve it.
- Changed Analytics fetch to `redirect:"manual"`. Existing non-2xx handling rejects 3xx and cancels the body, without forwarding credentials or following Location.
- Added regression cases for 301/302/303/307/308 and updated the request-options assertion. No deployment performed; account retrieval still requires confirmation after the user redeploys.

- After deploying the manual-redirect fix, the user confirmed the production usage API returned `account.status: "available"`, a numeric Neurons total and `errorCode: null`. Final local checks passed all 51 backend tests, typechecking and Agent dry-run.

## mruby-random / mruby-time — 2026-10-28

- Linked both core gems from the already pinned mruby submodule; regenerated the checked-in JS/Wasm without changing upstream checkouts. Wasm grew from 891535 to 909357 bytes (+17822 bytes).
- All **61 backend tests** pass (10 new gem-specific cases). Real Service Binding/Wasm tests cover explicit/implicit seeds, reproducible sequences, float/range rand, shuffle/sample/bytes, UTC dates, epoch arithmetic, actual Time.now, class/global isolation, random/time fuel exhaustion, oversized binary results and allocations. The binary size check uses bytesize, not UTF-8 character count.
- Typechecking and Agent dry-run passed; the Runner dry-run is part of npm test and passed. Wrangler multi-worker local smoke returned seeded sequence `59,93,25,33,22`, UTC epoch `1793145600` and the actual UTC current time. No remote AI calls or deployment were performed.
- Extended the reproducible local CPU benchmark with random/time workloads. Raw data: [ruby-random-time-local.json](benchmarks/ruby-random-time-local.json). Warm medians: random100 0.421ms, time arithmetic 0.375ms. First arithmetic call 13.466ms CPU; module load 7.497ms separately. Hosted Free-plan compatibility remains unverified; the observed cold local cost exceeds 10ms.
- Tool metadata now advertises the gems and removes the obsolete claim that the tool has no clock. Time.now reads host time; files, network, ENV, require and execution limits remain unchanged. No client rebuild is needed for this change.

## Client tool statistics — 2026-10-29

- Added a native statistics window available from the chat toolbar and menu bar, with the current app-launch session, all-time tool totals and past-session counts.
- Counters observe tool status events only. Duplicate starts/ends are suppressed; successive calls within the same turn remain separate. A completion without a start still counts an observed call. Offline/cross-launch missed events cannot be reconstructed; counts are observational, not an authoritative execution ledger.
- Sessions persist as aggregated metadata in a mode-0600 local file, excluding conversation contents, source, credentials and request/backend identifiers. Load failure disables overwriting the existing file. Sleep/reconnect/history clearing preserve the current app session and totals.
- Swift tests: 11 pass, including four statistics cases covering pairing, retries, multiple calls, backend/epoch separation, persistence, permissions, missing/corrupt data and protocol decoding. Xcode app build succeeds. Interactive GUI behavior remains a manual check. No Worker change or deployment is needed.

## Native Markdown chat rendering — 2026-10-29

- Added a small source-line-based block parser plus Foundation inline Markdown and native SwiftUI layouts, with no new dependencies. Covers hash headings, paragraphs, unordered/ordered lists, quotes, rules, inline emphasis/code/links, and backtick/tilde code fences. Tables/images/HTML/full CommonMark are out of scope.
- Applied to both persisted message rows and transient streamed output. Incomplete code fences display their contents immediately. Code preserves indentation/newlines, supports horizontal scrolling and has an explicit copy button. Underlying message/history strings are not rewritten.
- Swift tests: all 16 pass (five Markdown tests added), including CRLF/Japanese text, code delimiters inside longer fences, whitespace, stable streaming IDs, inline formatting attributes and safe link schemes. Xcode macOS build succeeds.
- Inspected light/dark sample views rendered by a hidden NSHostingView containing the real Markdown view. Code, quote, list and heading layouts were visible in both. SwiftUI ImageRenderer alone cannot render these native ScrollView/Button elements, so it was not used as evidence for those elements. Interactive in-app link/copy behavior remains a manual smoke check; user app data/clipboard were not modified by preview generation.

## Tool call toast — 2026-10-29

- Added a temporary native material toast over the chat history's bottom-right corner, above the input/error/outbox area. New observed calls trigger the toast through the same deduplication logic as local statistics; matched completion events do not trigger a second toast.
- Toasts expire after 3.5 seconds. Repeated same-tool calls while visible increment the badge and refresh the deadline; a different tool replaces the current notice. UUID-guarded dismissal prevents stale timers from removing newer notices. Switching backend or clearing history clears the visible notice; no toast is persisted or replayed from history.
- The overlay passes through hit testing, uses opacity/move/scale transitions, and respects Reduce Motion. It reports observed tool usage, not execution success.
- All 19 Swift tests and the macOS Xcode build pass. Three new tests cover expiry refresh, stale timer races, fresh/reset notices and event deduplication including completion-only observations.
- Rendered the actual overlay with a rendering-only store fixture in hidden NSHostingViews for light/dark layout inspection. Both previews asserted automatic dismissal after the real view task ran. This used no live chat data, credentials or backend requests. In-app end-to-end interaction remains a manual smoke check. No Worker changes or deployment are required.
