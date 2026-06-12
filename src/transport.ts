/**
 * Buffered async HTTP transport for the Houndsight SDK.
 *
 * Design
 * ------
 * - Events are added to an in-memory {@link EventBuffer} via
 *   {@link Transport.enqueue}. `enqueue` never throws and never awaits the
 *   network.
 * - A single interval timer (unref'd — it never keeps the process alive)
 *   drains the buffer every `flushIntervalMs`, or sooner when the buffer
 *   reaches `flushAtSize`.
 * - Each batched POST sends up to **100 events**, capped at **~1 MB** of
 *   JSON; larger backlogs split across batches.
 * - Failures retry with exponential backoff (**1 s / 2 s / 4 s**, max 3
 *   attempts). **429** (rate limit) and **408** are transient and retried —
 *   honoring a server `Retry-After` header (delta-seconds or HTTP-date,
 *   capped at 30 s). Every other 4xx is a contract error: dropped with one
 *   WARNING. After the final failed attempt, **leash-priority events are
 *   requeued** (up to 3 cycles) so compliance audit data survives transient
 *   outages; other events are dropped. The SDK never throws through user
 *   code.
 * - `shutdown()` stops the timer and best-effort drains within a deadline.
 *
 * Buffer overflow
 * ---------------
 * At capacity the oldest **non-leash** event is evicted first. Leash events
 * (`leash_request` / `leash_decision`) carry compliance-grade audit data and
 * are evicted only as a last resort.
 */

import { USER_AGENT } from "./version.js";
import type { IngestEvent } from "./types.js";

export const PRIORITY_NORMAL = "normal";
export const PRIORITY_LEASH = "leash";
export type Priority = typeof PRIORITY_NORMAL | typeof PRIORITY_LEASH;

/** Hard cap on the number of events in any single ingest POST. */
const MAX_BATCH_COUNT = 100;

/** Hard cap on the JSON body size of any single ingest POST (~1 MB). */
const MAX_BATCH_BYTES = 1024 * 1024;

/** Retry backoff schedule (ms). Length determines the max attempt count. Mutable for tests. */
export const RETRY_DELAYS_MS: number[] = [1_000, 2_000, 4_000];

/** 4xx statuses that are transient and must be retried, not dropped. */
const RETRYABLE_4XX = new Set([408, 429]);

/** Ceiling applied to a server-provided Retry-After delay (ms). */
const RETRY_AFTER_CAP_MS = 30_000;

/** Internal payload key counting requeue cycles. Stripped from the wire. */
export const REQUEUE_KEY = "__hs_requeue";

/** Max times a leash-priority event is requeued after exhausted retries. */
export const MAX_REQUEUES = 3;

export interface TransportLogger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
}

const defaultLogger: TransportLogger = {
  debug: () => {},
  info: (...args) => console.info("[houndsight]", ...args),
  warn: (...args) => console.warn("[houndsight]", ...args),
};

function truncateBody(text: unknown, limit = 200): string {
  if (typeof text !== "string") return String(text).slice(0, limit);
  const oneLine = text.trim().replace(/\n/g, " ");
  if (oneLine.length > limit) return oneLine.slice(0, limit) + "...<truncated>";
  return oneLine || "<empty>";
}

/**
 * Parse a `Retry-After` header into milliseconds, capped and non-negative.
 * Supports both delta-seconds and HTTP-date forms; returns null when absent
 * or unparseable (caller falls back to the static backoff schedule).
 */
export function retryAfterMs(headers: Headers): number | null {
  const raw = headers.get("Retry-After");
  if (!raw) return null;
  let ms: number;
  const asNumber = Number(raw);
  if (Number.isFinite(asNumber)) {
    ms = asNumber * 1000;
  } else {
    const asDate = Date.parse(raw);
    if (Number.isNaN(asDate)) return null;
    ms = asDate - Date.now();
  }
  if (ms < 0) return null;
  return Math.min(ms, RETRY_AFTER_CAP_MS);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    // Don't keep the process alive for a backoff sleep.
    (t as { unref?: () => void }).unref?.();
    function done() {
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      done();
    });
  });
}

type BufferItem = { priority: Priority; payload: IngestEvent };

/**
 * A FIFO queue of `{priority, payload}` items that, when full, evicts the
 * oldest *non-leash* event in preference to dropping leash events.
 */
export class EventBuffer {
  private items: BufferItem[] = [];
  private droppedCount = 0;

  constructor(private readonly maxSize: number) {}

  put(payload: IngestEvent, priority: Priority = PRIORITY_NORMAL): void {
    if (this.items.length >= this.maxSize) this.dropOne();
    this.items.push({ priority, payload });
  }

  private dropOne(): void {
    const idx = this.items.findIndex((it) => it.priority !== PRIORITY_LEASH);
    if (idx !== -1) {
      this.items.splice(idx, 1);
      this.droppedCount += 1;
      return;
    }
    if (this.items.length > 0) {
      this.items.shift();
      this.droppedCount += 1;
    }
  }

  /** Remove and return up to `maxCount` items, bounded by `maxBytes` of JSON. */
  drainItems(maxCount = MAX_BATCH_COUNT, maxBytes = MAX_BATCH_BYTES): BufferItem[] {
    const out: BufferItem[] = [];
    let curBytes = 0;
    while (this.items.length > 0 && out.length < maxCount) {
      const head = this.items[0]!;
      let size: number;
      try {
        size = JSON.stringify(head.payload).length;
      } catch {
        size = 1024; // conservative estimate for un-serializable payloads
      }
      if (out.length > 0 && curBytes + size > maxBytes) break;
      this.items.shift();
      out.push(head);
      curBytes += size;
    }
    return out;
  }

  get length(): number {
    return this.items.length;
  }

  get dropped(): number {
    return this.droppedCount;
  }
}

export interface TransportOptions {
  apiKey: string;
  ingestUrl: string;
  flushIntervalMs: number;
  flushAtSize: number;
  maxBuffer: number;
  fetchImpl: typeof fetch;
  logger?: TransportLogger;
}

/** Timer-driven HTTP transport with buffered batching and retry. */
export class Transport {
  readonly buffer: EventBuffer;
  readonly ingestUrl: string;

  private readonly apiKey: string;
  private readonly flushIntervalMs: number;
  private readonly flushAtSize: number;
  private readonly fetchImpl: typeof fetch;
  private readonly logger: TransportLogger;

  private timer: ReturnType<typeof setInterval> | null = null;
  private flushing: Promise<void> | null = null;
  private stopped = false;
  private readonly stopController = new AbortController();

  // First-ingest visibility: each flag flips at most once.
  private firstIngestAttempted = false;
  private firstIngestSucceeded = false;
  private pingStarted = false;

  constructor(options: TransportOptions) {
    this.apiKey = options.apiKey;
    this.ingestUrl = options.ingestUrl;
    this.flushIntervalMs = options.flushIntervalMs;
    this.flushAtSize = options.flushAtSize;
    this.fetchImpl = options.fetchImpl;
    this.logger = options.logger ?? defaultLogger;
    this.buffer = new EventBuffer(options.maxBuffer);
  }

  // ------------------------------------------------------------ lifecycle
  start(): void {
    if (this.timer !== null || this.stopped) return;
    this.timer = setInterval(() => {
      void this.flushOnce();
    }, this.flushIntervalMs);
    // Never keep the process alive just to flush telemetry.
    (this.timer as { unref?: () => void }).unref?.();
  }

  /** Stop the flusher and best-effort drain remaining events. */
  async shutdown(timeoutMs = 5_000): Promise<void> {
    this.stopped = true;
    this.stopController.abort();
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    const deadline = Date.now() + timeoutMs;
    while (this.buffer.length > 0 && Date.now() < deadline) {
      await this.flushBatch();
    }
  }

  // ------------------------------------------------------------- enqueue
  /** Add `payload` to the buffer. Never throws; never awaits the network. */
  enqueue(payload: IngestEvent, priority: Priority = PRIORITY_NORMAL): void {
    this.start();
    this.buffer.put(payload, priority);
    if (this.buffer.length >= this.flushAtSize) {
      void this.flushOnce();
    }
  }

  // --------------------------------------------------------------- flush
  /** Block the caller until the buffer drains or `timeoutMs` elapses. */
  async flush(timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.buffer.length > 0 && Date.now() < deadline) {
      await this.flushBatch();
      if (this.buffer.length > 0) await sleep(20);
    }
  }

  /** Serialize concurrent flush triggers onto one in-flight drain loop. */
  private flushOnce(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = (async () => {
      try {
        while (this.buffer.length > 0) {
          await this.flushBatch();
          if (this.buffer.length < this.flushAtSize) break;
        }
      } finally {
        this.flushing = null;
      }
    })();
    return this.flushing;
  }

  /** POST one batch with retry. Exposed for tests. */
  async flushBatch(): Promise<void> {
    const items = this.buffer.drainItems();
    if (items.length === 0) return;

    // Wire batch: strip the internal requeue counter before POSTing.
    const batch: IngestEvent[] = items.map(({ payload }) => {
      if (REQUEUE_KEY in payload) {
        const { [REQUEUE_KEY]: _omit, ...rest } = payload;
        return rest as IngestEvent;
      }
      return payload;
    });

    const attempts = RETRY_DELAYS_MS.length;
    let lastError: string | null = null;
    let lastStatus: number | null = null;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      let retryAfter: number | null = null;
      try {
        const response = await this.fetchImpl(this.ingestUrl, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
            "User-Agent": USER_AGENT,
          },
          body: JSON.stringify({ events: batch }),
        });
        const status = response.status;
        if (status >= 200 && status < 300) {
          this.recordAttemptResult({ success: true });
          return;
        }
        if (status >= 400 && status < 500 && !RETRYABLE_4XX.has(status)) {
          // Contract error (bad key, bad URL, malformed payload):
          // retrying cannot help — drop and surface once.
          const body = truncateBody(await response.text().catch(() => "<unreadable>"));
          this.recordAttemptResult({ success: false, status, body, nEvents: batch.length });
          return;
        }
        // Retryable: 5xx, 429 (rate limit), 408 (request timeout).
        lastError = `status=${status}`;
        lastStatus = status;
        retryAfter = retryAfterMs(response.headers);
      } catch (err) {
        lastError = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        lastStatus = null;
      }

      // Sleep on every attempt except the last; honor shutdown. A server
      // Retry-After (capped) overrides the static backoff for this attempt.
      if (attempt < attempts - 1) {
        const delay = retryAfter ?? RETRY_DELAYS_MS[attempt]!;
        await sleep(delay, this.stopController.signal);
        if (this.stopped) break;
      }
    }

    // All attempts exhausted without a 2xx. Leash-grade events carry
    // compliance audit data — requeue them (bounded) instead of dropping.
    const requeued = this.requeueLeashItems(items);
    const dropped = batch.length - requeued;
    this.recordAttemptResult({
      success: false,
      status: lastStatus,
      body: lastError ?? "unknown",
      nEvents: dropped,
    });
    if (requeued > 0) {
      this.logger.warn(
        `requeued ${requeued} leash event(s) after exhausted retries; ` +
          `${dropped} non-leash event(s) dropped`,
      );
    }
  }

  private requeueLeashItems(items: BufferItem[]): number {
    let count = 0;
    for (const { priority, payload } of items) {
      if (priority !== PRIORITY_LEASH) continue;
      const raw = payload[REQUEUE_KEY];
      const cycles = typeof raw === "number" && Number.isInteger(raw) ? raw : 0;
      if (cycles >= MAX_REQUEUES) {
        this.logger.warn(`leash event dropped after ${MAX_REQUEUES} requeue cycles`);
        continue;
      }
      this.buffer.put({ ...payload, [REQUEUE_KEY]: cycles + 1 }, PRIORITY_LEASH);
      count += 1;
    }
    return count;
  }

  // -------------------------------------------- first-attempt visibility
  private recordAttemptResult(args: {
    success: boolean;
    status?: number | null;
    body?: string;
    nEvents?: number;
  }): void {
    const isFirstAttempt = !this.firstIngestAttempted;
    this.firstIngestAttempted = true;

    if (args.success) {
      if (!this.firstIngestSucceeded) {
        this.firstIngestSucceeded = true;
        this.logger.info(`ingest connected to ${this.ingestUrl}`);
      }
      return;
    }

    const { status = null, body = "", nEvents = 0 } = args;
    if (isFirstAttempt) {
      const cause =
        status !== null && status >= 400 && status < 500
          ? `first ingest call failed (status=${status}, body=${body}). This usually means the ingest URL or API key is misconfigured.`
          : status !== null
            ? `first ingest call failed (status=${status}, body=${body}). The ingest server returned a non-success status.`
            : `first ingest call failed: ${body}. The SDK could not reach the ingest endpoint.`;
      this.logger.warn(
        `${cause}\n    Set HOUNDSIGHT_DEBUG=1 for verbose logging.\n` +
          `    Dashboard onboarding: https://houndsight.ai/dashboard/setup\n` +
          `    (Batch of ${nEvents} event(s) affected.)`,
      );
      return;
    }

    if (status !== null && status >= 400 && status < 500) {
      this.logger.warn(
        `ingest rejected batch of ${nEvents} events (status=${status}, body=${body}); not retrying`,
      );
    } else {
      this.logger.warn(
        `dropped batch of ${nEvents} events after ${RETRY_DELAYS_MS.length} attempts (last_error=${body})`,
      );
    }
  }

  // ---------------------------------------------------------------- ping
  /**
   * Fire-and-forget connectivity probe. Converts silent broken integrations
   * (wrong key, wrong URL, DNS, firewall) into loud-but-non-fatal warnings
   * during onboarding. The server answers `{"action": "ping"}` with
   * `{skipped: true}` — a cheap 200.
   */
  ping(deadlineMs = 5_000): void {
    if (this.pingStarted) return;
    this.pingStarted = true;
    void (async () => {
      try {
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), deadlineMs);
        (t as { unref?: () => void }).unref?.();
        const response = await this.fetchImpl(this.ingestUrl, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
            "User-Agent": USER_AGENT,
          },
          body: JSON.stringify({ events: [{ action: "ping" }] }),
          signal: controller.signal,
        });
        clearTimeout(t);
        if (response.status >= 200 && response.status < 300) {
          this.recordAttemptResult({ success: true });
        } else {
          this.recordAttemptResult({
            success: false,
            status: response.status,
            body: truncateBody(await response.text().catch(() => "<unreadable>")),
            nEvents: 1,
          });
        }
      } catch (err) {
        this.recordAttemptResult({
          success: false,
          status: null,
          body: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
          nEvents: 1,
        });
      }
    })();
  }
}
