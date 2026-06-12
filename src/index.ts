/**
 * houndsight — AI agent governance SDK for Node.
 *
 * ```ts
 * import * as hs from "houndsight";
 *
 * hs.init({ apiKey: process.env.HOUNDSIGHT_API_KEY!, agent: "sales-pipeline" });
 *
 * await hs.trail({ trigger: "user_message" }, async (t) => {
 *   const decision = await t.leash({
 *     actionName: "send_contract",
 *     actionSummary: "Email the Q2 contract to ACME",
 *     riskSignals: { amount_usd: 50_000 },
 *   });
 *   if (decision.approved) {
 *     await t.sniff({ name: "send_email", layer: "execute" }, async () => sendIt());
 *   }
 * });
 *
 * await hs.shutdown(); // drain telemetry before process exit
 * ```
 */

export { init, getClient, shutdown, HoundsightClient, _resetForTests } from "./client.js";
export type { InitOptions } from "./client.js";
export { trail, startTrail, currentTrail, Trail } from "./trail.js";
export type { TrailOptions } from "./trail.js";
export { Step } from "./step.js";
export type { SniffOptions } from "./step.js";
export { bark } from "./bark.js";
export type { BarkEvent } from "./bark.js";
export { collar } from "./collar.js";
export type { CollarOptions } from "./collar.js";
export { setLayer } from "./context.js";
export { costFor, hasPricing } from "./pricing.js";
export { instrumentOpenAI } from "./instrumentation/openai.js";
export type { OpenAILike } from "./instrumentation/openai.js";
export { instrumentAnthropic } from "./instrumentation/anthropic.js";
export type { AnthropicLike } from "./instrumentation/anthropic.js";
export {
  HoundsightError,
  ConfigurationError,
  TransportError,
  LeashError,
  InstrumentationError,
} from "./errors.js";
export type {
  Layer,
  Trigger,
  StepStatus,
  StepEvent,
  LeashDecision,
  LeashOptions,
  LeashOutcome,
} from "./types.js";
export { VERSION } from "./version.js";
