/**
 * Per-instance Anthropic instrumentation.
 *
 * ```ts
 * import Anthropic from "@anthropic-ai/sdk";
 * import * as hs from "houndsight";
 *
 * const anthropic = hs.instrumentAnthropic(new Anthropic());
 * ```
 *
 * Every `messages.create(...)` made **inside an active trail** records a
 * step with model/token/cost attribution. Calls outside a trail pass
 * through untouched.
 *
 * Streaming: when `stream: true`, the stream's async iterator is wrapped in
 * place; usage is aggregated from `message_start` (input tokens) and
 * `message_delta` (output tokens) events, and the step ends when iteration
 * completes or throws.
 */

import { currentTrail } from "../context.js";
import { costFor } from "../pricing.js";
import type { Step } from "../step.js";
import { chatInput, INSTRUMENTED, resolveLayer, type ChatParams } from "./shared.js";

const PROVIDER = "anthropic";

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
}

interface MessagesLike {
  // Method syntax (not a property arrow) so parameter checking is bivariant:
  // real SDK clients and test fakes with narrower/wider param types both fit.
  create(params: ChatParams, ...rest: unknown[]): Promise<unknown>;
}

export interface AnthropicLike {
  messages: MessagesLike;
  [INSTRUMENTED]?: boolean;
}

function extractUsage(usage: AnthropicUsage | undefined | null): [number, number] {
  return [Math.trunc(usage?.input_tokens ?? 0), Math.trunc(usage?.output_tokens ?? 0)];
}

function attribute(step: Step, model: string, promptT: number, completionT: number): void {
  const total = promptT + completionT;
  if (total) {
    step.tokens(total);
    const cost = costFor(PROVIDER, model, promptT, completionT);
    if (cost !== null) step.cost(cost);
  }
  // Attribute the model even without usage so observed_llm_calls increments.
  step.llm(model, promptT || null, completionT || null);
}

function recordResponse(step: Step, response: unknown, model: string): void {
  try {
    const usage = (response as { usage?: AnthropicUsage } | null)?.usage;
    const [promptT, completionT] = extractUsage(usage);
    attribute(step, model, promptT, completionT);
    const r = (response ?? {}) as Record<string, unknown>;
    step.output({
      id: r["id"] ?? null,
      model: r["model"] ?? null,
      content: r["content"] ?? null,
      stop_reason: r["stop_reason"] ?? null,
      usage: r["usage"] ?? null,
    });
  } catch {
    // Attribution must never break the user's call.
  }
}

function wrapStream(stream: unknown, step: Step, model: string): unknown {
  const iterable = stream as {
    [Symbol.asyncIterator]?: () => AsyncIterator<unknown>;
  };
  const originalFactory = iterable[Symbol.asyncIterator]?.bind(stream);
  if (!originalFactory) {
    attribute(step, model, 0, 0);
    step.output({ streamed: true, tokens: null });
    step.end();
    return stream;
  }

  let closed = false;
  let promptTokens = 0;
  let completionTokens = 0;

  const observe = (event: unknown): void => {
    if (typeof event !== "object" || event === null) return;
    const e = event as Record<string, unknown>;
    if (e["type"] === "message_start") {
      const message = e["message"] as { usage?: AnthropicUsage } | undefined;
      const [p, c] = extractUsage(message?.usage);
      promptTokens = p || promptTokens;
      completionTokens = c || completionTokens;
    } else if (e["type"] === "message_delta") {
      const [, c] = extractUsage(e["usage"] as AnthropicUsage | undefined);
      if (c) completionTokens = c;
    }
  };

  const closeStep = (err?: unknown): void => {
    if (closed) return;
    closed = true;
    try {
      attribute(step, model, promptTokens, completionTokens);
      step.output({ streamed: true, tokens: promptTokens + completionTokens || null });
    } catch {
      // never break the stream consumer
    }
    step.end(err);
  };

  iterable[Symbol.asyncIterator] = function instrumentedIterator(): AsyncIterator<unknown> {
    const inner = originalFactory();
    return {
      async next(): Promise<IteratorResult<unknown>> {
        try {
          const result = await inner.next();
          if (!result.done) observe(result.value);
          else closeStep();
          return result;
        } catch (err) {
          closeStep(err);
          throw err;
        }
      },
      async return(value?: unknown): Promise<IteratorResult<unknown>> {
        closeStep();
        if (inner.return) return inner.return(value);
        return { done: true, value };
      },
      async throw(err?: unknown): Promise<IteratorResult<unknown>> {
        closeStep(err);
        if (inner.throw) return inner.throw(err);
        throw err;
      },
    };
  };
  return stream;
}

/**
 * Instrument an Anthropic client instance in place. Idempotent. Returns
 * the same instance for chaining.
 */
export function instrumentAnthropic<T extends AnthropicLike>(client: T): T {
  if (client[INSTRUMENTED]) return client;
  const messages = client.messages;
  if (!messages || typeof messages.create !== "function") {
    throw new TypeError("instrumentAnthropic expects an Anthropic client with messages.create");
  }
  const original = messages.create.bind(messages);

  messages.create = async function instrumentedCreate(
    params: ChatParams,
    ...rest: unknown[]
  ): Promise<unknown> {
    const trail = currentTrail();
    if (trail === null) return original(params, ...rest);

    const model = String(params?.model ?? "unknown");
    const isStream = Boolean(params?.stream);
    const [layer, stepType] = resolveLayer(params ?? {});

    const step = trail.startSniff({ name: `${PROVIDER}/${model}`, layer, stepType });
    try {
      step.input(chatInput(params ?? {}));
      const response = await original(params, ...rest);
      if (isStream) return wrapStream(response, step, model);
      recordResponse(step, response, model);
      step.end();
      return response;
    } catch (err) {
      step.end(err);
      throw err;
    }
  };

  client[INSTRUMENTED] = true;
  return client;
}
