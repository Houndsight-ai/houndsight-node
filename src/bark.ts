/**
 * Bark: emit a structured custom event tied to the current trail.
 *
 * Barks are arbitrary events attached to an agent run — the SDK's
 * equivalent of a `log.info` line, but as a typed event the ingest service
 * can index. The server materializes each bark as a synthetic
 * `output`-layer step on the run identified by `trace_id`.
 *
 * **Barks require an active trail.** The server's bark handler
 * hard-requires a `trace_id`; a bark emitted outside a trail would be
 * rejected server-side and silently lost. The SDK therefore skips the
 * network emit (one warning per process) and still returns the local
 * {@link BarkEvent} so calling code never breaks.
 */

import { randomUUID } from "node:crypto";

import { getClient } from "./client.js";
import { currentTrail } from "./context.js";

export interface BarkEvent {
  id: string;
  name: string;
  timestamp: string;
  data: Record<string, unknown>;
  /** Null when the bark was emitted outside an active trail (not sent). */
  traceId: string | null;
}

let warnedNoTrail = false;

/**
 * Emit a structured event scoped to the active trail.
 *
 * Outside an active trail the event is **not** sent (the server requires a
 * `trace_id` and would reject it); a warning is logged once per process and
 * a local {@link BarkEvent} is still returned.
 */
export function bark(name: string, data: Record<string, unknown> = {}): BarkEvent {
  const t = currentTrail();
  const id = randomUUID();
  const timestamp = new Date().toISOString();

  if (t === null) {
    if (!warnedNoTrail) {
      warnedNoTrail = true;
      console.warn(
        `[houndsight] bark("${name}") called outside an active trail — the server ` +
          `requires a trace_id, so this bark was not sent. Wrap the call in ` +
          `hs.trail(...) to record barks.`,
      );
    }
    return { id, name, timestamp, data: { ...data }, traceId: null };
  }

  getClient().emit({
    action: "bark",
    bark_id: id,
    name,
    data: { ...data },
    trace_id: t.traceId,
    agent_run_id: t.agentRunId,
    timestamp,
  });
  return { id, name, timestamp, data: { ...data }, traceId: t.traceId };
}
