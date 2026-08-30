import { createAgent } from "./agent.js";
import { McpClient } from "./mcp.js";
import { createProxyEngine } from "./providers.js";
import { API_ORIGIN, PROXY_ENDPOINT } from "./config.js";
import { renderMarkdown } from "./markdown.js";

const el = (id) => document.getElementById(id);
const HISTORY_KEY = "bolster.help/transcript";

// There is no setup step. Inference runs on the deployment's own allocation, so
// a visitor has nothing to configure and nothing to bring — the page is the
// chat. Signing in adds one thing: somewhere to keep the conversation.
const state = { chatId: null, user: null, budget: null, agent: null };

const read = (key, fallback) => {
  try {
    return JSON.parse(sessionStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
};

const write = (key, value) => {
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Quota exhausted by a long conversation; losing scrollback is acceptable.
  }
};

// Arguments as the model sent them, short enough to sit in a summary line.
function formatArgs(args) {
  if (!args || !Object.keys(args).length) return "";
  const rendered = JSON.stringify(args);
  return rendered.length > 120 ? `${rendered.slice(0, 117)}…` : rendered.slice(1, -1);
}

function render(transcript, history) {
  transcript.replaceChildren(
    ...history.map((turn) => {
      const li = document.createElement("li");
      li.className = turn.role;
      const who = document.createElement("span");
      who.className = "who";
      who.textContent = turn.role === "user" ? "You" : "bolster.help";
      li.append(who);
      if (turn.role === "assistant" && turn.content) {
        // Models write Markdown whether or not you ask them to.
        li.append(renderMarkdown(turn.content));
      } else if (turn.content) {
        const body = document.createElement("p");
        body.textContent = turn.content;
        li.append(body);
      }
      if (turn.display) {
        const shown = document.createElement(turn.display.format === "code" ? "pre" : "div");
        shown.className = `shown ${turn.display.format}`;
        if (turn.display.caption) {
          const caption = document.createElement("span");
          caption.className = "who";
          caption.textContent = turn.display.caption;
          li.append(caption);
        }
        // textContent, never innerHTML: this is model output, and the tool
        // deliberately offers no html format for the same reason.
        shown.textContent = turn.display.content;
        li.append(shown);
      }
      if (turn.calls?.length) {
        // Folded away by default: what was asked and what came back is worth
        // being able to check, and worth not reading every time.
        const outer = document.createElement("details");
        outer.className = "calls";
        const summary = document.createElement("summary");
        summary.textContent = `${turn.calls.length} tool call${turn.calls.length === 1 ? "" : "s"}: ${turn.calls.map((c) => c.name).join(", ")}`;
        outer.append(summary);

        for (const call of turn.calls) {
          const one = document.createElement("details");
          one.className = "call";
          const label = document.createElement("summary");
          label.textContent = `${call.name}(${formatArgs(call.args)})`;
          one.append(label);

          const output = document.createElement("details");
          output.className = "call-output";
          const outputLabel = document.createElement("summary");
          outputLabel.textContent = call.result === undefined ? "no result" : `output — ${String(call.result).length} characters`;
          output.append(outputLabel);
          const pre = document.createElement("pre");
          pre.textContent = call.result ?? "";
          output.append(pre);

          one.append(output);
          outer.append(one);
        }
        li.append(outer);
      }
      return li;
    }),
  );
  transcript.lastElementChild?.scrollIntoView({ block: "end" });
}

// The allowance belongs to the deployment, not the visitor, so this needs no
// session. Failing quietly is deliberate: the Worker re-checks on every call.
async function refreshBudget() {
  try {
    const response = await fetch(`${API_ORIGIN}/usage`);
    if (response.ok) state.budget = await response.json();
  } catch {
    state.budget = null;
  }
  renderBudget();
}

function renderBudget() {
  const bar = el("budget");
  const budget = state.budget;

  if (!budget?.enabled) {
    bar.hidden = true;
    return;
  }

  const used = Math.min(budget.used / budget.limit, 1);
  bar.hidden = false;
  bar.className = budget.exhausted ? "spent" : used > 0.8 ? "low" : "";
  el("budget-fill").style.width = `${Math.max(used * 100, 1)}%`;

  const resets = new Date(budget.resetsAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  el("budget-note").textContent = budget.exhausted
    ? `Out of capacity for today — resets at ${resets}.`
    : `${Math.round((1 - used) * 100)}% of today's capacity left.`;
}

async function refreshAccount() {
  try {
    const response = await fetch(`${API_ORIGIN}/me`, { credentials: "include" });
    if (!response.ok) return;
    state.user = await response.json();
    el("signin").hidden = true;
    const who = el("whoami");
    who.hidden = false;
    who.textContent = `Signed in as ${state.user.login}`;
    el("save-chat").hidden = false;
  } catch {
    // Not signed in, or the Worker isn't reachable. The chat works either way.
  }
}

async function saveChat(history) {
  const status = el("save-state");
  status.textContent = "Saving…";
  try {
    const response = await fetch(`${API_ORIGIN}/chats`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: state.chatId,
        title: history.find((t) => t.role === "user")?.content?.slice(0, 80) ?? "Untitled",
        messages: history,
      }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.chatId = (await response.json()).id;
    status.textContent = "Saved.";
  } catch (err) {
    status.textContent = `Could not save: ${err.message}`;
  }
}

// Built once, in the background. The composer is live before this resolves; a
// message sent early waits on the same promise rather than being rejected.
async function buildAgent() {
  const engine = createProxyEngine(`${API_ORIGIN}/llm`, (budget) => {
    state.budget = { ...state.budget, ...budget, enabled: true };
    renderBudget();
  });

  const [snapshot, mcp] = await Promise.all([
    fetch("./src/tools.json").then((r) => r.json()),
    (async () => {
      const client = new McpClient(PROXY_ENDPOINT);
      await client.connect();
      return client;
    })(),
  ]);

  return createAgent({ tools: snapshot.tools, engine, mcp });
}

function main() {
  const history = read(HISTORY_KEY, []);
  const transcript = el("transcript");
  render(transcript, history);

  refreshAccount();
  refreshBudget();

  // Kick off immediately; the first message awaits whatever this settles to.
  state.agent = buildAgent().catch((err) => {
    el("progress").textContent = `Could not reach the tools: ${err.message}`;
    return null;
  });

  el("signin").addEventListener("click", () => {
    const back = encodeURIComponent(location.href);
    location.href = `${API_ORIGIN}/auth/github/login?redirect=${back}`;
  });

  el("save-chat").addEventListener("click", () => saveChat(history));

  el("composer").addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = el("prompt");
    const question = input.value.trim();
    if (!question) return;

    input.value = "";
    input.disabled = true;
    history.push({ role: "user", content: question });
    history.push({ role: "assistant", content: "…", tools: [] });
    render(transcript, history);

    const pending = history[history.length - 1];
    const calls = [];

    try {
      const agent = await state.agent;
      if (!agent) throw new Error("not connected");

      // Only plain user/assistant turns are replayed: tool payloads are large
      // and already summarised into the answer that followed them.
      const priorTurns = history.slice(0, -2).map(({ role, content }) => ({ role, content }));

      const { content } = await agent(priorTurns, question, {
        onEvent: (e) => {
          if (e.type === "tool") {
            calls.push({ name: e.name, args: e.args });
            pending.content = `Checking ${e.name}…`;
            render(transcript, history);
          }
          if (e.type === "result") {
            // Pair the output with the call it answers, so the transcript can
            // show exactly what the model was given.
            const waiting = calls.findLast((c) => c.name === e.name && c.result === undefined);
            if (waiting) waiting.result = e.content;
          }
          if (e.type === "display") {
            // Shown to the reader without passing through the model's context,
            // so it lands as its own entry rather than inside the reply.
            history.splice(history.length - 1, 0, {
              role: "assistant",
              content: "",
              display: { content: e.content, format: e.format, caption: e.caption },
            });
            render(transcript, history);
          }
        },
      });
      pending.content = content;
      pending.calls = calls;
    } catch (err) {
      pending.content = `Something went wrong: ${err.message}`;
    }

    render(transcript, history);
    write(HISTORY_KEY, history);
    input.disabled = false;
    input.focus();
  });
}

main();
