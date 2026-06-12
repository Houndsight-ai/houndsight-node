import { afterEach, describe, expect, it } from "vitest";

import { trail } from "../src/index.js";
import { LeashError } from "../src/errors.js";
import { deriveLeashUrl, buildTraceLink } from "../src/leash.js";
import { json, setup, teardown, type Harness } from "./helpers.js";

afterEach(teardown);

function leashOpts(extra: Record<string, unknown> = {}) {
  return {
    actionName: "send_contract",
    actionSummary: "Email the Q2 contract",
    riskSignals: { amount_usd: 50_000 },
    timeoutSeconds: 30,
    ...extra,
  };
}

async function reviewSteps(h: Harness) {
  const completes = await h.byAction("step_complete");
  return completes.filter((e) => e["layer"] === "review");
}

describe("URL helpers", () => {
  it("derives checkLeash from the default ingest URL", () => {
    expect(deriveLeashUrl("https://houndsight.ai/api/functions/ingestAgentRun")).toBe(
      "https://houndsight.ai/api/functions/checkLeash",
    );
  });
  it("swaps the final path segment for overrides", () => {
    expect(deriveLeashUrl("https://example.com/v1/ingest")).toBe(
      "https://example.com/v1/checkLeash",
    );
  });
  it("builds trace links from the ingest host", () => {
    expect(buildTraceLink("https://example.com/v1/ingest", "tr-1")).toBe(
      "https://example.com/dashboard/traces/tr-1",
    );
    expect(buildTraceLink("not a url", "tr-1")).toBe(
      "https://houndsight.ai/dashboard/traces/tr-1",
    );
  });
});

describe("leash protocol", () => {
  it("fast-path approve resolves on the initial POST", async () => {
    const h = setup(() =>
      json(200, { decision: "approved", reason: "policy", decided_by: "auto" }),
    );
    const decision = await trail({ trigger: "user_message", agent: "a" }, (t) =>
      t.leash(leashOpts()),
    );
    expect(decision.approved).toBe(true);
    expect(decision.decision).toBe("approved");
    expect(decision.decidedBy).toBe("auto");
    expect(h.leashCalls.length).toBe(1);

    // The review-layer audit step is always emitted, fast path included.
    const steps = await reviewSteps(h);
    expect(steps.length).toBe(1);
    expect(steps[0]!["step_type"]).toBe("auto_approve");
    const output = JSON.parse(steps[0]!["output"] as string);
    expect(output.decision).toBe("approved");
  });

  it("fast-path floor-rule block", async () => {
    const h = setup(() =>
      json(200, { decision: "blocked", reason: "amount over floor", decided_by: "floor_rule" }),
    );
    const decision = await trail({ trigger: "user_message", agent: "a" }, (t) =>
      t.leash(leashOpts()),
    );
    expect(decision.approved).toBe(false);
    expect(decision.decision).toBe("blocked");
    expect(decision.decidedBy).toBe("floor_rule");
    expect(h.leashCalls.length).toBe(1);
  });

  it("polls a human gate to approval and upgrades the step type", async () => {
    const h = setup((_url, _init, call) => {
      if (call === 0) return json(200, { gate_id: "rg_1" });
      if (call === 1) return json(200, { decision: "pending" });
      return json(200, {
        decision: "approved",
        reason: "Looks good",
        decided_by: "reviewer@example.com",
        gate_id: "rg_1",
      });
    });
    const decision = await trail({ trigger: "user_message", agent: "a" }, (t) =>
      t.leash(leashOpts()),
    );
    expect(decision.approved).toBe(true);
    expect(decision.gateId).toBe("rg_1");
    expect(decision.decidedBy).toBe("reviewer@example.com");
    expect(h.leashCalls.length).toBe(3);
    expect(h.leashCalls[1]!.url).toContain("gate_id=rg_1");

    const steps = await reviewSteps(h);
    expect(steps[0]!["step_type"]).toBe("human_gate");
  });

  it("treats server-side decision=timeout as terminal", async () => {
    const h = setup((_url, _init, call) =>
      call === 0
        ? json(200, { gate_id: "rg_exp" })
        : json(200, { decision: "timeout", reason: "Review gate expired.", gate_id: "rg_exp" }),
    );
    const started = Date.now();
    const decision = await trail({ trigger: "user_message", agent: "a" }, (t) =>
      t.leash(leashOpts({ timeoutSeconds: 30 })),
    );
    expect(decision.decision).toBe("timeout");
    expect(decision.approved).toBe(false);
    expect(decision.gateId).toBe("rg_exp");
    expect(h.leashCalls.length).toBe(2); // POST + one poll; no dead-gate spin
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("normalizes decision=expired to timeout", async () => {
    setup((_url, _init, call) =>
      call === 0
        ? json(200, { gate_id: "rg_exp2" })
        : json(200, { decision: "expired", gate_id: "rg_exp2" }),
    );
    const decision = await trail({ trigger: "user_message", agent: "a" }, (t) =>
      t.leash(leashOpts()),
    );
    expect(decision.decision).toBe("timeout");
    expect(decision.gateId).toBe("rg_exp2");
  });

  it("times out client-side when the gate never resolves", async () => {
    setup((_url, _init, call) =>
      call === 0 ? json(200, { gate_id: "rg_slow" }) : json(200, { decision: "pending" }),
    );
    const decision = await trail({ trigger: "user_message", agent: "a" }, (t) =>
      t.leash(leashOpts({ timeoutSeconds: 0.08 })),
    );
    expect(decision.decision).toBe("timeout");
    expect(decision.approved).toBe(false);
    expect(decision.gateId).toBe("rg_slow");
  });

  it("fails closed (timeout) on network error", async () => {
    setup(() => {
      throw new TypeError("fetch failed");
    });
    const decision = await trail({ trigger: "user_message", agent: "a" }, (t) =>
      t.leash(leashOpts()),
    );
    expect(decision.decision).toBe("timeout");
    expect(decision.approved).toBe(false);
    expect(decision.reason).toContain("could not reach gate service");
  });

  it("fails closed (timeout) on 5xx", async () => {
    setup(() => json(503, {}));
    const decision = await trail({ trigger: "user_message", agent: "a" }, (t) =>
      t.leash(leashOpts()),
    );
    expect(decision.decision).toBe("timeout");
    expect(decision.reason).toContain("status=503");
  });

  it("maps 422 with a floor-rule body to blocked", async () => {
    setup(() =>
      json(422, { decision: "blocked", reason: "non-waivable floor", decided_by: "floor_rule" }),
    );
    const decision = await trail({ trigger: "user_message", agent: "a" }, (t) =>
      t.leash(leashOpts()),
    );
    expect(decision.decision).toBe("blocked");
    expect(decision.decidedBy).toBe("floor_rule");
  });

  it("maps 422 without a floor-rule body to error", async () => {
    setup(() => json(422, { detail: "validation failed" }));
    const decision = await trail({ trigger: "user_message", agent: "a" }, (t) =>
      t.leash(leashOpts()),
    );
    expect(decision.decision).toBe("error");
    expect(decision.approved).toBe(false);
  });

  it("maps other 4xx to error (not blocked)", async () => {
    setup(() => json(401, { error: "bad key" }));
    const decision = await trail({ trigger: "user_message", agent: "a" }, (t) =>
      t.leash(leashOpts()),
    );
    expect(decision.decision).toBe("error");
    expect(decision.reason).toContain("status=401");
  });

  it("fails closed with error when a poll gets a 4xx", async () => {
    setup((_url, _init, call) =>
      call === 0 ? json(200, { gate_id: "rg_x" }) : json(404, { error: "gone" }),
    );
    const decision = await trail({ trigger: "user_message", agent: "a" }, (t) =>
      t.leash(leashOpts()),
    );
    expect(decision.decision).toBe("error");
  });

  it("keeps polling through 5xx and non-JSON poll bodies", async () => {
    setup((_url, _init, call) => {
      if (call === 0) return json(200, { gate_id: "rg_y" });
      if (call === 1) return json(502, {});
      if (call === 2) return new Response("<html>oops</html>", { status: 200 });
      return json(200, { decision: "rejected", reason: "no" });
    });
    const decision = await trail({ trigger: "user_message", agent: "a" }, (t) =>
      t.leash(leashOpts()),
    );
    expect(decision.decision).toBe("rejected");
  });

  it("returns async with gateId when blocking=false", async () => {
    const h = setup(() => json(200, { gate_id: "rg_async" }));
    const decision = await trail({ trigger: "user_message", agent: "a" }, (t) =>
      t.leash(leashOpts({ blocking: false })),
    );
    expect(decision.decision).toBe("async");
    expect(decision.approved).toBe(false);
    expect(decision.gateId).toBe("rg_async");
    expect(h.leashCalls.length).toBe(1); // no polling

    const steps = await reviewSteps(h);
    const output = JSON.parse(steps[0]!["output"] as string);
    expect(output.gate_id).toBe("rg_async");
  });

  it("an approved=true field cannot flip a rejected decision", async () => {
    setup(() => json(200, { decision: "rejected", approved: true, reason: "nope" }));
    const decision = await trail({ trigger: "user_message", agent: "a" }, (t) =>
      t.leash(leashOpts()),
    );
    expect(decision.decision).toBe("rejected");
    expect(decision.approved).toBe(false);
  });

  it("honors an explicit approved=false veto on an approved decision", async () => {
    setup(() => json(200, { decision: "approved", approved: false, reason: "vetoed" }));
    const decision = await trail({ trigger: "user_message", agent: "a" }, (t) =>
      t.leash(leashOpts()),
    );
    expect(decision.decision).toBe("approved");
    expect(decision.approved).toBe(false);
  });

  it("carries modified_payload through", async () => {
    setup(() =>
      json(200, {
        decision: "modified",
        reason: "amount reduced",
        decided_by: "reviewer@example.com",
        modified_payload: { amount_usd: 10_000 },
      }),
    );
    const decision = await trail({ trigger: "user_message", agent: "a" }, (t) =>
      t.leash(leashOpts()),
    );
    expect(decision.approved).toBe(true);
    expect(decision.decision).toBe("modified");
    expect(decision.modifiedPayload).toEqual({ amount_usd: 10_000 });
  });

  it("emits leash_request and leash_decision audit events", async () => {
    const h = setup(() => json(200, { decision: "approved", decided_by: "auto" }));
    await trail({ trigger: "user_message", agent: "a" }, (t) => t.leash(leashOpts()));

    const reqs = await h.byAction("leash_request");
    expect(reqs.length).toBe(1);
    expect(reqs[0]!["action_name"]).toBe("send_contract");
    expect(reqs[0]!["risk_signals"]).toEqual({ amount_usd: 50_000 });

    const decisions = await h.byAction("leash_decision");
    expect(decisions.length).toBe(1);
    const data = decisions[0]!["data"] as Record<string, unknown>;
    expect(data["decision"]).toBe("approved");
  });

  it("sends the documented request body shape", async () => {
    let captured: Record<string, unknown> | null = null;
    setup((_url, init) => {
      captured = JSON.parse(String(init?.body ?? "{}"));
      return json(200, { decision: "approved" });
    });
    await trail({ trigger: "user_message", agent: "agent-x", pack: "sales" }, (t) =>
      t.leash(leashOpts({ payload: { to: "acme" } })),
    );
    expect(captured).not.toBeNull();
    const body = captured! as Record<string, unknown>;
    expect(body["action_name"]).toBe("send_contract");
    expect(body["agent"]).toBe("agent-x");
    expect(body["pack"]).toBe("sales");
    expect(body["risk_signals"]).toEqual({ amount_usd: 50_000 });
    expect(body["payload"]).toEqual({ to: "acme" });
    expect(body["timeout_seconds"]).toBe(30);
    expect(body["blocking"]).toBe(true);
    expect(typeof body["trace_id"]).toBe("string");
  });

  it("rejects non-positive timeoutSeconds before any side effects", async () => {
    const h = setup(() => json(200, { decision: "approved" }));
    await expect(
      trail({ trigger: "user_message", agent: "a" }, (t) =>
        t.leash(leashOpts({ timeoutSeconds: 0 })),
      ),
    ).rejects.toBeInstanceOf(LeashError);
    // Validation precedes the review step and audit events.
    expect(await reviewSteps(h)).toEqual([]);
    expect(await h.byAction("leash_request")).toEqual([]);
    expect(h.leashCalls.length).toBe(0);
  });
});
