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
import { buildIndex, search, toOpenAITools } from "../../web/src/retrieval.js";
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

  it("sends only the retrieved candidates, never the whole catalogue", async () => {
    const engine = scriptedEngine([{ content: "hi", tool_calls: [] }]);
    await agentWith(engine, ok)([], "how many births were registered last year?");
    const sent = engine.seen[0];
    assert.equal(sent.length, 6, `expected 6 candidate schemas, got ${sent.length}`);
    assert.ok(
      sent.some((tool) => tool.function.name === "bolster_nisra_births"),
      "the expected tool must be among them",
    );
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

  it("emits retrieved, tool, result and answer events in order", async () => {
    const engine = scriptedEngine([
      call("bolster_nisra_births", "{}"),
      { content: "done", tool_calls: [] },
    ]);
    const types = [];
    await agentWith(engine, ok)([], "births", { onEvent: (e) => types.push(e.type) });
    assert.deepEqual(types, ["retrieved", "tool", "result", "answer"]);
  });
});

// The budget that justifies retrieval existing at all. Rough but consistent:
// enough to compare a top-6 payload against the full catalogue.
describe("tool payload budget", () => {
  const tokens = (obj) => Math.ceil(JSON.stringify(obj).length / 4);
  const index = buildIndex(snapshot.tools);
  const perFixture = fixtures.map((f) =>
    tokens(toOpenAITools(search(index, f.prompt, 6).map((r) => r.tool))),
  );
  const worst = Math.max(...perFixture);
  const mean = Math.round(perFixture.reduce((a, b) => a + b, 0) / perFixture.length);

  it("leaves room for a conversation in a small quantised model", () => {
    console.info(`all ${snapshot.tools.length} tools: ~${tokens(toOpenAITools(snapshot.tools))} tokens`);
    console.info(`top 6: ~${mean} mean, ~${worst} worst`);
    assert.ok(worst < 3000, `worst-case payload ${worst} tokens is too large`);
  });
});
