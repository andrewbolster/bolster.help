// The agent loop against a scripted engine.
//
// This covers everything about a turn except the model's judgement: that the
// loop terminates, that malformed arguments are survivable, that a failing tool
// is reported rather than thrown, and that the payload fits. Which tool a given
// model actually picks is a property of the model, not of this code, and is not
// asserted here.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, vi } from "vitest";

import { createAgent } from "../../web/src/agent.js";
import { snapshot } from "../helpers.mjs";

// A stand-in for the provider: replays queued replies and records the tool
// schemas it was handed each round.
function scriptedEngine(replies) {
  const queue = [...replies];
  const seen = [];
  const signals = [];
  return {
    seen,
    signals,
    chat: {
      completions: {
        create: async ({ tools, signal }) => {
          seen.push(tools);
          signals.push(signal);
          return {
            choices: [
              {
                message: queue.shift() ?? {
                  content: "fallback",
                  tool_calls: [],
                },
              },
            ],
          };
        },
      },
    },
  };
}

const call = (name, args, id = "c1") => ({
  content: null,
  tool_calls: [{ id, function: { name, arguments: args } }],
});

const agentWith = (engine, mcp) => createAgent({ tools: snapshot.tools, engine, mcp });
const ok = { callTool: async () => "42 people" };

describe("agent loop", () => {
  it("answers directly when no tool is called", async () => {
    const engine = scriptedEngine([{ content: "No data needed.", tool_calls: [] }]);
    const out = await agentWith(engine, ok)([], "hello");
    assert.equal(out.content, "No data needed.");
  });

  it("calls a tool, then answers from the result", async () => {
    const engine = scriptedEngine([
      call("bolster_nisra_births", '{"event_type":"registration"}'),
      { content: "There were 42.", tool_calls: [] },
    ]);
    const asked = [];
    const out = await agentWith(engine, {
      callTool: async (name, args) => {
        asked.push([name, args]);
        return "42 births";
      },
    })([], "how many births last year?");

    assert.deepEqual(asked, [["bolster_nisra_births", { event_type: "registration" }]]);
    assert.equal(out.content, "There were 42.");
    assert.equal(
      out.messages.find((m) => m.role === "tool").tool_call_id,
      "c1",
      "tool result must carry the call id back, or the provider rejects the turn",
    );
  });

  // Observed from granite in production: the arguments field arrives as a JSON
  // string whose contents are themselves JSON. Parsing once yields a string,
  // which the MCP server rejects as invalid parameters — a wasted round.
  it("unwraps double-encoded arguments", async () => {
    const engine = scriptedEngine([
      call("bolster_nisra_births", JSON.stringify('{"event_type": "registration"}')),
      { content: "Done.", tool_calls: [] },
    ]);
    const seen = [];
    await agentWith(engine, {
      callTool: async (_name, args) => {
        seen.push(args);
        return "x";
      },
    })([], "births?");
    assert.deepEqual(seen, [{ event_type: "registration" }]);
  });

  it("degrades a JSON array of arguments to an empty object", async () => {
    const engine = scriptedEngine([call("bolster_nisra_births", "[1,2,3]"), { content: "Done.", tool_calls: [] }]);
    const seen = [];
    await agentWith(engine, {
      callTool: async (_name, args) => {
        seen.push(args);
        return "x";
      },
    })([], "births?");
    assert.deepEqual(seen, [{}], "an array is not a valid argument object");
  });

  it("degrades malformed argument JSON to an empty object", async () => {
    const engine = scriptedEngine([
      call("bolster_ni_executive", "{not json"),
      { content: "Recovered.", tool_calls: [] },
    ]);
    const seen = [];
    const out = await agentWith(engine, {
      callTool: async (_name, args) => {
        seen.push(args);
        return "x";
      },
    })([], "who is in the executive?");
    assert.deepEqual(seen, [{}]);
    assert.equal(out.content, "Recovered.");
  });

  it("reports a failing tool instead of throwing", async () => {
    const engine = scriptedEngine([
      call("bolster_water_quality", "{}"),
      { content: "That lookup failed.", tool_calls: [] },
    ]);
    const out = await agentWith(engine, {
      callTool: async () => {
        throw new Error("upstream HTTP 500");
      },
    })([], "water quality in BT7?");
    assert.match(out.messages.find((m) => m.role === "tool").content, /Tool failed: upstream HTTP 500/);
    assert.equal(out.content, "That lookup failed.");
  });

  // A cancelled tool call must stop the turn, not read as "the tool broke" and
  // press on into the next round the way a normal failure does.
  it("propagates a cancelled tool call instead of reporting it as a failure", async () => {
    const engine = scriptedEngine([call("bolster_water_quality", "{}")]);
    const abortError = Object.assign(new Error("The operation was aborted."), {
      name: "AbortError",
    });
    const controller = new AbortController();

    await assert.rejects(
      agentWith(engine, {
        callTool: async () => {
          throw abortError;
        },
      })([], "water quality in BT7?", { signal: controller.signal }),
      (err) => err.name === "AbortError",
    );
  });

  it("passes the abort signal to both the engine and the MCP client", async () => {
    const engine = scriptedEngine([call("bolster_water_quality", "{}"), { content: "Here you go.", tool_calls: [] }]);
    const controller = new AbortController();
    const mcpSignals = [];

    await agentWith(engine, {
      callTool: async (_name, _args, { signal } = {}) => {
        mcpSignals.push(signal);
        return "fine";
      },
    })([], "water quality in BT7?", { signal: controller.signal });

    assert.equal(engine.signals[0], controller.signal);
    assert.equal(mcpSignals[0], controller.signal);
  });

  // The cap is a stop, not a budget: a model working through a dozen tools is
  // fine, a model that never stops is not. Without a reachable bound the loop
  // runs forever and spends the day's allocation on one question.
  it("stops a model that never stops calling tools", async () => {
    const engine = scriptedEngine(Array.from({ length: 200 }, () => call("bolster_dva", "{}")));
    const out = await agentWith(engine, ok)([], "mot tests");
    assert.equal(engine.seen.length, 32, "should stop at MAX_ROUNDS");
    assert.match(out.content, /tried a lot of angles/i);
  });

  it("lets a model work through many tools before answering", async () => {
    const engine = scriptedEngine([
      ...Array.from({ length: 12 }, () => call("bolster_dva", "{}")),
      { content: "Here you go.", tool_calls: [] },
    ]);
    const out = await agentWith(engine, ok)([], "mot tests");
    assert.equal(out.content, "Here you go.", "twelve rounds is not excessive");
  });

  it("sends the whole catalogue, abridged, plus a way to read the rest", async () => {
    const engine = scriptedEngine([{ content: "hi", tool_calls: [] }]);
    await agentWith(engine, ok)([], "how many births were registered last year?");

    const ours = new Set([
      "read_output",
      "search_output",
      "aggregate_output",
      "calculate",
      "write_output",
      "display_output",
      "full_tool_documentation",
    ]);
    const sent = engine.seen[0];
    const fromCatalogue = sent.filter((tool) => !ours.has(tool.function.name));
    assert.equal(fromCatalogue.length, snapshot.tools.length, "every tool should be offered");
    assert.ok(sent.some((tool) => tool.function.name === "full_tool_documentation"));

    // Abridged to the prose, but not to a single line — and the unabridged
    // version stays reachable rather than being lost.
    const births = fromCatalogue.find((tool) => tool.function.name === "bolster_nisra_births");
    const full = snapshot.tools.find((t) => t.name === "bolster_nisra_births").description;
    assert.ok(births.function.description.length < full.length, "should be abridged");
    assert.match(births.function.description, /Breakdown by sex/, "should keep the substance");
  });

  it("answers full_tool_documentation without calling the MCP server", async () => {
    const engine = scriptedEngine([
      call("full_tool_documentation", JSON.stringify({ tool: "bolster_nisra_births" })),
      { content: "read it", tool_calls: [] },
    ]);
    let reached = false;
    const out = await agentWith(engine, {
      callTool: async () => {
        reached = true;
        return "x";
      },
    })([], "what does births take?");
    assert.equal(reached, false, "documentation is local; it must not hit the proxy");
    assert.match(out.messages.find((m) => m.role === "tool").content, /Examples:/);
  });

  it("prepends the system prompt and replays history", async () => {
    const engine = scriptedEngine([{ content: "hi", tool_calls: [] }]);
    const history = [
      { role: "user", content: "earlier question" },
      { role: "assistant", content: "earlier answer" },
    ];
    const out = await agentWith(engine, ok)(history, "follow up");
    assert.equal(out.messages[0].role, "system");
    assert.equal(out.messages[1].content, "earlier question");
    // The live message carries a timestamp prefix (see "date awareness" below);
    // history is replayed verbatim, so only the trailing text is checked here.
    assert.match(out.messages[3].content, /follow up$/);
  });

  describe("date awareness", () => {
    // Observed live: asked for "next week", the model picked a start_date
    // over a year in the past — nothing told it what day it actually was.
    beforeEach(() => {
      vi.useFakeTimers();
      // A Wednesday, so weekday and date can't accidentally agree by luck.
      vi.setSystemTime(new Date("2026-09-09T12:00:00Z"));
    });
    afterEach(() => vi.useRealTimers());

    it("tells the model today's date in Europe/London terms", async () => {
      const engine = scriptedEngine([{ content: "hi", tool_calls: [] }]);
      const out = await agentWith(engine, ok)([], "hi");
      assert.match(out.messages[0].content, /Wednesday 9 September 2026/);
      assert.match(out.messages[0].content, /2026-09-09/);
    });

    it("still carries the persona content alongside the date", async () => {
      const engine = scriptedEngine([{ content: "hi", tool_calls: [] }]);
      const out = await agentWith(engine, ok)([], "hi");
      assert.match(out.messages[0].content, /avatar of Andrew Bolster/);
    });

    // A second bug found chasing the first: the model reliably skipped calling
    // any tool at all for a casual-greeting-plus-question phrasing ("hi there,
    // how goes it? What's..."), fabricating an answer instead — 6/6 in testing.
    // Prefixing the live message with a timestamp, plus explaining the format,
    // fixed it (9/9). Neither alone did: the date sentence alone still hit the
    // tool-skip, and the prefix alone (unexplained) didn't move the model's date
    // maths.
    it("prefixes the live user message with a YYYY-MM-DD HH:MM timestamp", async () => {
      const engine = scriptedEngine([{ content: "hi", tool_calls: [] }]);
      const out = await agentWith(engine, ok)([], "what's the weather");
      assert.equal(out.messages[1].content, "2026-09-09 13:00; what's the weather");
    });

    it("does not prefix replayed history, only the live message", async () => {
      const engine = scriptedEngine([{ content: "hi", tool_calls: [] }]);
      const history = [
        { role: "user", content: "earlier question" },
        { role: "assistant", content: "earlier answer" },
      ];
      const out = await agentWith(engine, ok)(history, "follow up");
      assert.equal(out.messages[1].content, "earlier question");
      assert.equal(out.messages[3].content, "2026-09-09 13:00; follow up");
    });

    it("tells the model what the prefix means and that it need not reply in kind", async () => {
      const engine = scriptedEngine([{ content: "hi", tool_calls: [] }]);
      const out = await agentWith(engine, ok)([], "hi");
      assert.match(out.messages[0].content, /prefixed with a YYYY-MM-DD HH:MM timestamp/);
      assert.match(out.messages[0].content, /do not need to respond in the same format/);
    });
  });

  it("emits tool, result and answer events in order", async () => {
    const engine = scriptedEngine([call("bolster_nisra_births", "{}"), { content: "done", tool_calls: [] }]);
    const types = [];
    await agentWith(engine, ok)([], "births", {
      onEvent: (e) => types.push(e.type),
    });
    assert.deepEqual(types, ["tool", "result", "answer"]);
  });
});

// What the full catalogue costs, recorded rather than enforced. There is no
// budget to keep: granite has a 131K context and the whole thing is ~19K.
describe("catalogue size", () => {
  it("reports what sending everything costs", () => {
    const tokens = Math.ceil(
      JSON.stringify(
        snapshot.tools.map((t) => ({
          type: "function",
          function: {
            name: t.name,
            description: t.description,
            parameters: t.inputSchema,
          },
        })),
      ).length / 4,
    );
    console.info(`all ${snapshot.tools.length} tools with full descriptions: ~${tokens} tokens`);
    assert.ok(tokens < 100_000, `catalogue is ${tokens} tokens, past a 131K context`);
  });
});
