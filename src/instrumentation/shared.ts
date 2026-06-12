/**
 * Shared helpers for the per-instance instrumenters.
 *
 * Layer resolution honors a one-shot `setLayer()` override first, then
 * falls back to a planning-vs-execute heuristic: calls that carry tool
 * definitions, or whose system prompt reads like an agent/planner prompt,
 * are classified `plan`; plain completions are `execute`.
 */

import { consumeLayerOverride } from "../context.js";
import type { Layer } from "../types.js";

const PLAN_KEYWORDS = [
  "you are a planner",
  "you are an agent",
  "decide which",
  "step by step",
  "plan the",
  "create a plan",
  "reasoning steps",
];

export interface ChatParams {
  model?: unknown;
  messages?: unknown;
  system?: unknown; // anthropic-style top-level system prompt
  tools?: unknown;
  functions?: unknown;
  tool_choice?: unknown;
  temperature?: unknown;
  max_tokens?: unknown;
  stream?: unknown;
}

function systemTexts(params: ChatParams): string[] {
  const out: string[] = [];
  if (typeof params.system === "string") out.push(params.system);
  if (Array.isArray(params.messages)) {
    for (const msg of params.messages) {
      if (
        typeof msg === "object" &&
        msg !== null &&
        (msg as Record<string, unknown>)["role"] === "system" &&
        typeof (msg as Record<string, unknown>)["content"] === "string"
      ) {
        out.push((msg as Record<string, unknown>)["content"] as string);
      }
    }
  }
  return out;
}

export function looksLikePlanning(params: ChatParams): boolean {
  if (params.tools || params.functions) return true;
  for (const text of systemTexts(params)) {
    const lower = text.toLowerCase();
    if (PLAN_KEYWORDS.some((kw) => lower.includes(kw))) return true;
  }
  return false;
}

/** Return `[layer, stepType]`, honoring a one-shot `setLayer()` override. */
export function resolveLayer(params: ChatParams): [Layer, string] {
  const override = consumeLayerOverride();
  if (override !== null) {
    const stepType =
      override.stepType ?? (override.layer === "plan" ? "llm_reasoning" : "api_call");
    return [override.layer, stepType];
  }
  if (looksLikePlanning(params)) return ["plan", "llm_reasoning"];
  return ["execute", "api_call"];
}

/** Stable summary of chat-call params recorded as the step input. */
export function chatInput(params: ChatParams): Record<string, unknown> {
  return {
    model: params.model ?? null,
    messages: params.messages ?? null,
    tools: params.tools ?? null,
    tool_choice: params.tool_choice ?? null,
    temperature: params.temperature ?? null,
    max_tokens: params.max_tokens ?? null,
    stream: Boolean(params.stream),
  };
}

/** Marker preventing double instrumentation of the same client instance. */
export const INSTRUMENTED = Symbol.for("houndsight.instrumented");
