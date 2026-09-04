// The tool-calling loop.

import { DOCUMENTATION_TOOL, isDocumentationTool, lookupDocumentation, toToolSchemas } from "./catalogue.js";
import { SYSTEM_PROMPT } from "./persona.js";
import { createStore, isStoreTool } from "./store.js";

export { SYSTEM_PROMPT };

// Observed live: asked "what's Andrew's availability next week", the model
// picked a start_date over a year in the past — nothing in its context said
// what day it actually is, so it fell back to a guess. Computed fresh per
// turn rather than folded into the static SYSTEM_PROMPT string, and anchored
// to Europe/London (Andrew's timezone, and check_availability's default)
// rather than the visitor's browser clock, so "next week" means the same
// week regardless of where the visitor is.
function todayContext() {
  const now = new Date();
  const weekday = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", dateStyle: "full" }).format(now);
  const iso = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(now);
  return `Today is ${weekday} (${iso}), Europe/London time. Use this for anything relative — "next week", "tomorrow", "this month" — rather than a guess.`;
}

// A second, independent bug found while chasing the one above: granite-4.0-h-micro
// reliably (6/6 in testing) skips calling any tool at all — fabricating a plausible
// but invented answer instead — specifically for a casual-greeting-plus-question
// phrasing ("hi there, how goes it? What's..."). Drop the greeting, same question,
// and it calls the tool correctly every time. Prefixing the live user message with
// a timestamp logline, plus telling the model what that prefix means, fixed both
// the tool-skip (9/9 in testing) and reinforced the date sentence above rather than
// competing with it — the prefix alone, untold what it meant, didn't move the date
// math at all (still guessed a wrong 2025 date every time); it's the combination
// that works, not either alone. Only the live message gets prefixed, not replayed
// history: past turns carry no per-message timestamp today (only
// conversation.createdAt exists), and todayContext() above already re-anchors
// every turn to the real current date regardless of how old the conversation is,
// so there's no multi-day drift left for history-prefixing to solve.
function timestampPrefix() {
  const now = new Date();
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(now);
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(now);
  return `${date} ${time}`;
}

const PREFIX_FORMAT_NOTE =
  "User messages are prefixed with a YYYY-MM-DD HH:MM timestamp followed by a semicolon, then the user's " +
  "original message. That timestamp is when the message was sent. You do not need to respond in the same format.";

// Not a budget — a stop. A model that wants to work through a dozen tools
// should be left to, so this sits far above what any answer needs and exists
// only so a model that never stops calling tools eventually does.
export const MAX_ROUNDS = 32;

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
  // Every tool, every turn, described by its prose rather than its full
  // docstring. full_tool_documentation fetches the rest when it is wanted.
  const catalogue = [...toToolSchemas(tools), DOCUMENTATION_TOOL];

  // The store is built once and outlives a turn: a follow-up question can read
  // a table fetched for the previous one, which is cheaper and more accurate
  // than fetching it again. Displays are routed to whichever turn is running,
  // since the listener arrives per call rather than per conversation.
  let emit = () => {};
  const active =
    store ??
    createStore({
      onDisplay: (display) => emit({ type: "display", ...display }),
    });

  // Attached to the returned function rather than taken as a parameter: the
  // store belongs to the agent, and a caller resetting a conversation should
  // not have to know that it exists.
  run.reset = () => active.clear();
  return run;

  async function run(history, userMessage, { onEvent = () => {}, signal } = {}) {
    emit = onEvent;

    const messages = [
      { role: "system", content: `${SYSTEM_PROMPT}\n\n${todayContext()}\n\n${PREFIX_FORMAT_NOTE}` },
      ...history,
      { role: "user", content: `${timestampPrefix()}; ${userMessage}` },
    ];

    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      const reply = await engine.chat.completions.create({
        messages,
        tools: [...catalogue, ...active.tools()],
        tool_choice: "auto",
        signal,
      });

      const choice = reply.choices[0].message;
      messages.push(choice);

      const calls = choice.tool_calls ?? [];
      if (calls.length === 0) {
        onEvent({ type: "answer", content: choice.content ?? "" });
        return { messages, content: choice.content ?? "" };
      }

      for (const call of calls) {
        const name = call.function.name;
        const args = parseArguments(call.function.arguments);
        onEvent({ type: "tool", name, args });

        let content;
        try {
          // Reading stored output is local: it never leaves the browser and
          // never reaches the proxy.
          content = isDocumentationTool(name)
            ? lookupDocumentation(tools, args.tool)
            : isStoreTool(name)
              ? active.call(name, args)
              : active.put(name, await mcp.callTool(name, args, { signal }));
        } catch (err) {
          // A cancelled turn should stop, not report the abort as a tool
          // that merely failed and press on to the next round.
          if (err.name === "AbortError") throw err;
          content = `Tool failed: ${err.message}`;
        }
        onEvent({ type: "result", name, content });
        messages.push({ role: "tool", tool_call_id: call.id, content });
      }
    }

    // Only reached by a model that called a tool on all 32 rounds.
    const exhausted =
      "I've tried a lot of angles on that and not landed it. Want to narrow it down, or point me at something specific?";
    onEvent({ type: "answer", content: exhausted });
    return { messages, content: exhausted };
  }
}
