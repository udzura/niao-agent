# Lessons for a future Pondro implementation

The Agent runtime remains TypeScript. A subsequent Niao-owned tool adds an isolated PicoRuby evaluator; no Pondro runtime is introduced.

| Responsibility | Owner here | Reusable lesson |
| --- | --- | --- |
| Agent addressing, hibernating sockets, SQLite access | Agents SDK + Durable Objects | Runtime lifecycle and transport should be independent of model APIs. |
| Immutable messages, sequence cursor, request ledger | Niao application | Model history is not the same thing as a durable event/sync contract. |
| Provider input, streaming parser, numeric usage | `ChatModel` / `WorkersAIModel` | A small stream-of-text/usage interface can support Ruby adapters later. |
| Context budget and language/personality prompt | Application policy | Neither belongs inside a universal runtime. |
| Credentials and routing | Worker boundary + Keychain | Authenticate before allocating agent instances or accepting sockets. |
| Optimistic state, uncertainty, reconnection | Native client | Retry identity must outlive network requests and process restarts. |

1. A Durable Object serializes synchronous code, but awaits permit other events. Claim a turn before any await; do not mistake actor placement for automatic async transaction serialization.
2. Use two durable boundaries: user/turn acceptance, then assistant/turn completion. The provisional stream is not the committed conversation. A provider stream that disconnects must not silently become a final answer.
3. A unique request ID is an application-level key, independent of transport connection IDs. Store status alongside it and return prior results for completed duplicates. Persisting a user message exactly once does not imply exactly-once provider billing after crashes.
4. SQL sequence cursors make HTTP repair predictable. Never move a repair cursor forward based only on a live broadcast; this creates gaps when HTTP and socket delivery overlap.
5. Hibernation discards memory. The runtime should make recovery semantics explicit: resume durable work, or mark interruption and request an explicit retry. Phase 1 chooses the latter to avoid hidden provider calls.
6. An official chat protocol can be convenient when its UI/history model matches the product. Niao's append-only native contract would need extra reconciliation around the official mutable message-array protocol, so the base Agent API is a useful smaller reference surface.
7. Logging should expose a stable allowlist of metadata. Avoid a generic exception logger at provider boundaries because exception bodies can contain prompts or authentication data.
8. Test at several boundaries: pure stream parser, real workerd Agent + SQLite with an explicit test model fixture, and the native URLSession transport against real Workers AI. A passing fixture test does not establish the real provider integration.
9. A production-quality Ruby bridge should expose cancellation/deadlines, persistent transactions, and safe numeric usage alongside streaming. Native host capability injection should remain distinct from agent conversation policy.

Later phases can add discovery, scheduling, memory, or tools without moving these boundaries. None is introduced just to anticipate a future Ruby runtime.

10. Mutable model selection belongs to persistent application configuration. Snapshot it before asynchronous generation so an in-flight response cannot accidentally mix providers after a settings change.
11. History deletion needs a durable generation/epoch as well as sequence cursors. Fence old offline submissions and in-flight sync responses, and make destructive retries conditional on the epoch. Keep billing observations separate from conversation lifecycle.

12. A computation tool needs independent budgets at VM, memory, output, and host CPU boundaries. Ruby exceptions are unsuitable for non-bypassable fuel exhaustion: trap the Wasm invocation and discard its instance. Native methods and compilation require a host CPU boundary even with bytecode fuel.

13. A static Worker plus Service Binding can host an immutable Wasm module without Worker Loader, while recreating mutable VM state for every RPC. The tool schema and persistence policy can remain unchanged during this hosting migration.
14. Service separation is capability organization, not a replacement for untrusted-code isolation or preemption. Removing a Dynamic Worker also removes its outbound policy and explicit CPU budget. Document those losses; do not disguise an await timeout as cancellation of synchronous Wasm.
15. Measure Wasm instantiation, VM initialization, compilation, evaluation, and serialization separately. A low warm median can hide a first invocation close to the Free CPU ceiling. Workers elapsed clocks are not CPU meters; local thread CPU measurements need hosted validation. Preserve a reproducible benchmark and its provenance alongside runtime changes.

16. Provider-specific thinking normalization belongs in a small, stateful text adapter created per model invocation, separate from tool orchestration. Support structured reasoning fields as well as documented raw markers; SSE transport chunks are not semantic boundaries. Persist inspectable thinking separately, keyed by turn and generation, without feeding it back into ordinary conversation context. Completed answer/thinking should commit atomically, while interrupted partials retain explicit transient semantics.
