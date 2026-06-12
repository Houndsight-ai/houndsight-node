/**
 * Async-context plumbing shared by trail, collar, and the instrumenters.
 *
 * `AsyncLocalStorage` gives each async execution tree its own "current
 * trail" slot — the TS analogue of the Python SDK's `contextvars`. Trails in
 * concurrent requests never see each other.
 *
 * The one-shot layer override rides in a mutable box inside the same store,
 * so `setLayer()` in one request cannot leak into another. Outside any
 * trail a module-level box is used as a best-effort fallback.
 */

import { AsyncLocalStorage } from "node:async_hooks";

import { LAYER_ALIASES, VALID_LAYERS, type Layer } from "./types.js";

// Imported types only — avoids a runtime cycle with trail.ts.
import type { Trail } from "./trail.js";

export interface LayerOverride {
  layer: Layer;
  stepType?: string;
}

interface ContextStore {
  trail: Trail | null;
  layerOverride: { value: LayerOverride | null };
}

const storage = new AsyncLocalStorage<ContextStore>();

/** Fallback override slot for code running outside any trail context. */
const globalOverrideBox: { value: LayerOverride | null } = { value: null };

const warnedLegacyLayers = new Set<string>();

/** Normalize `layer`, warning on legacy aliases; throws on unknown values. */
export function normalizeLayer(layer: string): Layer {
  const alias = LAYER_ALIASES[layer];
  if (alias !== undefined) {
    if (!warnedLegacyLayers.has(layer)) {
      warnedLegacyLayers.add(layer);
      console.warn(
        `[houndsight] layer="${layer}" is deprecated; use "${alias}" instead. ` +
          `Legacy layers will be removed in a future release.`,
      );
    }
    return alias;
  }
  if (!VALID_LAYERS.has(layer)) {
    throw new Error(
      `Invalid layer "${layer}". Must be one of: ${[...VALID_LAYERS].sort().join(", ")}`,
    );
  }
  return layer as Layer;
}

/** Run `fn` with `trail` bound as the current trail for its async subtree. */
export function runWithTrail<T>(trail: Trail, fn: () => T): T {
  const parent = storage.getStore();
  return storage.run(
    { trail, layerOverride: parent?.layerOverride ?? { value: null } },
    fn,
  );
}

/** The trail bound to the current async context, if any. */
export function currentTrail(): Trail | null {
  return storage.getStore()?.trail ?? null;
}

/**
 * Set a one-shot layer override consumed by the next instrumented call.
 *
 * ```ts
 * hs.setLayer("plan");
 * const plan = await openai.chat.completions.create(...); // → layer="plan"
 * const next = await openai.chat.completions.create(...); // → heuristic again
 * ```
 */
export function setLayer(layer: string, stepType?: string): void {
  const canonical = normalizeLayer(layer);
  const box = storage.getStore()?.layerOverride ?? globalOverrideBox;
  box.value = stepType !== undefined ? { layer: canonical, stepType } : { layer: canonical };
}

/** Return and clear the current override. Intended for instrumenters only. */
export function consumeLayerOverride(): LayerOverride | null {
  const box = storage.getStore()?.layerOverride ?? globalOverrideBox;
  const value = box.value;
  box.value = null;
  return value;
}
