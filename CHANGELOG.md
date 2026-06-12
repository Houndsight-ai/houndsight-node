# Changelog

## 0.1.0 — initial release

TypeScript/Node SDK for Houndsight, contract-equivalent to the Python SDK
`houndsight 0.2.0`. Born after the 0.2.0 contract audit, so every
correction from that release is baked in from the start:

### Core
- `trail(options, fn)` callback API bound to async context via
  `AsyncLocalStorage` (correlation survives `await` and concurrency);
  manual `startTrail()/end()` for non-callback lifecycles.
- Six-layer step taxonomy (`trigger`, `plan`, `execute`, `systems`,
  `output`, `review`) with legacy-alias normalization (`tool` → `execute`,
  ...) and hard rejection of unknown layers.
- Trigger normalization to the server enum (`webhook`, `schedule`,
  `user_message`, `agent_signal`); aliases (`cron`, `manual`, `api`, ...)
  map silently, unknown values map to `agent_signal` with the original
  preserved in the trigger payload and a one-time warning. Missing agent
  names default to `unnamed-agent` (one-time warning) instead of losing
  the run server-side.
- `step.llm(model, promptTokens, completionTokens)` emits top-level
  model/token fields on `step_complete` so the server's
  `observed_llm_calls` counter (bypass-detection input) increments;
  auto-derives `tokens` when unset, never overrides an explicit
  `tokens()` call.
- `step.riskSignal(...)` appends the reserved `risk_signal` per-call event
  consumed by floor-rule evaluation at run completion.
- `bark()` outside an active trail is skipped with a one-time warning
  (the server hard-requires `trace_id`) instead of being sent and silently
  dropped; the local event object is still returned.
- `collar()` opens implicit trails with `trigger: "agent_signal"`
  (server-enum-safe) and records the wrapped function name in the payload.

### Leash (two-phase gating protocol)
- Fast-path decisions on the initial POST; human gates polled at
  2 s ± 500 ms jitter against `?gate_id=` until resolution or the
  client-side deadline.
- Server-side `decision: "timeout"` and `"expired"` are both terminal
  (`expired` normalized to `timeout`) — no dead-gate polling.
- `gateId` carried on every gate-backed decision, including `async`
  (`blocking: false`) and decisions resolved via polling.
- Fail-closed mapping: network errors / 5xx / non-JSON → `timeout`;
  4xx → `error` (contract drift), except a 422 whose body actually carries
  a floor-rule block → `blocked`. Poll-time 5xx/non-JSON keep polling;
  poll-time 4xx → `error`.
- An explicit `approved: true` field can never flip a non-approved
  decision; an explicit `approved: false` veto on `approved`/`modified`
  is honored.
- The `review`-layer audit step is always emitted (`auto_approve` →
  `human_gate` on gating) with the decision, `gate_id`, and reason in its
  output; `leash_request`/`leash_decision` events ship at leash priority.
- `timeoutSeconds` validated before any side effects.

### Transport
- Zero-dependency `fetch` transport (Node ≥ 18) with background flushing
  on an unref'd timer, 100-event/1 MB batches, and leash-priority events
  preserved on buffer overflow.
- 429/408 retried with `Retry-After` support (delta-seconds and HTTP-date,
  capped at 30 s); other 4xx dropped after one attempt; exhausted retries
  requeue leash-priority events (bounded at 3) and drop normal telemetry.
- First-success/first-failure connectivity logging; `ping()` on init.
- `shutdown()` drains the buffer — **call `await hs.shutdown()` before
  process exit**.

### Instrumentation
- Explicit per-instance `instrumentOpenAI()` / `instrumentAnthropic()`
  (Node has no safe import hook). Idempotent; pass-through outside a
  trail.
- Streaming supported by wrapping the stream's async iterator in place
  (object identity preserved); usage aggregated from OpenAI usage chunks
  and Anthropic `message_start`/`message_delta` events; model attributed
  even when streams carry no usage so bypass detection stays accurate.
- Plan-vs-execute layer heuristic (tools present or planner-style system
  prompt) with a one-shot `setLayer()` override.
- Embedded pricing table (generated from the shared canonical
  `pricing.json`, snapshot 2026-01) with exact → longest-prefix →
  bounded reverse-prefix lookup; unknown models cost `null`, never a
  guess.

### Packaging
- Dual ESM + CommonJS builds plus `.d.ts` declarations; `exports` map
  with per-format `types`; `sideEffects: false`.
- 68 tests (vitest), `tsc --strict` clean, no runtime dependencies.
