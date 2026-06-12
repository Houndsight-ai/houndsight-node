import { afterEach, describe, expect, it, vi } from "vitest";

import {
  bark,
  collar,
  costFor,
  currentTrail,
  hasPricing,
  startTrail,
  trail,
} from "../src/index.js";
import { setup, teardown } from "./helpers.js";

afterEach(() => {
  teardown();
  vi.restoreAllMocks();
});

describe("trail lifecycle", () => {
  it("emits start and complete with normalized fields", async () => {
    const h = setup();
    await trail(
      { trigger: "user_message", agent: "agent-x", payload: { q: "hi" } },
      async (t) => {
        t.setOutput("done");
      },
    );
    const starts = await h.byAction("start");
    expect(starts.length).toBe(1);
    expect(starts[0]!["trigger"]).toBe("user_message");
    expect(starts[0]!["agent"]).toBe("agent-x");
    expect((starts[0]!["payload"] as Record<string, unknown>)["q"]).toBe("hi");

    const completes = await h.byAction("complete");
    expect(completes.length).toBe(1);
    expect(completes[0]!["output_summary"]).toBe("done");
    expect(completes[0]!["error_summary"]).toBeNull();
    expect(completes[0]!["trace_id"]).toBe(starts[0]!["trace_id"]);
  });

  it("records the error summary and rethrows when the callback throws", async () => {
    const h = setup();
    await expect(
      trail({ trigger: "user_message", agent: "a" }, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const completes = await h.byAction("complete");
    expect(completes[0]!["error_summary"]).toContain("boom");
  });

  it("maps trigger aliases silently", async () => {
    const h = setup();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await trail({ trigger: "cron", agent: "a" }, async () => {});
    const starts = await h.byAction("start");
    expect(starts[0]!["trigger"]).toBe("schedule");
    expect(warn).not.toHaveBeenCalled();
  });

  it("maps unknown triggers to agent_signal, warns once, preserves original", async () => {
    const h = setup();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await trail({ trigger: "totally-custom-xyz", agent: "a" }, async () => {});
    await trail({ trigger: "totally-custom-xyz", agent: "a" }, async () => {});
    const starts = await h.byAction("start");
    expect(starts[0]!["trigger"]).toBe("agent_signal");
    expect((starts[0]!["payload"] as Record<string, unknown>)["_original_trigger"]).toBe(
      "totally-custom-xyz",
    );
    const triggerWarnings = warn.mock.calls.filter((c) =>
      String(c[0]).includes("totally-custom-xyz"),
    );
    expect(triggerWarnings.length).toBe(1);
  });

  it("defaults a missing agent to unnamed-agent with a warning", async () => {
    const h = setup();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await trail({ trigger: "user_message" }, async () => {});
    const starts = await h.byAction("start");
    expect(starts[0]!["agent"]).toBe("unnamed-agent");
    expect(
      warn.mock.calls.some((c) => String(c[0]).includes("unnamed-agent")),
    ).toBe(true);
  });

  it("binds currentTrail() inside the callback and clears it outside", async () => {
    setup();
    expect(currentTrail()).toBeNull();
    await trail({ trigger: "user_message", agent: "a" }, async (t) => {
      expect(currentTrail()).toBe(t);
      await Promise.resolve(); // survives awaits
      expect(currentTrail()).toBe(t);
    });
    expect(currentTrail()).toBeNull();
  });

  it("isolates concurrent trails", async () => {
    setup();
    const seen: string[] = [];
    await Promise.all([
      trail({ trigger: "user_message", agent: "a" }, async (t) => {
        await new Promise((r) => setTimeout(r, 10));
        seen.push(`${t.traceId}=${currentTrail()?.traceId}`);
      }),
      trail({ trigger: "user_message", agent: "a" }, async (t) => {
        seen.push(`${t.traceId}=${currentTrail()?.traceId}`);
      }),
    ]);
    for (const pair of seen) {
      const [expected, actual] = pair.split("=");
      expect(actual).toBe(expected);
    }
  });

  it("startTrail requires manual end and is idempotent", async () => {
    const h = setup();
    const t = startTrail({ trigger: "webhook", agent: "a" });
    t.end();
    t.end(); // no double complete
    const completes = await h.byAction("complete");
    expect(completes.length).toBe(1);
  });
});

describe("steps", () => {
  it("records llm() attribution on step_complete with auto-derived total", async () => {
    const h = setup();
    await trail({ trigger: "user_message", agent: "a" }, (t) =>
      t.sniff({ name: "openai/gpt-4o", layer: "plan", stepType: "llm_call" }, (s) => {
        s.llm("gpt-4o", 10, 5);
      }),
    );
    const sc = (await h.byAction("step_complete"))[0]!;
    expect(sc["model"]).toBe("gpt-4o");
    expect(sc["prompt_tokens"]).toBe(10);
    expect(sc["completion_tokens"]).toBe(5);
    expect(sc["tokens"]).toBe(15);
  });

  it("llm() does not override an explicit tokens() call", async () => {
    const h = setup();
    await trail({ trigger: "user_message", agent: "a" }, (t) =>
      t.sniff({ name: "x", layer: "plan" }, (s) => {
        s.tokens(99);
        s.llm("gpt-4o", 10, 5);
      }),
    );
    const sc = (await h.byAction("step_complete"))[0]!;
    expect(sc["tokens"]).toBe(99);
    expect(sc["model"]).toBe("gpt-4o");
  });

  it("riskSignal() appends a reserved risk_signal event", async () => {
    const h = setup();
    await trail({ trigger: "user_message", agent: "a" }, (t) =>
      t.sniff({ name: "charge", layer: "execute" }, (s) => {
        s.riskSignal({ amount_usd: 1_200, data_categories: ["financial"] });
      }),
    );
    const sc = (await h.byAction("step_complete"))[0]!;
    const events = sc["events"] as Array<Record<string, unknown>>;
    const rs = events.filter((e) => e["type"] === "risk_signal");
    expect(rs.length).toBe(1);
    expect(rs[0]!["payload"]).toEqual({ amount_usd: 1_200, data_categories: ["financial"] });
  });

  it("marks status=error and rethrows when the sniff callback throws", async () => {
    const h = setup();
    await expect(
      trail({ trigger: "user_message", agent: "a" }, (t) =>
        t.sniff({ name: "x" }, () => {
          throw new Error("step boom");
        }),
      ),
    ).rejects.toThrow("step boom");
    const sc = (await h.byAction("step_complete"))[0]!;
    expect(sc["status"]).toBe("error");
    expect(String(sc["error"])).toContain("step boom");
  });

  it("normalizes legacy layer aliases with a warning", async () => {
    const h = setup();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await trail({ trigger: "user_message", agent: "a" }, (t) =>
      t.sniff({ name: "x", layer: "tool" }, () => {}),
    );
    const sc = (await h.byAction("step_complete"))[0]!;
    expect(sc["layer"]).toBe("execute");
    expect(warn.mock.calls.some((c) => String(c[0]).includes("deprecated"))).toBe(true);
  });

  it("rejects unknown layers", async () => {
    setup();
    await expect(
      trail({ trigger: "user_message", agent: "a" }, (t) =>
        t.sniff({ name: "x", layer: "bogus" }, () => {}),
      ),
    ).rejects.toThrow(/Invalid layer/);
  });

  it("truncates oversized payloads to 8KB", async () => {
    const h = setup();
    await trail({ trigger: "user_message", agent: "a" }, (t) =>
      t.sniff({ name: "x" }, (s) => {
        s.input({ blob: "y".repeat(20_000) });
      }),
    );
    const sc = (await h.byAction("step_complete"))[0]!;
    const input = sc["input"] as string;
    expect(input.length).toBeLessThanOrEqual(8 * 1024);
    expect(input.endsWith("...<truncated>")).toBe(true);
  });
});

describe("bark", () => {
  it("is not sent outside an active trail (warn once, local event returned)", async () => {
    const h = setup();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ev = bark("cache_hit", { key: "abc" });
    expect(ev.name).toBe("cache_hit");
    expect(ev.traceId).toBeNull();
    bark("cache_hit", { key: "again" });
    expect(
      warn.mock.calls.filter((c) => String(c[0]).includes("outside an active trail")).length,
    ).toBe(1);
    expect(await h.byAction("bark")).toEqual([]);
  });

  it("is sent with trace correlation inside a trail", async () => {
    const h = setup();
    let traceId = "";
    await trail({ trigger: "user_message", agent: "a" }, async (t) => {
      traceId = t.traceId;
      const ev = bark("cache_hit", { key: "abc" });
      expect(ev.traceId).toBe(traceId);
    });
    const barks = await h.byAction("bark");
    expect(barks.length).toBe(1);
    expect(barks[0]!["trace_id"]).toBe(traceId);
    expect(barks[0]!["name"]).toBe("cache_hit");
    expect(typeof barks[0]!["timestamp"]).toBe("string");
  });
});

describe("collar", () => {
  it("records a sniff on the active trail", async () => {
    const h = setup();
    const double = collar((x: number) => x * 2, { name: "double" });
    let result = 0;
    await trail({ trigger: "user_message", agent: "a" }, async () => {
      result = await double(21);
    });
    expect(result).toBe(42);
    const sc = (await h.byAction("step_complete")).find((e) => e["name"] === "double")!;
    expect(sc["layer"]).toBe("execute");
    // Exactly one trail: the explicit one.
    expect((await h.byAction("start")).length).toBe(1);
  });

  it("opens an implicit agent_signal trail outside one", async () => {
    const h = setup();
    const fetchDeals = collar(async (region: string) => `deals:${region}`, {
      name: "fetchDeals",
    });
    const out = await fetchDeals("emea");
    expect(out).toBe("deals:emea");

    const starts = await h.byAction("start");
    expect(starts.length).toBe(1);
    expect(starts[0]!["trigger"]).toBe("agent_signal");
    expect((starts[0]!["payload"] as Record<string, unknown>)["collar"]).toBe("fetchDeals");
    expect((await h.byAction("complete")).length).toBe(1);
  });

  it("propagates errors and records error status on the implicit trail", async () => {
    const h = setup();
    const bad = collar(
      async () => {
        throw new Error("collar boom");
      },
      { name: "bad" },
    );
    await expect(bad()).rejects.toThrow("collar boom");
    const completes = await h.byAction("complete");
    expect(String(completes[0]!["error_summary"])).toContain("collar boom");
    const sc = (await h.byAction("step_complete"))[0]!;
    expect(sc["status"]).toBe("error");
  });
});

describe("pricing", () => {
  it("exact and prefix matches", () => {
    expect(costFor("openai", "gpt-4o", 1_000_000, 0)).toBeCloseTo(2.5);
    expect(costFor("openai", "gpt-4o", 0, 1_000_000)).toBeCloseTo(10.0);
    // dated snapshot id resolves via longest-prefix
    expect(costFor("openai", "gpt-4o-2024-08-06", 1_000_000, 0)).toBeCloseTo(2.5);
    // gpt-4o-mini must NOT match the shorter gpt-4o prefix
    expect(costFor("openai", "gpt-4o-mini-2024-07-18", 1_000_000, 0)).toBeCloseTo(0.15);
  });

  it("returns null for unknown models and providers", () => {
    expect(costFor("openai", "totally-unknown-model", 1000, 1000)).toBeNull();
    expect(costFor("nonexistent-provider", "gpt-4o", 1000, 1000)).toBeNull();
    expect(hasPricing("openai", "gpt-4o")).toBe(true);
    expect(hasPricing("openai", "zzz")).toBe(false);
  });
});
