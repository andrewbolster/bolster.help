// The tool-calling loop.

import { SYSTEM_PROMPT } from "./persona.js";
import { createStore, isStoreTool } from "./store.js";

export { SYSTEM_PROMPT };

const MAX_ROUNDS = 5;

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

export function createAgent({ tools, engine, mcp, store }) {
  // Every tool, every turn, with the description the MCP server gave it.
  const catalogue = tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema ?? { type: "object", properties: {} },
    },
  }));

  // The store is built once and outlives a turn: a follow-up question can read
  // a table fetched for the previous one, which is cheaper and more accurate
  // than fetching it again. Displays are routed to whichever turn is running,
  // since the listener arrives per call rather than per conversation.
  let emit = () => {};
  const active = store ?? createStore({ onDisplay: (display) => emit({ type: "display", ...display }) });

  return async function run(history, userMessage, { onEvent = () => {} } = {}) {
    emit = onEvent;

    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      ...history,
      { role: "user", content: userMessage },
    ];

    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      const reply = await engine.chat.completions.create({
        messages,
        tools: [...catalogue, ...active.tools()],
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
          // Reading stored output is local: it never leaves the browser and
          // never reaches the proxy.
          content = isStoreTool(name) ? active.call(name, args) : active.put(name, await mcp.callTool(name, args));
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
