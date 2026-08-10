// The tool-calling loop, shared by the chat UI and the bake-off harness.

import { buildIndex, search, toOpenAITools } from "./retrieval.js";

export const SYSTEM_PROMPT = [
  "You answer questions about Northern Ireland using official statistics.",
  "When a question needs data, call exactly one tool, then answer in plain English from what it returns.",
  "Quote the figures you were given; never invent numbers or fill gaps from memory.",
  "If no tool fits, say so plainly rather than guessing.",
].join(" ");

const MAX_ROUNDS = 5;
const CANDIDATES = 6;

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
        let args = {};
        try {
          args = JSON.parse(call.function.arguments || "{}");
        } catch {
          // A malformed argument string is recoverable: report it as the tool
          // result and let the model correct itself on the next round.
        }
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
