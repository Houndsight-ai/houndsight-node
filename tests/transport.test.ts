import { afterEach, describe, expect, it } from "vitest";

import {
  EventBuffer,
  MAX_REQUEUES,
  PRIORITY_LEASH,
  REQUEUE_KEY,
  RETRY_DELAYS_MS,
  Transport,
  retryAfterMs,
} from "../src/transport.js";
import { json, shrinkTimings } from "./helpers.js";

function makeTransport(
  handler: (url: string, init: RequestInit | undefined, call: number) => Response,
): { transport: Transport; calls: Array<{ url: string; body: unknown }> } {
  shrinkTimings();
  const calls: Array<{ url: string; body: unknown }> = [];
  let n = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ url, body });
    return handler(url, init, n++);
  };
  const transport = new Transport({
    apiKey: "sk-hnd-test",
    ingestUrl: "http://ingest.invalid/api/functions/ingestAgentRun",
    flushIntervalMs: 60_000, // tests drive flushBatch() directly
    flushAtSize: 1_000,
    maxBuffer: 100,
    fetchImpl,
    logger: { debug: () => {}, info: () => {}, warn: () => {} },
  });
  return { transport, calls };
}

afterEach(() => {
  // restore in case a test mutated further
  RETRY_DELAYS_MS.splice(0, RETRY_DELAYS_MS.length, 5, 5, 5);
});

describe("retryAfterMs", () => {
  it("parses delta-seconds, caps, and rejects garbage", () => {
    expect(retryAfterMs(new Headers())).toBeNull();
    expect(retryAfterMs(new Headers({ "Retry-After": "2" }))).toBe(2_000);
    expect(retryAfterMs(new Headers({ "Retry-After": "0" }))).toBe(0);
    expect(retryAfterMs(new Headers({ "Retry-After": "9999" }))).toBe(30_000);
    expect(retryAfterMs(new Headers({ "Retry-After": "soon" }))).toBeNull();
    // HTTP-date in the past → negative → null.
    expect(retryAfterMs(new Headers({ "Retry-After": "Wed, 21 Oct 2015 07:28:00 GMT" }))).toBeNull();
    // HTTP-date in the near future → positive, capped.
    const future = new Date(Date.now() + 3_000).toUTCString();
    const ms = retryAfterMs(new Headers({ "Retry-After": future }));
    expect(ms).not.toBeNull();
    expect(ms!).toBeGreaterThan(0);
    expect(ms!).toBeLessThanOrEqual(30_000);
  });
});

describe("Transport retry semantics", () => {
  it("retries 429 instead of dropping", async () => {
    const { transport, calls } = makeTransport((_url, _init, call) =>
      call === 0 ? json(429, { error: "rate limited" }) : json(200, { results: [] }),
    );
    transport.buffer.put({ action: "step_complete", n: 1 });
    await transport.flushBatch();
    expect(calls.length).toBe(2);
    expect(transport.buffer.length).toBe(0);
  });

  it("retries 408", async () => {
    const { transport, calls } = makeTransport((_url, _init, call) =>
      call === 0 ? json(408, {}) : json(200, { results: [] }),
    );
    transport.buffer.put({ action: "bark" });
    await transport.flushBatch();
    expect(calls.length).toBe(2);
  });

  it("drops non-retryable 4xx after one attempt", async () => {
    const { transport, calls } = makeTransport(() => json(400, { error: "bad request" }));
    transport.buffer.put({ action: "step_complete" });
    await transport.flushBatch();
    expect(calls.length).toBe(1);
    expect(transport.buffer.length).toBe(0);
  });

  it("honors a small Retry-After over a large configured backoff", async () => {
    RETRY_DELAYS_MS.splice(0, RETRY_DELAYS_MS.length, 5_000, 5_000, 5_000);
    const { transport, calls } = makeTransport((_url, _init, call) =>
      call === 0
        ? json(429, {}, { "Retry-After": "0" })
        : json(200, { results: [] }),
    );
    transport.buffer.put({ action: "bark" });
    const started = Date.now();
    await transport.flushBatch();
    const elapsed = Date.now() - started;
    expect(calls.length).toBe(2);
    expect(elapsed).toBeLessThan(1_000);
  });

  it("requeues leash events on exhausted retries; drops normal ones", async () => {
    const { transport } = makeTransport(() => json(503, {}));
    transport.buffer.put({ action: "step_complete", kind: "normal" });
    transport.buffer.put({ action: "leash_decision", kind: "leash" }, PRIORITY_LEASH);
    await transport.flushBatch();

    const remaining = transport.buffer.drainItems();
    expect(remaining.length).toBe(1);
    expect(remaining[0]!.payload["kind"]).toBe("leash");
    expect(remaining[0]!.payload[REQUEUE_KEY]).toBe(1);
    expect(remaining[0]!.priority).toBe(PRIORITY_LEASH);
  });

  it("bounds the requeue counter", async () => {
    const { transport } = makeTransport(() => json(503, {}));
    transport.buffer.put(
      { action: "leash_decision", [REQUEUE_KEY]: MAX_REQUEUES },
      PRIORITY_LEASH,
    );
    await transport.flushBatch();
    expect(transport.buffer.length).toBe(0);
  });

  it("strips the requeue counter from the wire", async () => {
    const { transport, calls } = makeTransport(() => json(200, { results: [] }));
    transport.buffer.put(
      { action: "leash_decision", [REQUEUE_KEY]: 2, x: 1 },
      PRIORITY_LEASH,
    );
    await transport.flushBatch();
    const sent = (calls[0]!.body as { events: Array<Record<string, unknown>> }).events[0]!;
    expect(REQUEUE_KEY in sent).toBe(false);
    expect(sent["x"]).toBe(1);
  });

  it("sends the houndsight- User-Agent and Bearer auth", async () => {
    let seenHeaders: Record<string, string> = {};
    const fetchImpl: typeof fetch = async (_input, init) => {
      seenHeaders = (init?.headers ?? {}) as Record<string, string>;
      return json(200, { results: [] });
    };
    const transport = new Transport({
      apiKey: "sk-hnd-test",
      ingestUrl: "http://ingest.invalid/x",
      flushIntervalMs: 60_000,
      flushAtSize: 1_000,
      maxBuffer: 10,
      fetchImpl,
      logger: { debug: () => {}, info: () => {}, warn: () => {} },
    });
    transport.buffer.put({ action: "bark" });
    await transport.flushBatch();
    expect(seenHeaders["User-Agent"]).toMatch(/^houndsight-node\//);
    expect(seenHeaders["Authorization"]).toBe("Bearer sk-hnd-test");
  });
});

describe("EventBuffer eviction", () => {
  it("evicts oldest non-leash first at capacity", () => {
    const buffer = new EventBuffer(3);
    buffer.put({ action: "leash_request", i: 0 }, PRIORITY_LEASH);
    buffer.put({ action: "bark", i: 1 });
    buffer.put({ action: "bark", i: 2 });
    buffer.put({ action: "bark", i: 3 }); // evicts i=1, not the leash event
    const items = buffer.drainItems();
    expect(items.map((it) => it.payload["i"])).toEqual([0, 2, 3]);
    expect(buffer.dropped).toBe(1);
  });

  it("splits batches by count", () => {
    const buffer = new EventBuffer(500);
    for (let i = 0; i < 250; i += 1) buffer.put({ action: "bark", i });
    expect(buffer.drainItems().length).toBe(100);
    expect(buffer.drainItems().length).toBe(100);
    expect(buffer.drainItems().length).toBe(50);
  });
});
