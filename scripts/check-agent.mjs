#!/usr/bin/env node
// Exercises the agent loop against a scripted engine, and measures how much of
// the model's context the retrieved tool schemas actually consume.
//
// This covers everything about a turn except the model's judgement: that the
// loop terminates, that malformed arguments are survivable, that a failing tool
// is reported rather than thrown, and that the payload fits. Whether a given
// model picks the *right* tool is the bake-off's question, and needs WebGPU.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { createAgent } from "../web/src/agent.js";
import { buildIndex, search, toOpenAITools } from "../web/src/retrieval.js";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFile(join(here, "..", ...p), "utf8").then(JSON.parse);

const [snapshot, fixtures] = await Promise.all([
  read("web", "src", "tools.json"),
  read("web", "src", "fixtures.json"),
]);

// Rough but consistent: enough to compare a top-6 payload against all 36.
const tokens = (obj) => Math.ceil(JSON.stringify(obj).length / 4);

function scriptedEngine(replies) {
  const queue = [...replies];
  const seen = [];
  return {
    seen,
    chat: {
      completions: {
        create: async ({ tools }) => {
          seen.push(tools);
          const message = queue.shift() ?? { content: "fallback", tool_calls: [] };
          return { choices: [{ message }] };
        },
      },
    },
  };
}

const call = (name, args, id = "c1") => ({
  content: null,
  tool_calls: [{ id, function: { name, arguments: args } }],
});

const results = [];
const check = async (label, fn) => {
  try {
    await fn();
    results.push([true, label]);
  } catch (err) {
    results.push([false, `${label} — ${err.message}`]);
  }
};

const agentWith = (engine, mcp) => createAgent({ tools: snapshot.tools, engine, mcp });
const ok = { callTool: async () => "42 people" };

await check("answers directly when no tool is called", async () => {
  const engine = scriptedEngine([{ content: "No data needed.", tool_calls: [] }]);
  const out = await agentWith(engine, ok)([], "hello");
  assert.equal(out.content, "No data needed.");
  assert.equal(out.rounds, 1);
});

await check("calls a tool, then answers from the result", async () => {
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
  const toolTurn = out.messages.find((m) => m.role === "tool");
  assert.equal(toolTurn.tool_call_id, "c1", "tool result must carry the call id");
});

await check("survives malformed argument JSON", async () => {
  const engine = scriptedEngine([
    call("bolster_ni_executive", "{not json"),
    { content: "Recovered.", tool_calls: [] },
  ]);
  const seen = [];
  const out = await agentWith(engine, {
    callTool: async (_n, args) => {
      seen.push(args);
      return "x";
    },
  })([], "who is in the executive?");
  assert.deepEqual(seen, [{}], "unparseable arguments should degrade to {}");
  assert.equal(out.content, "Recovered.");
});

await check("reports a failing tool instead of throwing", async () => {
  const engine = scriptedEngine([
    call("bolster_water_quality", "{}"),
    { content: "That lookup failed.", tool_calls: [] },
  ]);
  const out = await agentWith(engine, {
    callTool: async () => {
      throw new Error("upstream HTTP 500");
    },
  })([], "water quality in BT7?");
  const toolTurn = out.messages.find((m) => m.role === "tool");
  assert.match(toolTurn.content, /Tool failed: upstream HTTP 500/);
  assert.equal(out.content, "That lookup failed.");
});

await check("caps a model that never stops calling tools", async () => {
  const engine = scriptedEngine(Array.from({ length: 20 }, () => call("bolster_dva", "{}")));
  const out = await agentWith(engine, ok)([], "mot tests");
  assert.equal(out.rounds, 5, "should stop at MAX_ROUNDS");
  assert.match(out.content, /could not settle/i);
});

await check("sends only the retrieved candidates, not all 36", async () => {
  const engine = scriptedEngine([{ content: "hi", tool_calls: [] }]);
  await agentWith(engine, ok)([], "how many births were registered last year?");
  const sent = engine.seen[0];
  assert.equal(sent.length, 6, `expected 6 candidate schemas, got ${sent.length}`);
  assert.ok(
    sent.some((t) => t.function.name === "bolster_nisra_births"),
    "the expected tool must be among them",
  );
});

await check("prepends the system prompt and replays history", async () => {
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

// Payload budget: the reason retrieval exists at all.
const index = buildIndex(snapshot.tools);
const all = tokens(toOpenAITools(snapshot.tools));
const perFixture = fixtures.map((f) =>
  tokens(toOpenAITools(search(index, f.prompt, 6).map((r) => r.tool))),
);
const worst = Math.max(...perFixture);
const mean = Math.round(perFixture.reduce((a, b) => a + b, 0) / perFixture.length);

await check("worst-case tool payload leaves room for a conversation", () => {
  assert.ok(worst < 3000, `worst-case payload ${worst} tokens is too large`);
});

for (const [pass, label] of results) console.log(`${pass ? "pass" : "FAIL"}  ${label}`);

console.log(`\ntool payload — all 36: ~${all} tokens`);
console.log(`tool payload — top 6:  ~${mean} mean, ~${worst} worst`);

const failed = results.filter(([pass]) => !pass).length;
if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exitCode = 1;
}
