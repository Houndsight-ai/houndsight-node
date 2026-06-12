import { afterEach, describe, expect, it } from "vitest";

import { instrumentAnthropic, instrumentOpenAI, setLayer, trail } from "../src/index.js";
import { setup, teardown } from "./helpers.js";

afterEach(teardown);

// ------------------------------------------------------------ fake clients
function fakeOpenAI(behavior?: (params: Record<string, unknown>) => unknown) {
  const calls: Array<Record<string, unknown>> = [];
  const client = {
    chat: {
      completions: {
        create: async (params: Record<string, unknown>) => {
          calls.push(params);
          if (behavior) return behavior(params);
          return {
            id: "chatcmpl-1",
            model: params["model"],
            choices: [{ message: { role: "assistant", content: "hi" } }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          };
        },
      },
    },
  };
  return { client, calls };
}

function openAIStream(chunks: unknown[]): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c;
    },
  };
}

function fakeAnthropic() {
  return {
    messages: {
      create: async (params: Record<string, unknown>) => {
        if (params["stream"]) {
          return openAIStream([
            { type: "message_start", message: { usage: { input_tokens: 7 } } },
            { type: "content_block_delta", delta: { text: "h" } },
            { type: "message_delta", usage: { output_tokens: 3 } },
          ]);
        }
        return {
          id: "msg-1",
          model: params["model"],
          content: [{ type: "text", text: "hello" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 7, output_tokens: 3 },
        };
      },
    },
  };
}

// ------------------------------------------------------------------ openai
describe("instrumentOpenAI", () => {
  it("records model, tokens, and cost inside a trail", async () => {
    const h = setup();
    const { client } = fakeOpenAI();
    instrumentOpenAI(client);

    await trail({ trigger: "user_message", agent: "a" }, async () => {
      await client.chat.completions.create({ model: "gpt-4o", messages: [] });
    });

    const sc = (await h.byAction("step_complete")).find((e) =>
      String(e["name"]).startsWith("openai/"),
    )!;
    expect(sc["name"]).toBe("openai/gpt-4o");
    expect(sc["model"]).toBe("gpt-4o");
    expect(sc["prompt_tokens"]).toBe(10);
    expect(sc["completion_tokens"]).toBe(5);
    expect(sc["tokens"]).toBe(15);
    // 10/1M * 2.5 + 5/1M * 10.0
    expect(sc["cost_usd"]).toBeCloseTo((10 / 1e6) * 2.5 + (5 / 1e6) * 10.0, 12);
    expect(sc["layer"]).toBe("execute");
    expect(sc["step_type"]).toBe("api_call");
  });

  it("passes through untouched outside a trail", async () => {
    const h = setup();
    const { client, calls } = fakeOpenAI();
    instrumentOpenAI(client);
    const res = (await client.chat.completions.create({ model: "gpt-4o" })) as {
      id: string;
    };
    expect(res.id).toBe("chatcmpl-1");
    expect(calls.length).toBe(1);
    expect(await h.byAction("step_complete")).toEqual([]);
  });

  it("classifies tool calls as plan layer", async () => {
    const h = setup();
    const { client } = fakeOpenAI();
    instrumentOpenAI(client);
    await trail({ trigger: "user_message", agent: "a" }, async () => {
      await client.chat.completions.create({
        model: "gpt-4o",
        messages: [],
        tools: [{ type: "function" }],
      });
    });
    const sc = (await h.byAction("step_complete"))[0]!;
    expect(sc["layer"]).toBe("plan");
    expect(sc["step_type"]).toBe("llm_reasoning");
  });

  it("classifies planner system prompts as plan layer", async () => {
    const h = setup();
    const { client } = fakeOpenAI();
    instrumentOpenAI(client);
    await trail({ trigger: "user_message", agent: "a" }, async () => {
      await client.chat.completions.create({
        model: "gpt-4o",
        messages: [{ role: "system", content: "You are a planner. Create a plan." }],
      });
    });
    expect((await h.byAction("step_complete"))[0]!["layer"]).toBe("plan");
  });

  it("honors a one-shot setLayer override", async () => {
    const h = setup();
    const { client } = fakeOpenAI();
    instrumentOpenAI(client);
    await trail({ trigger: "user_message", agent: "a" }, async () => {
      setLayer("output", "message");
      await client.chat.completions.create({ model: "gpt-4o", messages: [] });
      await client.chat.completions.create({ model: "gpt-4o", messages: [] });
    });
    const completes = await h.byAction("step_complete");
    expect(completes[0]!["layer"]).toBe("output");
    expect(completes[0]!["step_type"]).toBe("message");
    expect(completes[1]!["layer"]).toBe("execute"); // override consumed
  });

  it("marks status=error and rethrows on API failure", async () => {
    const h = setup();
    const { client } = fakeOpenAI(() => {
      throw new Error("api down");
    });
    instrumentOpenAI(client);
    await expect(
      trail({ trigger: "user_message", agent: "a" }, async () => {
        await client.chat.completions.create({ model: "gpt-4o" });
      }),
    ).rejects.toThrow("api down");
    const sc = (await h.byAction("step_complete"))[0]!;
    expect(sc["status"]).toBe("error");
  });

  it("aggregates streaming usage and ends the step at exhaustion", async () => {
    const h = setup();
    const { client } = fakeOpenAI((params) =>
      openAIStream([
        { choices: [{ delta: { content: "h" } }] },
        { choices: [{ delta: { content: "i" } }] },
        {
          choices: [],
          usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 },
          model: params["model"],
        },
      ]),
    );
    instrumentOpenAI(client);

    await trail({ trigger: "user_message", agent: "a" }, async () => {
      const stream = (await client.chat.completions.create({
        model: "gpt-4o",
        messages: [],
        stream: true,
      })) as AsyncIterable<unknown>;
      const chunks: unknown[] = [];
      for await (const c of stream) chunks.push(c);
      expect(chunks.length).toBe(3);
    });

    const sc = (await h.byAction("step_complete"))[0]!;
    expect(sc["model"]).toBe("gpt-4o");
    expect(sc["tokens"]).toBe(10);
    expect(JSON.parse(sc["output"] as string)).toEqual({ streamed: true, tokens: 10 });
  });

  it("still attributes the model when a stream has no usage chunk", async () => {
    const h = setup();
    const { client } = fakeOpenAI(() =>
      openAIStream([{ choices: [{ delta: { content: "x" } }] }]),
    );
    instrumentOpenAI(client);
    await trail({ trigger: "user_message", agent: "a" }, async () => {
      const stream = (await client.chat.completions.create({
        model: "gpt-4o",
        stream: true,
      })) as AsyncIterable<unknown>;
      for await (const _ of stream) void _;
    });
    const sc = (await h.byAction("step_complete"))[0]!;
    expect(sc["model"]).toBe("gpt-4o"); // observed_llm_calls still increments
    expect(sc["tokens"]).toBeNull();
    const events = sc["events"] as Array<Record<string, unknown>>;
    expect(events.some((e) => e["type"] === "log_emitted")).toBe(true);
  });

  it("is idempotent per instance", async () => {
    setup();
    const { client, calls } = fakeOpenAI();
    instrumentOpenAI(client);
    instrumentOpenAI(client);
    await trail({ trigger: "user_message", agent: "a" }, async () => {
      await client.chat.completions.create({ model: "gpt-4o" });
    });
    expect(calls.length).toBe(1); // single wrap → single underlying call
  });
});

// --------------------------------------------------------------- anthropic
describe("instrumentAnthropic", () => {
  it("records model, tokens, and cost inside a trail", async () => {
    const h = setup();
    const client = fakeAnthropic();
    instrumentAnthropic(client);

    await trail({ trigger: "user_message", agent: "a" }, async () => {
      await client.messages.create({ model: "claude-sonnet-4-5", max_tokens: 100 });
    });

    const sc = (await h.byAction("step_complete"))[0]!;
    expect(sc["name"]).toBe("anthropic/claude-sonnet-4-5");
    expect(sc["model"]).toBe("claude-sonnet-4-5");
    expect(sc["prompt_tokens"]).toBe(7);
    expect(sc["completion_tokens"]).toBe(3);
    expect(sc["tokens"]).toBe(10);
    expect(typeof sc["cost_usd"]).toBe("number");
  });

  it("aggregates streaming usage from message_start and message_delta", async () => {
    const h = setup();
    const client = fakeAnthropic();
    instrumentAnthropic(client);
    await trail({ trigger: "user_message", agent: "a" }, async () => {
      const stream = (await client.messages.create({
        model: "claude-sonnet-4-5",
        stream: true,
      })) as AsyncIterable<unknown>;
      for await (const _ of stream) void _;
    });
    const sc = (await h.byAction("step_complete"))[0]!;
    expect(sc["prompt_tokens"]).toBe(7);
    expect(sc["completion_tokens"]).toBe(3);
    expect(sc["tokens"]).toBe(10);
  });

  it("classifies anthropic top-level system planner prompts as plan", async () => {
    const h = setup();
    const client = fakeAnthropic();
    instrumentAnthropic(client);
    await trail({ trigger: "user_message", agent: "a" }, async () => {
      await client.messages.create({
        model: "claude-sonnet-4-5",
        system: "You are an agent. Decide which tool to use.",
      });
    });
    expect((await h.byAction("step_complete"))[0]!["layer"]).toBe("plan");
  });
});
