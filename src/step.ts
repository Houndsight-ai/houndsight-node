/**
 * Step: the AgentStep primitive (a single "sniff" inside a trail).
 *
 * `layer` describes *where* the step sits in the agent control flow (six
 * canonical values matching the server enum — see {@link Layer}).
 * `stepType` describes *what* the step does; when omitted it falls back to
 * a layer-appropriate default.
 *
 * Payloads passed to `input(...)` / `output(...)` are JSON-serialized and
 * truncated to 8 KB.
 */

import { randomUUID } from "node:crypto";

import { getClient } from "./client.js";
import { normalizeLayer } from "./context.js";
import type { Layer, StepEvent, StepStatus } from "./types.js";
import type { Trail } from "./trail.js";

/** Default `stepType` per canonical layer (matches the server's subtype docs). */
const STEP_TYPE_FOR_LAYER: Record<Layer, string> = {
  trigger: "user_message",
  plan: "llm_reasoning",
  execute: "tool_call",
  systems: "saas_api",
  output: "message",
  review: "auto_approve", // upgraded to "human_gate" by leash() when polling
};

/** Hard cap on serialized input/output payloads recorded on a step (8 KB). */
const PAYLOAD_LIMIT_BYTES = 8 * 1024;

function serializeTruncated(value: unknown, limit = PAYLOAD_LIMIT_BYTES): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  if (text.length <= limit) return text;
  return text.slice(0, limit - 16) + "...<truncated>";
}

export interface SniffOptions {
  name: string;
  layer?: string;
  stepType?: string;
}

/**
 * One step ("sniff") inside a {@link Trail}.
 *
 * Status is `"success"` on clean completion and `"error"` when the sniff
 * callback throws. Override with {@link Step.setStatus} for cases the SDK
 * can't detect (`"retry"`, `"timeout"`, `"cached"`).
 */
export class Step {
  readonly trail: Trail;
  readonly name: string;
  readonly layer: Layer;
  stepType: string;
  readonly stepId: string;

  startedAt: Date | null = null;
  endedAt: Date | null = null;
  status: StepStatus = "success";

  private costUsd: number | null = null;
  private tokenCount: number | null = null;
  private modelName: string | null = null;
  private promptTokens: number | null = null;
  private completionTokens: number | null = null;
  private inputPayload: string | null = null;
  private outputPayload: string | null = null;
  private events: StepEvent[] = [];
  private errorMessage: string | null = null;

  constructor(trail: Trail, options: SniffOptions) {
    this.trail = trail;
    this.name = options.name;
    this.layer = normalizeLayer(options.layer ?? "execute");
    this.stepType = options.stepType ?? STEP_TYPE_FOR_LAYER[this.layer];
    this.stepId = randomUUID();
  }

  // ------------------------------------------------------------ recording
  /** Record an incremental cost (USD) for this step. */
  cost(usd: number): void {
    this.costUsd = Number(usd);
  }

  /** Record an absolute token count for this step. */
  tokens(n: number): void {
    this.tokenCount = Math.trunc(n);
  }

  /**
   * Attribute this step to an LLM call.
   *
   * The server increments `AgentRun.observed_llm_calls` whenever a
   * `step_complete` event carries a top-level `model` or `prompt_tokens`
   * field — that counter feeds the bypass detector's
   * `expected_llm_traffic_missing` signal. Without this attribution,
   * SDK-instrumented LLM traffic is invisible to bypass detection.
   *
   * The built-in instrumenters call this automatically. Call it yourself
   * when recording a hand-rolled LLM step:
   *
   * ```ts
   * await t.sniff({ name: "openai/gpt-4o", layer: "plan", stepType: "llm_call" }, async (s) => {
   *   const response = await openai.chat.completions.create(...);
   *   s.llm("gpt-4o", response.usage?.prompt_tokens, response.usage?.completion_tokens);
   * });
   * ```
   *
   * When `tokens()` was not called separately, a total is derived from
   * `promptTokens + completionTokens`.
   */
  llm(model?: string | null, promptTokens?: number | null, completionTokens?: number | null): void {
    if (model != null) this.modelName = String(model);
    if (promptTokens != null) this.promptTokens = Math.trunc(promptTokens);
    if (completionTokens != null) this.completionTokens = Math.trunc(completionTokens);
    if (this.tokenCount === null && (promptTokens != null || completionTokens != null)) {
      this.tokenCount = Math.trunc(promptTokens ?? 0) + Math.trunc(completionTokens ?? 0);
    }
  }

  /** Record the step input. Serialized and truncated to 8 KB. */
  input(payload: unknown): void {
    this.inputPayload = serializeTruncated(payload);
  }

  /** Record the step output. Serialized and truncated to 8 KB. */
  output(payload: unknown): void {
    this.outputPayload = serializeTruncated(payload);
  }

  /**
   * Append a per-call event. Reserved `type` values used by built-in
   * integrations: `cost_metered`, `retry_error`, `result_cached`,
   * `log_emitted`, `risk_signal` (prefer {@link Step.riskSignal}).
   */
  emitEvent(type: string, payload: Record<string, unknown> = {}): void {
    this.events.push({ type, payload, at: new Date().toISOString() });
  }

  /**
   * Attach risk signals consumed by floor-rule evaluation at run completion.
   * The server collects every `risk_signal` event across the run's steps and
   * feeds them into `evaluateFloorRules` alongside run-level signals.
   *
   * ```ts
   * s.riskSignal({ amount_usd: 1200.0, data_categories: ["financial"] });
   * ```
   */
  riskSignal(signals: Record<string, unknown>): void {
    this.emitEvent("risk_signal", { ...signals });
  }

  /** Override the outcome status (`"retry"`, `"timeout"`, `"cached"`, ...). */
  setStatus(status: StepStatus): void {
    this.status = status;
  }

  // ----------------------------------------------------------- lifecycle
  /** @internal Emit `step_start`. Called by {@link Trail.sniff} / startSniff. */
  begin(): this {
    this.startedAt = new Date();
    getClient().emit({
      action: "step_start",
      trace_id: this.trail.traceId,
      agent_run_id: this.trail.agentRunId,
      step_id: this.stepId,
      name: this.name,
      layer: this.layer,
      step_type: this.stepType,
      started_at: this.startedAt.toISOString(),
    });
    return this;
  }

  /** @internal Emit `step_complete`. Pass the thrown error, if any. */
  end(error?: unknown): void {
    this.endedAt = new Date();
    if (error !== undefined && error !== null) {
      this.status = "error";
      this.errorMessage =
        error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    }
    const startedAt = this.startedAt ?? this.endedAt;
    const durationMs = this.endedAt.getTime() - startedAt.getTime();
    getClient().emit({
      action: "step_complete",
      trace_id: this.trail.traceId,
      agent_run_id: this.trail.agentRunId,
      step_id: this.stepId,
      name: this.name,
      layer: this.layer,
      step_type: this.stepType,
      started_at: startedAt.toISOString(),
      ended_at: this.endedAt.toISOString(),
      duration_ms: durationMs,
      status: this.status,
      cost_usd: this.costUsd,
      tokens: this.tokenCount,
      model: this.modelName,
      prompt_tokens: this.promptTokens,
      completion_tokens: this.completionTokens,
      input: this.inputPayload,
      output: this.outputPayload,
      events: [...this.events],
      error: this.errorMessage,
    });
  }
}
