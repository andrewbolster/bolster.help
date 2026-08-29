// The tool-calling loop.

import { buildIndex, search, toOpenAITools } from "./retrieval.js";
import { SYSTEM_PROMPT } from "./persona.js";

export { SYSTEM_PROMPT };

const MAX_ROUNDS = 5;
const CANDIDATES = 6;

// Small models sometimes emit the argument object double-encoded — a JSON
// string whose contents are themselves JSON — so parsing once yields a string
// rather than an object. Passing that on gets rejected as invalid parameters,
// which costs a whole round to recover from, so unwrap one extra layer.
//
// Anything still not an object degrades to {}: reporting that as the tool
// result lets the model correct itself, which beats throwing the turn away.
function parseArguments(raw) {
  let value = raw || "{}";
  for (let depth = 0; depth < 2; depth += 1) {
    if (typeof value !== "string") break;
    try {
      value = JSON.parse(value);
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function createAgent({ tools, engine, mcp }) {
  const index = buildIndex(tools);

  return async function run(history, userMessage, { onEvent = () => {} } = {}) {
    const candidates = search(index, userMessage, CANDIDATES).map((r) => r.tool);
    onEvent({ type: "retrieved", tools: candidates.map((t) => t.name) });

    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      ...history,
      { role: "user", content: userMessage },
    ];

    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      const reply = await engine.chat.completions.create({
        messages,
        tools: toOpenAITools(candidates),
        tool_choice: "auto",
      });

      const choice = reply.choices[0].message;
      messages.push(choice);

      const calls = choice.tool_calls ?? [];
      if (calls.length === 0) {
        onEvent({ type: "answer", content: choice.content ?? "" });
        return { messages, content: choice.content ?? "", rounds: round + 1 };
      }

      for (const call of calls) {
        const name = call.function.name;
        const args = parseArguments(call.function.arguments);
        onEvent({ type: "tool", name, args });

        let content;
        try {
          content = await mcp.callTool(name, args);
        } catch (err) {
          content = `Tool failed: ${err.message}`;
        }
        onEvent({ type: "result", name, content });
        messages.push({ role: "tool", tool_call_id: call.id, content });
      }
    }

    const exhausted = "I could not settle on an answer for that one.";
    onEvent({ type: "answer", content: exhausted });
    return { messages, content: exhausted, rounds: MAX_ROUNDS };
  };
}
