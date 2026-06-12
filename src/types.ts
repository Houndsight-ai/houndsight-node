/**
 * Wire-format types for the Houndsight SDK.
 *
 * These describe the canonical shape of the payloads the SDK emits to the
 * `ingestAgentRun` endpoint and the decisions returned by `checkLeash`.
 */

/**
 * The six canonical layer values, matching the server's `AgentStep.layer`
 * enum: where a step sits in a typical agent control flow.
 *
 * - `trigger`  — the initiating signal (incoming user message, webhook, cron)
 * - `plan`     — reasoning / planning / deciding what to do next
 * - `execute`  — taking action: tool calls, LLM calls, retrieval, DB queries
 * - `systems`  — auxiliary SaaS calls (file uploads, fine-tuning jobs, etc.)
 * - `output`   — emitting the final result back to the caller
 * - `review`   — gating / approval check (emitted automatically by `leash()`)
 */
export type Layer = "trigger" | "plan" | "execute" | "systems" | "output" | "review";

export const VALID_LAYERS: ReadonlySet<string> = new Set([
  "trigger",
  "plan",
  "execute",
  "systems",
  "output",
  "review",
]);

/** Deprecated-but-supported layer aliases, normalized before sending. */
export const LAYER_ALIASES: Readonly<Record<string, Layer>> = {
  verify: "review",
  tool: "execute",
  llm: "plan",
  io: "systems",
  retrieve: "execute",
};

/**
 * The server's `AgentRun.trigger_type` enum. Any other value makes the
 * server-side `AgentRun.create` fail its schema validation — losing the
 * entire run and every step in it.
 */
export type Trigger = "webhook" | "schedule" | "user_message" | "agent_signal";

export const VALID_TRIGGERS: ReadonlySet<string> = new Set([
  "webhook",
  "schedule",
  "user_message",
  "agent_signal",
]);

/** Common trigger aliases normalized to the canonical enum. */
export const TRIGGER_ALIASES: Readonly<Record<string, Trigger>> = {
  cron: "schedule",
  scheduled: "schedule",
  timer: "schedule",
  user: "user_message",
  manual: "user_message",
  chat: "user_message",
  message: "user_message",
  api: "webhook",
  http: "webhook",
  event: "agent_signal",
  agent: "agent_signal",
};

/** Step outcome, matching the server's `AgentStep.status` enum. */
export type StepStatus = "success" | "error" | "retry" | "timeout" | "cached";

/** A per-call event recorded on a step. */
export interface StepEvent {
  type: string;
  payload: Record<string, unknown>;
  at: string;
}

/** JSON-serializable event payload sent to the ingest endpoint. */
export type IngestEvent = Record<string, unknown> & { action: string };

export type LeashOutcome =
  | "approved"
  | "rejected"
  | "modified"
  | "timeout"
  | "blocked"
  | "error"
  | "async";

/**
 * The resolved result of a `trail.leash(...)` call.
 *
 * `decision` values:
 * - `approved`  — gate allows the action (proceed)
 * - `rejected`  — human reviewer denied (do not proceed)
 * - `modified`  — reviewer approved with edits; use `modifiedPayload`
 * - `timeout`   — review window elapsed (client- or server-side), or the
 *                 gate service was unreachable / returned 5xx (do not proceed)
 * - `blocked`   — floor rule fired and blocked the action (do not proceed)
 * - `error`     — gate service rejected the request as malformed (4xx other
 *                 than an explicit floor-rule 422). The SDK fails closed but
 *                 does not pretend a floor rule fired — this almost always
 *                 means the SDK and server contracts have drifted.
 * - `async`     — only with `blocking: false`; the gate is still being
 *                 adjudicated server-side. Use `gateId` / the dashboard.
 */
export interface LeashDecision {
  /** Convenience boolean; true iff decision is `approved` or `modified`. */
  approved: boolean;
  decision: LeashOutcome;
  /** Human-readable explanation (floor-rule name, reviewer comments, ...). */
  reason: string;
  /** `"auto"`, `"floor_rule"`, a reviewer email, or null. */
  decidedBy: string | null;
  /** Present only when `decision === "modified"` — substitute it before executing. */
  modifiedPayload: Record<string, unknown> | null;
  /**
   * The server-side ReviewGate id when one was created (human-gate path and
   * `async`). With `blocking: false` this is the handle for polling later.
   */
  gateId: string | null;
  /** Deep link to the trace in the Houndsight dashboard. */
  traceLink: string;
}

export interface LeashOptions {
  actionName: string;
  actionSummary: string;
  /** Keyed risk signals, e.g. `{ amount_usd: 1200, data_categories: ["financial"] }`. */
  riskSignals?: Record<string, unknown>;
  /** Proposed action body — floor rules can match on its fields. */
  payload?: Record<string, unknown>;
  /** Client-side wait budget; also sets the server gate's expiry. Default 300. */
  timeoutSeconds?: number;
  /** When false, return `decision: "async"` immediately after gate creation. */
  blocking?: boolean;
}
