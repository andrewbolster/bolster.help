// The agent loop against a scripted engine.
//
// This covers everything about a turn except the model's judgement: that the
// loop terminates, that malformed arguments are survivable, that a failing tool
// is reported rather than thrown, and that the payload fits. Which tool a given
// model actually picks is a property of the model, not of this code, and is not
// asserted here.

import { describe, it } from "vitest";
import assert from "node:assert/strict";

import { createAgent } from "../../web/src/agent.js";
import { snapshot, fixtures } from "../helpers.mjs";

// A stand-in for the provider: replays queued replies and records the tool
// schemas it was handed each round.
function scriptedEngine(replies) {
  const queue = [...replies];
  const seen = [];
  return {
    seen,
    chat: {
      completions: {
        create: async ({ tools }) => {
          seen.push(tools);
          return { choices: [{ message: queue.shift() ?? { content: "fallback", tool_calls: [] } }] };
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
    assert.equal(out.rounds, 1);
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
    const engine = scriptedEngine([
      call("bolster_nisra_births", "[1,2,3]"),
      { content: "Done.", tool_calls: [] },
    ]);
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

  it("caps a model that never stops calling tools", async () => {
    const engine = scriptedEngine(Array.from({ length: 20 }, () => call("bolster_dva", "{}")));
    const out = await agentWith(engine, ok)([], "mot tests");
    assert.equal(out.rounds, 5, "should stop at MAX_ROUNDS");
    assert.match(out.content, /could not settle/i);
  });

  it("sends the whole catalogue, with the descriptions the server gave", async () => {
    const engine = scriptedEngine([{ content: "hi", tool_calls: [] }]);
    await agentWith(engine, ok)([], "how many births were registered last year?");

    const storeTools = new Set(["read_output", "search_output", "aggregate_output", "calculate", "write_output", "display_output"]);
    const sent = engine.seen[0].filter((tool) => !storeTools.has(tool.function.name));
    assert.equal(sent.length, snapshot.tools.length, "every tool should be offered");

    // Descriptions pass through untouched. Trimming them to a first paragraph
    // was the same kind of context-saving that hid what the model could do.
    const births = sent.find((tool) => tool.function.name === "bolster_nisra_births");
    assert.equal(births.function.description, snapshot.tools.find((t) => t.name === "bolster_nisra_births").description);
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
    assert.equal(out.messages[3].content, "follow up");
  });

  it("emits tool, result and answer events in order", async () => {
    const engine = scriptedEngine([
      call("bolster_nisra_births", "{}"),
      { content: "done", tool_calls: [] },
    ]);
    const types = [];
    await agentWith(engine, ok)([], "births", { onEvent: (e) => types.push(e.type) });
    assert.deepEqual(types, ["tool", "result", "answer"]);
  });
});

// What the full catalogue costs, recorded rather than enforced. There is no
// budget to keep: granite has a 131K context and the whole thing is ~19K.
describe("catalogue size", () => {
  it("reports what sending everything costs", () => {
    const tokens = Math.ceil(JSON.stringify(snapshot.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }))).length / 4);
    console.info(`all ${snapshot.tools.length} tools with full descriptions: ~${tokens} tokens`);
    assert.ok(tokens < 100_000, `catalogue is ${tokens} tokens, past a 131K context`);
  });
});
