/**
 * Collar: wrap a function so each invocation is traced.
 *
 * Inside an active trail, the call becomes a sniff on that trail. Outside
 * one, the collar opens an implicit single-step trail with
 * `trigger: "agent_signal"` (the server's trigger enum has no per-function
 * value) and records the wrapped function's name in the trigger payload
 * under `"collar"`.
 *
 * ```ts
 * const fetchDeals = hs.collar(async function fetchDeals(region: string) {
 *   return crm.query(region);
 * }, { layer: "execute" });
 * ```
 */

import { currentTrail } from "./context.js";
import { Trail } from "./trail.js";

export interface CollarOptions {
  name?: string;
  layer?: string;
  stepType?: string;
}

/** Wrap `fn` (sync or async) so each invocation is recorded as a step. */
export function collar<Args extends unknown[], R>(
  fn: (...args: Args) => R | Promise<R>,
  options: CollarOptions = {},
): (...args: Args) => Promise<R> {
  const label = options.name ?? fn.name ?? "collared_fn";

  return async function collared(...args: Args): Promise<R> {
    const sniffOptions = {
      name: label,
      layer: options.layer ?? "execute",
      ...(options.stepType !== undefined ? { stepType: options.stepType } : {}),
    };
    const active = currentTrail();
    if (active !== null) {
      return active.sniff<R>(sniffOptions, async (s) => {
        s.input({ args: summarizeArgs(args) });
        const result = await fn(...args);
        s.output(summarizeResult(result));
        return result;
      });
    }
    // No active trail: open an implicit one. trigger must come from the
    // server enum — a per-function trigger value would fail server-side
    // schema validation and silently lose the run.
    const t = new Trail({ trigger: "agent_signal", payload: { collar: label } }).begin();
    try {
      const result = await t.sniff<R>(sniffOptions, async (s) => {
        s.input({ args: summarizeArgs(args) });
        const value = await fn(...args);
        s.output(summarizeResult(value));
        return value;
      });
      t.end();
      return result;
    } catch (err) {
      t.end(err);
      throw err;
    }
  };
}

function summarizeArgs(args: unknown[]): unknown[] {
  return args.map((a) => summarizeResult(a));
}

function summarizeResult(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean") return value;
  try {
    JSON.stringify(value);
    return value; // serializable; Step.input/output handle truncation
  } catch {
    return String(value);
  }
}
