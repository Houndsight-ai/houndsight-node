# houndsight

AI agent governance SDK for Node — trace every agent run, gate high-risk
actions behind server-side policy, and keep a tamper-evident audit trail.

This is the TypeScript/Node counterpart of the
[`houndsight` Python SDK](https://pypi.org/project/houndsight/). It speaks
the same server contract (events, layers, triggers, the two-phase leash
protocol) so traces from mixed Python/Node fleets land in one dashboard
with identical semantics.

- **Node ≥ 18** (uses the global `fetch` — no runtime dependencies)
- Ships **ESM + CommonJS + type declarations**
- TypeScript-first API; plain JavaScript works too

```bash
npm install houndsight
```

## Quickstart

```ts
import * as hs from "houndsight";

hs.init({
  apiKey: process.env.HOUNDSIGHT_API_KEY!, // sk-hnd-...
  agent: "sales-pipeline",                 // default agent name for trails
});

await hs.trail({ trigger: "user_message" }, async (t) => {
  await t.sniff({ name: "fetch_deals", layer: "execute" }, async (s) => {
    s.input({ region: "emea" });
    const deals = await crm.fetchDeals("emea");
    s.output({ count: deals.length });
    return deals;
  });
});

await hs.shutdown(); // REQUIRED before process exit — drains telemetry
```

> **Always `await hs.shutdown()`** (or `getClient().flush()`) before the
> process exits. Events are buffered and flushed in the background on an
> unref'd timer; an abrupt exit can drop the tail of a run. In serverless
> handlers, flush at the end of each invocation.

`trail(options, fn)` binds the trail to async context via
`AsyncLocalStorage`, so `currentTrail()`, `bark()`, instrumented LLM
clients, and `collar`-wrapped functions all correlate automatically —
including across `await` boundaries and concurrent trails. A manual
`startTrail()/t.end()` API exists for lifecycles that don't fit a callback.

## The leash

`t.leash()` is the only awaited network call in the SDK. It asks the server
whether a high-risk action may proceed, and blocks until a decision is made
(fast-path policy evaluation, human review gate, or timeout).

```ts
const decision = await t.leash({
  actionName: "send_contract",
  actionSummary: "Email the Q2 contract to ACME ($50k)",
  riskSignals: { amount_usd: 50_000, data_categories: ["financial"] },
  payload: { to: "legal@acme.com" },
  timeoutSeconds: 300,
});

if (decision.approved) {
  // Use the reviewer's modifications if any.
  const payload = decision.modifiedPayload ?? originalPayload;
  await send(payload);
}
```

`decision.decision` is one of:

| value      | `approved` | meaning                                                                                   |
|------------|------------|-------------------------------------------------------------------------------------------|
| `approved` | `true`     | Gate allows the action.                                                                   |
| `modified` | `true`     | Approved with edits — use `decision.modifiedPayload`.                                     |
| `rejected` | `false`    | A human reviewer denied the action.                                                       |
| `blocked`  | `false`    | A floor rule fired and blocked the action automatically.                                  |
| `timeout`  | `false`    | No decision within `timeoutSeconds`, or the gate service was unreachable / returned 5xx.  |
| `error`    | `false`    | The gate service rejected the request as malformed (4xx). **The gate is broken, not the action.** Almost always means the SDK and server contracts have drifted; check `decision.reason` for the response body. |
| `async`    | `false`    | Only with `blocking: false`. Decision pending server-side.                                |

`timeout` and `error` are both fail-closed but they mean different things —
the dashboard alerts on them differently. `timeout` is "we tried and the
gate didn't answer in time"; `error` is "we tried and the gate said our
request was wrong" (bad API key, bad endpoint URL, schema mismatch).

`decision.gateId` carries the server-side review-gate id whenever a gate
was created (human-gate path and `async`).

Calls block by default for up to `timeoutSeconds` (default 300). Pass
`blocking: false` to fire-and-forget; `decision.gateId` is the handle for
the pending gate — check the dashboard at `decision.traceLink` for the
final outcome.

Every `leash()` call emits a `review`-layer step into the trace —
`stepType: "auto_approve"` when the decision came back on the initial POST,
`"human_gate"` when polling was required. That step is the audit record;
see the trust model below.

### Triggers

`trigger` must be one of the server's accepted values: `webhook`,
`schedule`, `user_message`, `agent_signal`. Common aliases (`cron`,
`manual`, `api`, ...) are mapped automatically; anything else is sent as
`agent_signal` with the original value preserved in the trigger payload.

### LLM attribution

The built-in instrumenters attribute every LLM call (model + token split)
so the server's `observed_llm_calls` counter — which feeds bypass
detection — stays accurate. For hand-rolled LLM steps, call it yourself:

```ts
await t.sniff({ name: "openai/gpt-4o", layer: "plan", stepType: "llm_call" }, async (s) => {
  const response = await openai.chat.completions.create(/* ... */);
  s.llm("gpt-4o", response.usage.prompt_tokens, response.usage.completion_tokens);
});
```

Attach risk signals that floor rules evaluate at run completion with
`s.riskSignal({ amount_usd: 1200, data_categories: ["financial"] })`.

## Instrumentation (explicit, per-instance)

Node has no safe post-import patch point — an SDK must not impose a custom
ESM loader or mutate module caches. Instrumentation is therefore an
explicit, per-instance call (unlike the Python SDK's import-hook
auto-instrumentation):

```ts
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import * as hs from "houndsight";

const openai = hs.instrumentOpenAI(new OpenAI());
const anthropic = hs.instrumentAnthropic(new Anthropic());
```

Calls made **inside an active trail** are recorded as steps with
model/token/cost attribution; calls outside a trail pass through untouched.
Both wrappers are idempotent and preserve the client instance.

Streaming is supported: the stream object's async iterator is wrapped in
place (object identity and other stream methods preserved) and the step
closes when iteration finishes or throws. For OpenAI streams, pass
`stream_options: { include_usage: true }` to get token/cost attribution;
without it the model is still recorded so bypass detection stays accurate.

Layer classification: calls carrying `tools`/`functions`, or whose system
prompt reads like a planner prompt, are recorded as `plan`; plain
completions as `execute`. Override per-call with
`hs.setLayer("output", "message")` immediately before the LLM call
(one-shot, consumed by the next instrumented call).

### `collar` — wrap any function

```ts
const fetchDeals = hs.collar(async (region: string) => crm.query(region), {
  name: "fetchDeals",
  layer: "execute",
});
```

Inside a trail, each invocation becomes a step. Outside one, the collar
opens an implicit single-step trail with `trigger: "agent_signal"` and the
function name recorded in the trigger payload.

### `bark` — structured custom events

```ts
hs.bark("cache_hit", { key: "deals:emea" });
```

Barks require an active trail (the server hard-requires a `trace_id`);
outside one the event is skipped with a one-time warning rather than sent
and silently dropped server-side.

## TRUST MODEL — read this before deploying

The SDK enforces **nothing** locally. `leash()` POSTs the request, reads
the response, and returns it. The gating decision is server-side. This is
deliberate: a modified or tampered SDK cannot bypass the gate, because the
gate is gated by the **presence of the leash() call itself**. A bypass
manifests as the *absence* of a `review`-layer step in the trace — a
detectable anomaly server-side (expected-LLM-traffic and review-step
checks both feed the bypass detector).

Consequences you should design for:

- **Fail-closed**: network failure, 5xx, and non-JSON responses all return
  `approved: false`. Your agent must handle a denied action gracefully.
- **Don't gate on the client**: never reimplement policy locally "for
  speed". The floor rules live server-side precisely so they can't be
  waived by the calling process.
- **Keep telemetry flowing**: the bypass detector compares observed LLM
  calls against expectations. Instrument your LLM clients (or call
  `s.llm()`) even on paths where you think it doesn't matter.

## Concepts

| term    | meaning                                                                     |
|---------|------------------------------------------------------------------------------|
| trail   | One agent run: a `start` → steps → `complete` event sequence (a trace).      |
| sniff   | One step inside a trail, with a six-layer taxonomy: `trigger`, `plan`, `execute`, `systems`, `output`, `review`. |
| leash   | A synchronous server-side permission check for a high-risk action.           |
| bark    | A structured custom event tied to the active trail.                          |
| collar  | A function wrapper that records each invocation as a step.                   |

## Configuration

```ts
hs.init({
  apiKey: "sk-hnd-...",           // or HOUNDSIGHT_API_KEY
  ingestUrl: "...",                // or HOUNDSIGHT_INGEST_URL (default: production)
  agent: "my-agent",               // default agent for trails
  pack: "sales",                   // optional agent-pack label
  debug: true,                     // or HOUNDSIGHT_DEBUG=1
  flushIntervalMs: 2_000,          // background flush cadence
  fetchImpl: customFetch,          // dependency injection (tests, proxies)
});
```

Events are buffered (leash audit events survive overflow preferentially),
batched (100 events / 1 MB per request), and retried with backoff on
5xx/429/408 — honoring `Retry-After`. Exhausted retries requeue
leash-priority events (bounded) and drop normal telemetry rather than
block your agent.

## Versioning & parity

This package tracks the Python SDK's server contract. `houndsight-node
0.1.x` is contract-equivalent to `houndsight` (Python) `0.2.x`.

MIT licensed.
