/**
 * Shared test harness.
 *
 * `setup()` initializes the SDK with an injected fetch that:
 *  - records every ingest POST body and answers 200 `{results: []}`
 *  - routes checkLeash POST/GET calls to a per-test handler
 *
 * `events()` flushes the transport and returns all captured ingest events
 * (the connectivity `ping` is filtered out).
 */

import { _resetForTests, getClient, init } from "../src/index.js";
import { LEASH_TIMING } from "../src/leash.js";
import { RETRY_DELAYS_MS } from "../src/transport.js";

export const VALID_KEY = "sk-hnd-test";
export const INGEST_URL = "http://ingest.invalid/api/functions/ingestAgentRun";
export const LEASH_URL = "http://ingest.invalid/api/functions/checkLeash";

export type LeashHandler = (
  url: URL,
  init: RequestInit | undefined,
  callIndex: number,
) => Response | Promise<Response>;

export interface Harness {
  /** Raw ingest request bodies, in order. */
  ingestBodies: Array<{ events: Array<Record<string, unknown>> }>;
  /** Every request the mock fetch saw (method + url). */
  requests: Array<{ method: string; url: string }>;
  /** Leash-endpoint calls only (subset of requests). */
  leashCalls: Array<{ method: string; url: string }>;
  /** Flush the transport, then return all ingest events (ping filtered). */
  events: () => Promise<Array<Record<string, unknown>>>;
  /** Convenience: events filtered by action. */
  byAction: (action: string) => Promise<Array<Record<string, unknown>>>;
}

export function json(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

/** Initialize the SDK against an in-process fetch mock. */
export function setup(leashHandler?: LeashHandler): Harness {
  _resetForTests();
  shrinkTimings();

  const ingestBodies: Harness["ingestBodies"] = [];
  const requests: Harness["requests"] = [];
  const leashCalls: Harness["leashCalls"] = [];
  let leashIndex = 0;

  const fetchImpl: typeof fetch = async (input, requestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (requestInit?.method ?? "GET").toUpperCase();
    requests.push({ method, url: url.toString() });

    if (url.pathname.endsWith("/ingestAgentRun")) {
      const raw = typeof requestInit?.body === "string" ? requestInit.body : "{}";
      try {
        ingestBodies.push(JSON.parse(raw));
      } catch {
        ingestBodies.push({ events: [] });
      }
      return json(200, { results: [] });
    }
    if (url.pathname.endsWith("/checkLeash")) {
      leashCalls.push({ method, url: url.toString() });
      if (!leashHandler) return json(500, { error: "no leash handler installed" });
      return leashHandler(url, requestInit, leashIndex++);
    }
    return json(404, { error: `unrouted url ${url.toString()}` });
  };

  init({
    apiKey: VALID_KEY,
    ingestUrl: INGEST_URL,
    fetchImpl,
    flushIntervalMs: 10,
    agent: undefined as unknown as string, // most tests pass agent per-trail
  });

  const events = async (): Promise<Array<Record<string, unknown>>> => {
    await getClient().flush(2_000);
    const all: Array<Record<string, unknown>> = [];
    for (const body of ingestBodies) {
      for (const ev of body.events ?? []) {
        if (ev["action"] !== "ping") all.push(ev);
      }
    }
    return all;
  };

  return {
    ingestBodies,
    requests,
    leashCalls,
    events,
    byAction: async (action) => (await events()).filter((e) => e["action"] === action),
  };
}

/** Make retries and polling fast enough for unit tests. */
export function shrinkTimings(): void {
  RETRY_DELAYS_MS.splice(0, RETRY_DELAYS_MS.length, 5, 5, 5);
  LEASH_TIMING.initialPostTimeoutMs = 1_000;
  LEASH_TIMING.pollHttpTimeoutMs = 1_000;
  LEASH_TIMING.pollBaseIntervalMs = 10;
  LEASH_TIMING.pollJitterMs = 2;
}

export function teardown(): void {
  _resetForTests();
}
