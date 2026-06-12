/**
 * Runtime configuration for the Houndsight SDK.
 *
 * Environment variables
 * ---------------------
 * - `HOUNDSIGHT_API_KEY`    — required ingest API key (must start with `sk-hnd-`)
 * - `HOUNDSIGHT_INGEST_URL` — ingest endpoint override
 * - `HOUNDSIGHT_DEBUG`      — verbose logging when truthy
 */

/** Default ingest endpoint (the `ingestAgentRun` Base44 function). */
export const DEFAULT_INGEST_URL = "https://houndsight.ai/api/functions/ingestAgentRun";

/** Prefix every valid API key must start with. */
export const API_KEY_PREFIX = "sk-hnd-";

/** Background flusher cadence (ms). */
export const DEFAULT_FLUSH_INTERVAL_MS = 1_000;

/** Number of buffered events that triggers an early flush. */
export const DEFAULT_FLUSH_AT_SIZE = 100;

/** In-memory buffer capacity before overflow drops kick in. */
export const DEFAULT_MAX_BUFFER = 10_000;

function truthy(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes((value ?? "").trim().toLowerCase());
}

function env(name: string): string | undefined {
  // Guarded for non-Node runtimes (edge workers, browsers in tests).
  if (typeof process !== "undefined" && process.env) return process.env[name];
  return undefined;
}

export interface ConfigOptions {
  apiKey?: string;
  ingestUrl?: string;
  agent?: string;
  pack?: string;
  flushIntervalMs?: number;
  flushAtSize?: number;
  maxBuffer?: number;
  debug?: boolean;
  /** Injectable fetch for tests / custom transports. Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
}

export interface Config {
  apiKey: string | undefined;
  ingestUrl: string;
  agent: string | undefined;
  pack: string | undefined;
  flushIntervalMs: number;
  flushAtSize: number;
  maxBuffer: number;
  debug: boolean;
  fetchImpl: typeof fetch;
}

export function resolveConfig(options: ConfigOptions = {}): Config {
  return {
    apiKey: options.apiKey ?? env("HOUNDSIGHT_API_KEY"),
    ingestUrl: options.ingestUrl ?? env("HOUNDSIGHT_INGEST_URL") ?? DEFAULT_INGEST_URL,
    agent: options.agent,
    pack: options.pack,
    flushIntervalMs: options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS,
    flushAtSize: options.flushAtSize ?? DEFAULT_FLUSH_AT_SIZE,
    maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
    debug: options.debug ?? truthy(env("HOUNDSIGHT_DEBUG")),
    fetchImpl: options.fetchImpl ?? globalThis.fetch.bind(globalThis),
  };
}
