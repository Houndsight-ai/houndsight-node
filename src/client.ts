/**
 * The Houndsight singleton client and module-level entry points.
 *
 * ```ts
 * import * as hs from "houndsight";
 *
 * hs.init({ apiKey: "sk-hnd-...", agent: "sales-pipeline" });
 *
 * await hs.trail({ trigger: "user_message", payload: { text: "Q2 forecast" } }, async (t) => {
 *   await t.sniff({ name: "salesforce_query", layer: "execute" }, async (s) => {
 *     s.cost(0.0001);
 *     s.output({ deal_count: 17 });
 *   });
 *   t.setOutput("Posted forecast");
 * });
 * ```
 *
 * The client owns one interval-driven flusher and the configured fetch.
 * Calling {@link init} more than once replaces the singleton; the previous
 * client's transport is shut down with a short deadline.
 */

import { API_KEY_PREFIX, resolveConfig, type Config, type ConfigOptions } from "./config.js";
import { ConfigurationError, HoundsightError } from "./errors.js";
import {
  PRIORITY_NORMAL,
  Transport,
  type Priority,
  type TransportLogger,
} from "./transport.js";
import type { IngestEvent } from "./types.js";

export interface InitOptions extends ConfigOptions {
  apiKey: string;
}

function makeLogger(debug: boolean): TransportLogger {
  return {
    debug: debug ? (...args) => console.debug("[houndsight]", ...args) : () => {},
    info: (...args) => console.info("[houndsight]", ...args),
    warn: (...args) => console.warn("[houndsight]", ...args),
  };
}

/** Process-wide owner of config, transport, and the flusher timer. */
export class HoundsightClient {
  readonly config: Config;
  readonly transport: Transport;
  readonly logger: TransportLogger;

  constructor(options: InitOptions) {
    if (typeof options.apiKey !== "string" || !options.apiKey.startsWith(API_KEY_PREFIX)) {
      throw new ConfigurationError(
        `apiKey must be a string starting with "${API_KEY_PREFIX}"; got ${typeof options.apiKey}`,
      );
    }
    this.config = resolveConfig(options);
    this.logger = makeLogger(this.config.debug);
    this.transport = new Transport({
      apiKey: options.apiKey,
      ingestUrl: this.config.ingestUrl,
      flushIntervalMs: this.config.flushIntervalMs,
      flushAtSize: this.config.flushAtSize,
      maxBuffer: this.config.maxBuffer,
      fetchImpl: this.config.fetchImpl,
      logger: this.logger,
    });
    this.transport.start();
    // Verify ingest connectivity within 5 s of init. Loud but non-fatal.
    this.transport.ping(5_000);
  }

  get apiKey(): string {
    return this.config.apiKey as string;
  }

  get agent(): string | undefined {
    return this.config.agent;
  }

  get pack(): string | undefined {
    return this.config.pack;
  }

  get ingestUrl(): string {
    return this.config.ingestUrl;
  }

  get fetchImpl(): typeof fetch {
    return this.config.fetchImpl;
  }

  /** Enqueue `payload` on the background transport. Non-blocking; never throws. */
  emit(payload: IngestEvent, priority: Priority = PRIORITY_NORMAL): void {
    this.transport.enqueue(payload, priority);
  }

  /** Resolve when the buffer drains or `timeoutMs` elapses. */
  flush(timeoutMs = 5_000): Promise<void> {
    return this.transport.flush(timeoutMs);
  }

  /** Stop the background flusher, draining best-effort. */
  shutdown(timeoutMs = 5_000): Promise<void> {
    return this.transport.shutdown(timeoutMs);
  }
}

let globalClient: HoundsightClient | null = null;

/**
 * Initialize and store the global {@link HoundsightClient}.
 *
 * Unlike interpreter-managed runtimes, Node gives no reliable async work
 * window at exit — call `await hs.shutdown()` (or `client.flush()`) before
 * your process ends to avoid losing tail events.
 */
export function init(options: InitOptions): HoundsightClient {
  if (globalClient !== null) {
    void globalClient.shutdown(1_000).catch(() => {});
  }
  globalClient = new HoundsightClient(options);
  return globalClient;
}

/** Return the singleton client; throws if {@link init} was never called. */
export function getClient(): HoundsightClient {
  if (globalClient === null) {
    throw new HoundsightError("Call hs.init({ apiKey: ... }) first.");
  }
  return globalClient;
}

/** Flush and stop the global client (call before process exit). */
export async function shutdown(timeoutMs = 5_000): Promise<void> {
  if (globalClient !== null) {
    await globalClient.shutdown(timeoutMs);
  }
}

/** Drop the singleton without throwing. Tests only. */
export function _resetForTests(): void {
  if (globalClient !== null) {
    void globalClient.shutdown(100).catch(() => {});
  }
  globalClient = null;
}
