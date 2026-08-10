// Scores a candidate model on tool selection, argument validity and termination.
//
// Tools are stubbed rather than really called: the question here is whether the
// model picks the right tool and fills the schema, and running 33 live NISRA
// downloads would take longer than the inference and load the origin for nothing.

import { createAgent } from "./agent.js";
import { MODELS, WEBLLM_CDN } from "./config.js";

const el = (id) => document.getElementById(id);

if (!navigator.gpu) {
  el("unsupported").hidden = false;
  el("setup").hidden = true;
} else {
  setup();
}

function validateArgs(schema, args) {
  if (!schema || typeof args !== "object" || args === null) return "no schema";
  const properties = schema.properties ?? {};
  const unknown = Object.keys(args).filter((k) => !(k in properties));
  if (unknown.length) return `unknown: ${unknown.join(", ")}`;
  const missing = (schema.required ?? []).filter((k) => !(k in args));
  if (missing.length) return `missing: ${missing.join(", ")}`;
  return "ok";
}

function setup() {
  const select = el("model");
  select.replaceChildren(
    ...MODELS.map((m) => {
      const option = document.createElement("option");
      option.value = m.id;
      option.textContent = m.label;
      return option;
    }),
  );

  el("run").addEventListener("click", () => run(select.value));
}

async function run(modelId) {
  const progress = el("progress");
  el("run").disabled = true;
  el("model").disabled = true;
  progress.textContent = "Loading runtime…";

  const [{ CreateMLCEngine }, snapshot, fixtures] = await Promise.all([
    import(/* @vite-ignore */ WEBLLM_CDN),
    fetch("./src/tools.json").then((r) => r.json()),
    fetch("./src/fixtures.json").then((r) => r.json()),
  ]);

  const engine = await CreateMLCEngine(modelId, {
    initProgressCallback: (p) => {
      progress.textContent = p.text;
    },
  });

  const schemas = new Map(snapshot.tools.map((t) => [t.name, t.inputSchema]));
  const stub = { callTool: async () => "(stubbed result — assume the data was returned)" };
  const agent = createAgent({ tools: snapshot.tools, engine, mcp: stub });

  el("results").hidden = false;
  const rows = el("rows");
  rows.replaceChildren();
  let correct = 0;
  let valid = 0;

  for (const [i, fixture] of fixtures.entries()) {
    progress.textContent = `${modelId}: ${i + 1} of ${fixtures.length}`;

    const calls = [];
    await agent([], fixture.prompt, {
      onEvent: (e) => {
        if (e.type === "tool") calls.push(e);
      },
    });

    const first = calls[0];
    const hit = first?.name === fixture.expect;
    const argCheck = first ? validateArgs(schemas.get(first.name), first.args) : "no call";
    if (hit) correct += 1;
    if (hit && argCheck === "ok") valid += 1;

    const tr = document.createElement("tr");
    for (const [text, cls] of [
      [fixture.prompt, ""],
      [fixture.expect, ""],
      [first?.name ?? "—", hit ? "pass" : "fail"],
      [argCheck, argCheck === "ok" ? "pass" : "fail"],
    ]) {
      const td = document.createElement("td");
      td.textContent = text;
      td.className = cls;
      tr.append(td);
    }
    rows.append(tr);
  }

  const n = fixtures.length;
  el("score").textContent =
    `${modelId} — correct tool ${correct}/${n}, correct tool with valid arguments ${valid}/${n}`;
  progress.textContent = "Done.";
  el("run").disabled = false;
  el("model").disabled = false;
}
