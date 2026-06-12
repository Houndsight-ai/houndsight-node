/**
 * Per-instance OpenAI instrumentation.
 *
 * Node has no safe post-import patch point (an SDK must not impose a custom
 * ESM loader), so instrumentation is explicit and per-instance:
 *
 * ```ts
 * import OpenAI from "openai";
 * import * as hs from "houndsight";
 *
 * const openai = hs.instrumentOpenAI(new OpenAI());
 * ```
 *
 * Every `chat.completions.create(...)` made **inside an active trail** then
 * records a step with model/token/cost attribution. Calls outside a trail
 * pass through untouched.
 *
 * Streaming: when `stream: true`, the returned stream's async iterator is
 * wrapped in place (object identity and other stream methods preserved);
 * the step ends when iteration completes or throws. Pass
 * `stream_options: { include_usage: true }` to get token/cost attribution
 * on streams; without it the model is still attributed so the server's
 * `observed_llm_calls` counter stays accurate.
 */

import { currentTrail } from "../context.js";
import { costFor } from "../pricing.js";
import type { Step } from "../step.js";
import { chatInput, INSTRUMENTED, resolveLayer, type ChatParams } from "./shared.js";

const PROVIDER = "openai";

interface UsageLike {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

interface ChatCompletionsLike {
  // Method syntax (not a property arrow) so parameter checking is bivariant:
  // real SDK clients and test fakes with narrower/wider param types both fit.
  create(params: ChatParams, ...rest: unknown[]): Promise<unknown>;
}

export interface OpenAILike {
  chat: { completions: ChatCompletionsLike };
  [INSTRUMENTED]?: boolean;
}

function recordResponse(step: Step, response: unknown, model: string): void {
  try {
    const usage = (response as { usage?: UsageLike } | null)?.usage;
    if (usage) {
      const promptT = Math.trunc(usage.prompt_tokens ?? 0);
      const completionT = Math.trunc(usage.completion_tokens ?? 0);
      const totalT = Math.trunc(usage.total_tokens ?? promptT + completionT);
      if (totalT) step.tokens(totalT);
      step.llm(model, promptT, completionT);
      const cost = costFor(PROVIDER, model, promptT, completionT);
      if (cost !== null) step.cost(cost);
    } else {
      step.llm(model);
    }
    step.output(summarize(response));
  } catch {
    // Attribution must never break the user's call.
  }
}

function summarize(response: unknown): unknown {
  if (typeof response !== "object" || response === null) return response;
  const r = response as Record<string, unknown>;
  return {
    id: r["id"] ?? null,
    model: r["model"] ?? null,
    choices: r["choices"] ?? null,
    usage: r["usage"] ?? null,
  };
}

function wrapStream(stream: unknown, step: Step, model: string): unknown {
  const iterable = stream as {
    [Symbol.asyncIterator]?: () => AsyncIterator<unknown>;
  };
  const originalFactory = iterable[Symbol.asyncIterator]?.bind(stream);
  if (!originalFactory) {
    // Not iterable — close the step with what we know.
    step.llm(model);
    step.output({ streamed: true, tokens: null });
    step.end();
    return stream;
  }

  let closed = false;
  let aggregated: UsageLike | null = null;

  const closeStep = (err?: unknown): void => {
    if (closed) return;
    closed = true;
    try {
      if (aggregated) {
        const promptT = Math.trunc(aggregated.prompt_tokens ?? 0);
        const completionT = Math.trunc(aggregated.completion_tokens ?? 0);
        const totalT = Math.trunc(aggregated.total_tokens ?? promptT + completionT);
        if (totalT) step.tokens(totalT);
        step.llm(model, promptT, completionT);
        const cost = costFor(PROVIDER, model, promptT, completionT);
        if (cost !== null) step.cost(cost);
        step.output({ streamed: true, tokens: totalT || null });
      } else {
        // No usage chunk arrived. The user can opt in with
        // stream_options: { include_usage: true }. Still attribute the
        // model so the server's observed_llm_calls counter increments.
        step.llm(model);
        step.emitEvent("log_emitted", {
          warning: "stream had no usage chunk",
          hint: "pass stream_options: { include_usage: true } to enable cost attribution",
        });
        step.output({ streamed: true, tokens: null });
      }
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
          if (!result.done) {
            const usage = (result.value as { usage?: UsageLike } | null)?.usage;
            if (usage) aggregated = usage;
          } else {
            closeStep();
          }
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
 * Instrument an OpenAI client instance in place. Idempotent. Returns the
 * same instance for chaining.
 */
export function instrumentOpenAI<T extends OpenAILike>(client: T): T {
  if (client[INSTRUMENTED]) return client;
  const completions = client.chat?.completions;
  if (!completions || typeof completions.create !== "function") {
    throw new TypeError(
      "instrumentOpenAI expects an OpenAI client with chat.completions.create",
    );
  }
  const original = completions.create.bind(completions);

  completions.create = async function instrumentedCreate(
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
