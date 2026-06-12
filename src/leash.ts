/**
 * Leash: synchronous policy gating via the Houndsight `checkLeash` endpoint.
 *
 * Protocol
 * --------
 * `trail.leash(...)` is the **only** awaited network call in the SDK. It
 * contacts the server at the `checkLeash` URL (derived from the configured
 * `ingestUrl`) and follows a two-phase protocol:
 *
 * 1. `POST .../checkLeash` with the leash request body.
 * 2. The server runs `evaluateFloorRules` synchronously. Three outcomes:
 *
 *    - **Fast-path approve** — agent policy + trust signals permit the
 *      action. The response carries
 *      `{"decision": "approved", "decided_by": "auto"}` and the SDK returns
 *      immediately.
 *    - **Fast-path block** — a floor rule with `action="block"` fires. The
 *      response carries `{"decision": "blocked", "decided_by": "floor_rule"}`
 *      and the SDK returns immediately.
 *    - **Human gate** — neither fast path triggers. The server creates a
 *      `ReviewGate` row and returns `{"gate_id": "..."}`. The SDK polls
 *      `GET .../checkLeash?gate_id=...` every 2 s (±500 ms jitter) until the
 *      gate resolves or `timeoutSeconds` elapses.
 *
 * 3. On timeout the SDK returns `decision: "timeout", approved: false`. The
 *    server marks the gate `status=expired`. The poll endpoint itself
 *    returns `decision: "timeout"` the moment a gate passes its
 *    `expires_at`, and `decision: "expired"` on later polls — both are
 *    terminal and normalized to `"timeout"`.
 *
 * Audit step
 * ----------
 * `leash()` **always** emits an `AgentStep` with `layer: "review"` before
 * returning, even on timeout or network failure. The `stepType` is
 * `"auto_approve"` when the decision came back on the initial POST and
 * `"human_gate"` when polling was required. The presence of the review step
 * in a trace is what makes the trust model auditable.
 *
 * Trust model (summary)
 * ---------------------
 * The SDK enforces **nothing** locally. It POSTs the request, reads the
 * response, and returns it. The gating decision is server-side. This is
 * deliberate: a modified or tampered SDK cannot bypass the gate, because
 * the gate is gated by the **presence of the leash() call itself**. A
 * bypass manifests as the *absence* of a `review`-layer step in the trace —
 * a detectable anomaly server-side.
 */

import { getClient } from "./client.js";
import { LeashError } from "./errors.js";
import { Step } from "./step.js";
import { PRIORITY_LEASH } from "./transport.js";
import type { LeashDecision, LeashOptions } from "./types.js";
import { USER_AGENT } from "./version.js";

import type { Trail } from "./trail.js";

/** Function name appended to the Base44 functions base path. */
const LEASH_FUNCTION = "checkLeash";

/**
 * Timing knobs, exported as a mutable object so tests can shrink them.
 *
 * - `initialPostTimeoutMs` — long enough to absorb a slow floor-rule eval,
 *   short enough to bound caller blocking when the fast path is taken.
 * - `pollBaseIntervalMs` / `pollJitterMs` — spec: every 2 s, ±500 ms jitter.
 */
export const LEASH_TIMING = {
  initialPostTimeoutMs: 10_000,
  pollHttpTimeoutMs: 10_000,
  pollBaseIntervalMs: 2_000,
  pollJitterMs: 500,
};

const TERMINAL_DECISIONS = new Set([
  "approved",
  "rejected",
  "modified",
  "blocked",
  "timeout",
  "expired",
]);

// ------------------------------------------------------------- URL helpers
/**
 * Convert an `ingestAgentRun` URL into the matching `checkLeash` URL.
 * Handles the default URL by suffix replacement and falls back to swapping
 * the final path segment for arbitrary overrides.
 */
export function deriveLeashUrl(ingestUrl: string): string {
  if (ingestUrl.endsWith("/ingestAgentRun")) {
    return ingestUrl.slice(0, -"ingestAgentRun".length) + LEASH_FUNCTION;
  }
  try {
    const parsed = new URL(ingestUrl);
    const path = parsed.pathname;
    const slash = path.lastIndexOf("/");
    parsed.pathname = slash >= 0 ? `${path.slice(0, slash)}/${LEASH_FUNCTION}` : `/${LEASH_FUNCTION}`;
    return parsed.toString();
  } catch {
    return `https://houndsight.ai/api/functions/${LEASH_FUNCTION}`;
  }
}

/** Build a dashboard deep link using the host of the ingest URL. */
export function buildTraceLink(ingestUrl: string, traceId: string): string {
  try {
    const parsed = new URL(ingestUrl);
    return `${parsed.protocol}//${parsed.host}/dashboard/traces/${traceId}`;
  } catch {
    return `https://houndsight.ai/dashboard/traces/${traceId}`;
  }
}

function nextPollDelayMs(): number {
  const { pollBaseIntervalMs, pollJitterMs } = LEASH_TIMING;
  return pollBaseIntervalMs + (Math.random() * 2 - 1) * pollJitterMs;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, Math.max(0, ms));
    (t as { unref?: () => void }).unref?.();
  });
}

// --------------------------------------------------------- response helpers
function truncate(text: string, limit = 200): string {
  const oneLine = text.trim().replace(/\n/g, " ");
  if (oneLine.length > limit) return oneLine.slice(0, limit) + "...<truncated>";
  return oneLine || "<empty>";
}

async function safeBodyText(response: Response): Promise<string> {
  try {
    return truncate(await response.text());
  } catch {
    return "<unreadable>";
  }
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFinalDecision(body: Record<string, unknown>): boolean {
  const decision = body["decision"];
  return typeof decision === "string" && TERMINAL_DECISIONS.has(decision);
}

/**
 * Coerce a server response body into a {@link LeashDecision}.
 *
 * The server's `"expired"` (a stale-gate poll result) is normalized to
 * `"timeout"` — the SDK surface keeps one vocabulary. An explicit
 * `approved` field is honored only on `approved`/`modified` decisions
 * (where the server may still veto); it can never flip `rejected`,
 * `blocked`, or `timeout` to approved.
 */
function decisionFromBody(body: Record<string, unknown>, traceLink: string): LeashDecision {
  let decision = typeof body["decision"] === "string" ? (body["decision"] as string) : "timeout";
  if (decision === "expired") decision = "timeout";
  if (!["approved", "rejected", "modified", "blocked", "timeout"].includes(decision)) {
    decision = "timeout";
  }
  const approvedField = body["approved"];
  const approved =
    typeof approvedField === "boolean" && (decision === "approved" || decision === "modified")
      ? approvedField
      : decision === "approved" || decision === "modified";

  const modified = body["modified_payload"];
  const gateId = body["gate_id"];
  const decidedBy = body["decided_by"];
  const link = body["trace_link"];
  return {
    approved,
    decision: decision as LeashDecision["decision"],
    reason: String(body["reason"] ?? ""),
    decidedBy: typeof decidedBy === "string" ? decidedBy : null,
    modifiedPayload: isRecord(modified) ? modified : null,
    gateId: typeof gateId === "string" ? gateId : null,
    traceLink: typeof link === "string" && link ? link : traceLink,
  };
}

function failClosed(
  decision: "timeout" | "error",
  reason: string,
  traceLink: string,
  gateId: string | null = null,
): LeashDecision {
  return {
    approved: false,
    decision,
    reason,
    decidedBy: null,
    modifiedPayload: null,
    gateId,
    traceLink,
  };
}

async function timedFetch(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  (t as { unref?: () => void }).unref?.();
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

// ----------------------------------------------------------- main entrypoint
/** Block until the server resolves the leash, or return `"async"`. */
export async function requestLeash(trail: Trail, options: LeashOptions): Promise<LeashDecision> {
  const timeoutSeconds = options.timeoutSeconds ?? 300;
  const blocking = options.blocking ?? true;
  if (!(timeoutSeconds > 0)) {
    throw new LeashError("timeoutSeconds must be positive");
  }

  const client = getClient();
  const leashUrl = deriveLeashUrl(client.ingestUrl);
  const traceLink = buildTraceLink(client.ingestUrl, trail.traceId);

  const riskSignals = { ...(options.riskSignals ?? {}) };
  const payload = { ...(options.payload ?? {}) };
  const requestBody = {
    action_name: options.actionName,
    action_summary: options.actionSummary,
    risk_signals: riskSignals,
    payload,
    trace_id: trail.traceId,
    agent_run_id: trail.agentRunId,
    agent: trail.agent,
    pack: trail.pack ?? null,
    timeout_seconds: timeoutSeconds,
    blocking,
  };

  // Mandatory review-layer step. stepType starts "auto_approve" and is
  // upgraded to "human_gate" if we end up polling.
  const step = new Step(trail, {
    name: options.actionName,
    layer: "review",
    stepType: "auto_approve",
  }).begin();

  step.input({
    action_name: options.actionName,
    action_summary: options.actionSummary,
    risk_signals: riskSignals,
    payload,
    blocking,
    timeout_seconds: timeoutSeconds,
  });

  // Compliance-grade audit event (kept on buffer overflow over normal events).
  client.emit(
    {
      action: "leash_request",
      trace_id: trail.traceId,
      agent_run_id: trail.agentRunId,
      action_name: options.actionName,
      action_summary: options.actionSummary,
      risk_signals: riskSignals,
    },
    PRIORITY_LEASH,
  );

  let decision: LeashDecision | null = null;
  let thrown: unknown = undefined;
  try {
    decision = await doLeash(client.fetchImpl, client.apiKey, leashUrl, requestBody, {
      timeoutSeconds,
      blocking,
      traceLink,
      step,
    });
    return decision;
  } catch (err) {
    // doLeash is designed never to throw; defensively record the failure on
    // the review step (status="error") instead of a false "success".
    thrown = err;
    throw err;
  } finally {
    if (decision !== null) {
      step.output({
        decision: decision.decision,
        approved: decision.approved,
        reason: decision.reason,
        decided_by: decision.decidedBy,
        modified: decision.modifiedPayload !== null,
        gate_id: decision.gateId,
      });
      client.emit(
        {
          action: "leash_decision",
          trace_id: trail.traceId,
          agent_run_id: trail.agentRunId,
          data: {
            approved: decision.approved,
            decision: decision.decision,
            reason: decision.reason,
            decided_by: decision.decidedBy,
            modified_payload: decision.modifiedPayload,
            gate_id: decision.gateId,
            trace_link: decision.traceLink,
          },
        },
        PRIORITY_LEASH,
      );
    }
    step.end(thrown);
  }
}

// ------------------------------------------------------------------ internals
interface DoLeashContext {
  timeoutSeconds: number;
  blocking: boolean;
  traceLink: string;
  step: Step;
}

/** Perform the two-phase server interaction. Always resolves to a LeashDecision. */
async function doLeash(
  fetchImpl: typeof fetch,
  apiKey: string,
  leashUrl: string,
  requestBody: Record<string, unknown>,
  ctx: DoLeashContext,
): Promise<LeashDecision> {
  const { timeoutSeconds, blocking, traceLink, step } = ctx;
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    "User-Agent": USER_AGENT,
  };

  // ----- Phase 1: initial POST -------------------------------------------
  let response: Response;
  try {
    response = await timedFetch(
      fetchImpl,
      leashUrl,
      { method: "POST", headers, body: JSON.stringify(requestBody) },
      LEASH_TIMING.initialPostTimeoutMs,
    );
  } catch (err) {
    // Fail closed: if the gate is unreachable, refuse the action.
    const name = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return failClosed("timeout", `could not reach gate service: ${name}`, traceLink);
  }

  if (response.status >= 500) {
    return failClosed(
      "timeout",
      `gate service unavailable (status=${response.status})`,
      traceLink,
    );
  }
  if (response.status >= 400) {
    // 422 (Unprocessable Entity) is the *only* status that may indicate a
    // floor-rule block, and even then only when the body actually says so.
    // Every other 4xx is a client contract bug (bad apiKey, bad URL,
    // malformed payload, ...) — fail closed, but call it "error", not
    // "blocked".
    if (response.status === 422) {
      const parsed = await safeJson(response);
      if (
        isRecord(parsed) &&
        (parsed["decision"] === "blocked" || parsed["decided_by"] === "floor_rule")
      ) {
        return decisionFromBody(parsed, traceLink);
      }
      const bodyText = isRecord(parsed) ? truncate(JSON.stringify(parsed)) : "<non-json>";
      return failClosed(
        "error",
        `gate service returned 422 without a floor-rule body (body=${bodyText})`,
        traceLink,
      );
    }
    const bodyText = await safeBodyText(response);
    return failClosed(
      "error",
      `gate service rejected request (status=${response.status}, body=${bodyText})`,
      traceLink,
    );
  }

  const initialBody = await safeJson(response);
  if (!isRecord(initialBody)) {
    return failClosed("timeout", "gate service returned non-JSON response", traceLink);
  }

  // Fast path: server returned a final decision on the initial POST.
  if (isFinalDecision(initialBody)) {
    return decisionFromBody(initialBody, traceLink);
  }

  // Otherwise we expect a gate_id and must poll.
  const gateId = initialBody["gate_id"];
  if (typeof gateId !== "string" || !gateId) {
    return failClosed(
      "timeout",
      "gate service returned neither decision nor gate_id",
      traceLink,
    );
  }

  // The review-layer step type upgrades the moment we know polling is needed.
  step.stepType = "human_gate";

  // blocking=false: return immediately; the server adjudicates in background.
  if (!blocking) {
    return {
      approved: false,
      decision: "async",
      reason: `gate pending (gate_id=${gateId}); check dashboard`,
      decidedBy: null,
      modifiedPayload: null,
      gateId,
      traceLink,
    };
  }

  // ----- Phase 2: poll on gate_id ------------------------------------------
  return pollGate(fetchImpl, leashUrl, gateId, timeoutSeconds, traceLink, headers);
}

/** Poll `leashUrl?gate_id=...` until resolved or timeout. */
async function pollGate(
  fetchImpl: typeof fetch,
  leashUrl: string,
  gateId: string,
  timeoutSeconds: number,
  traceLink: string,
  headers: Record<string, string>,
): Promise<LeashDecision> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  const url = new URL(leashUrl);
  url.searchParams.set("gate_id", gateId);

  for (;;) {
    // Sleep first (the initial POST counts as the first probe). Honor deadline.
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return failClosed("timeout", `no decision within ${timeoutSeconds}s`, traceLink, gateId);
    }
    await sleep(Math.min(nextPollDelayMs(), remaining));
    if (Date.now() >= deadline) {
      return failClosed("timeout", `no decision within ${timeoutSeconds}s`, traceLink, gateId);
    }

    let response: Response;
    try {
      response = await timedFetch(
        fetchImpl,
        url.toString(),
        { method: "GET", headers },
        LEASH_TIMING.pollHttpTimeoutMs,
      );
    } catch {
      continue; // transient; keep polling until timeout
    }

    if (response.status >= 500) continue; // transient; keep polling
    if (response.status >= 400) {
      // Client errors during polling mean the gate_id is invalid, auth
      // expired, or some other contract issue — not a floor-rule block.
      // Fail closed with "error".
      return failClosed(
        "error",
        `gate poll rejected (status=${response.status}, body=${await safeBodyText(response)})`,
        traceLink,
        gateId,
      );
    }

    const body = await safeJson(response);
    if (!isRecord(body)) continue;
    if (isFinalDecision(body)) {
      const decision = decisionFromBody(body, traceLink);
      // The poll context knows the gate id even if the body omits it.
      if (decision.gateId === null) decision.gateId = gateId;
      return decision;
    }
    // Still pending; loop.
  }
}
