/**
 * Cost attribution from a static provider/model pricing table.
 *
 * The table is generated from the canonical shared `pricing.json` (see the
 * houndsight-python repo) — keep the two SDKs in sync when prices change.
 *
 * Lookup is three-tier:
 *   1. exact model-id match
 *   2. longest table key that is a prefix of the model id
 *      (`gpt-4o-2024-08-06` → `gpt-4o`)
 *   3. longest model id that is a prefix of a table key, min 5 chars
 *      (defensive reverse match)
 */

import { PRICING, type PriceEntry } from "./pricingData.js";

function lookup(provider: string, model: string): PriceEntry | null {
  const models = PRICING[provider];
  if (!models) return null;

  const exact = models[model];
  if (exact) return exact;

  let best: { key: string; entry: PriceEntry } | null = null;
  for (const [key, entry] of Object.entries(models)) {
    if (model.startsWith(key) && (best === null || key.length > best.key.length)) {
      best = { key, entry };
    }
  }
  if (best) return best.entry;

  for (const [key, entry] of Object.entries(models)) {
    if (model.length >= 5 && key.startsWith(model) && (best === null || key.length > best.key.length)) {
      best = { key, entry };
    }
  }
  return best?.entry ?? null;
}

/**
 * USD cost for a call, or null when the provider/model is unknown.
 * Unknown models must return null — a wrong cost is worse than no cost.
 */
export function costFor(
  provider: string,
  model: string,
  promptTokens: number,
  completionTokens: number,
): number | null {
  const entry = lookup(provider, model);
  if (!entry) return null;
  return (
    (promptTokens / 1_000_000) * entry.prompt_per_million +
    (completionTokens / 1_000_000) * entry.completion_per_million
  );
}

/** True when the provider/model pair has a pricing entry. */
export function hasPricing(provider: string, model: string): boolean {
  return lookup(provider, model) !== null;
}
