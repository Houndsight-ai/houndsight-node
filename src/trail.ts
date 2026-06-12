/**
 * Trail: the AgentRun primitive.
 *
 * A trail wraps one agent invocation: it records `start` and `complete`
 * events on the ingest endpoint, binds the async-context slot so nested
 * `sniff` calls (and the instrumenters) find the active trail, and exposes
 * the synchronous {@link Trail.leash} gate.
 *
 * Two usage styles:
 *
 * **Callback (recommended)** — lifecycle and context binding are guaranteed:
 * ```ts
 * await hs.trail({ trigger: "user_message", payload: { text: "Q2 forecast" } }, async (t) => {
 *   await t.sniff({ name: "salesforce_query", layer: "execute" }, async (s) => {
 *     s.cost(0.0001);
 *     s.output({ deal_count: 17 });
 *   });
 *   t.setOutput("Posted forecast");
 * });
 * ```
 *
 * **Manual** — for frameworks where the run spans callbacks:
 * ```ts
 * const t = hs.startTrail({ trigger: "webhook" });
 * try { ... } finally { t.end(maybeError); }
 * ```
 * Note: the manual style does **not** bind the async-context slot — pass the
 * trail explicitly to `t.sniff(...)` / `t.leash(...)`.
 *
 * Only {@link Trail.leash} awaits the network; everything else enqueues on
 * the background transport and returns immediately.
 */

import { randomUUID } from "node:crypto";

import { getClient } from "./client.js";
import { currentTrail, runWithTrail } from "./context.js";
import { requestLeash } from "./leash.js";
import { Step, type SniffOptions } from "./step.js";
import {
  TRIGGER_ALIASES,
  VALID_TRIGGERS,
  type LeashDecision,
  type LeashOptions,
  type Trigger,
} from "./types.js";

export interface TrailOptions {
  /**
   * What initiated this run. Must be one of the server's accepted values
   * (`webhook | schedule | user_message | agent_signal`); common aliases
   * (`cron`, `manual`, `api`, ...) map automatically. Anything else is sent
   * as `agent_signal` with the original preserved at
   * `payload._original_trigger` — an off-enum value would fail the
   * server-side `AgentRun.create` and silently lose the entire run.
   */
  trigger: string;
  payload?: Record<string, unknown>;
  agent?: string;
  pack?: string;
  traceId?: string;
}

const warnedTriggers = new Set<string>();
let warnedMissingAgent = false;

function normalizeTrigger(trigger: string, payload: Record<string, unknown>): Trigger {
  if (VALID_TRIGGERS.has(trigger)) return trigger as Trigger;
  const alias = TRIGGER_ALIASES[typeof trigger === "string" ? trigger.toLowerCase() : trigger];
  if (alias !== undefined) return alias;
  if (!("_original_trigger" in payload)) payload["_original_trigger"] = trigger;
  if (!warnedTriggers.has(trigger)) {
    warnedTriggers.add(trigger);
    console.warn(
      `[houndsight] trigger="${trigger}" is not one of the server's accepted trigger types ` +
        `[${[...VALID_TRIGGERS].sort().join(", ")}]; sending "agent_signal" instead ` +
        `(original value preserved in the trigger payload).`,
    );
  }
  return "agent_signal";
}

/** One agent run. Construct via {@link trail} or {@link startTrail}. */
export class Trail {
  readonly trigger: Trigger;
  readonly payload: Record<string, unknown>;
  readonly agent: string;
  readonly pack: string | undefined;
  readonly traceId: string;
  /**
   * Mirrors `traceId` until the server assigns an entity id; child events
   * reference it for a consistent correlation handle.
   */
  readonly agentRunId: string;

  private outputSummary: string | null = null;
  private errorSummary: string | null = null;
  private startedAt: Date | null = null;
  private ended = false;

  constructor(options: TrailOptions) {
    const client = getClient();
    this.payload = { ...(options.payload ?? {}) };
    this.trigger = normalizeTrigger(options.trigger, this.payload);
    let agent = options.agent ?? client.agent;
    if (!agent) {
      // The server's `start` handler and `checkLeash` both hard-require an
      // agent name; a missing agent silently loses the entire run.
      agent = "unnamed-agent";
      if (!warnedMissingAgent) {
        warnedMissingAgent = true;
        console.warn(
          `[houndsight] No agent name set — pass agent to hs.init() or hs.trail(). ` +
            `Recording this run under "unnamed-agent".`,
        );
      }
    }
    this.agent = agent;
    this.pack = options.pack ?? client.pack;
    this.traceId = options.traceId ?? randomUUID();
    this.agentRunId = this.traceId;
  }

  // ------------------------------------------------------------ child APIs
  /**
   * Open a child step. With a callback the step closes automatically
   * (status `"error"` if the callback throws, which propagates):
   *
   * ```ts
   * const rows = await t.sniff({ name: "db_query", layer: "execute" }, async (s) => {
   *   s.input(query);
   *   return runQuery(query);
   * });
   * ```
   */
  async sniff<T>(options: SniffOptions, fn: (step: Step) => T | Promise<T>): Promise<T> {
    const step = new Step(this, options).begin();
    try {
      const result = await fn(step);
      step.end();
      return result;
    } catch (err) {
      step.end(err);
      throw err;
    }
  }

  /** Open a step manually; you must call `step.end(error?)` yourself. */
  startSniff(options: SniffOptions): Step {
    return new Step(this, options).begin();
  }

  /**
   * Block until the leash service resolves the request or times out.
   * This is the **only** awaited network call in the SDK; see the leash
   * module for the protocol and trust model.
   */
  leash(options: LeashOptions): Promise<LeashDecision> {
    return requestLeash(this, options);
  }

  /** Set the output summary; sent on `end()`. */
  setOutput(summary: string): void {
    this.outputSummary = summary;
  }

  /** Set the error summary; sent on `end()` (auto-filled when `end(err)`). */
  setError(summary: string): void {
    this.errorSummary = summary;
  }

  // ------------------------------------------------------------- lifecycle
  /** @internal Emit `start`. */
  begin(): this {
    this.startedAt = new Date();
    getClient().emit({
      action: "start",
      trace_id: this.traceId,
      agent_run_id: this.agentRunId,
      trigger: this.trigger,
      payload: this.payload,
      agent: this.agent,
      pack: this.pack ?? null,
      started_at: this.startedAt.toISOString(),
    });
    return this;
  }

  /** Emit `complete`. Pass the thrown error, if any. Idempotent. */
  end(error?: unknown): void {
    if (this.ended) return;
    this.ended = true;
    const endedAt = new Date();
    if (error !== undefined && error !== null && this.errorSummary === null) {
      this.errorSummary =
        error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    }
    const startedAt = this.startedAt ?? endedAt;
    getClient().emit({
      action: "complete",
      trace_id: this.traceId,
      agent_run_id: this.agentRunId,
      ended_at: endedAt.toISOString(),
      duration_ms: endedAt.getTime() - startedAt.getTime(),
      output_summary: this.outputSummary,
      error_summary: this.errorSummary,
    });
  }
}

/**
 * Open an agent-run trail around `fn`, with the trail bound as the current
 * async-context trail for everything `fn` awaits. The `complete` event is
 * emitted when `fn` settles (with the error summary filled on rejection).
 */
export async function trail<T>(
  options: TrailOptions,
  fn: (trail: Trail) => T | Promise<T>,
): Promise<T> {
  const t = new Trail(options).begin();
  return runWithTrail(t, async () => {
    try {
      const result = await fn(t);
      t.end();
      return result;
    } catch (err) {
      t.end(err);
      throw err;
    }
  });
}

/**
 * Open a trail without a callback. You must call `trail.end(error?)`.
 * Does not bind the async-context slot — `currentTrail()` will not see it.
 */
export function startTrail(options: TrailOptions): Trail {
  return new Trail(options).begin();
}

export { currentTrail };
