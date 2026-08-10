import { createAgent } from "./agent.js";
import { McpClient } from "./mcp.js";
import { DEFAULT_MODEL, MODELS, PROXY_ENDPOINT, WEBLLM_CDN } from "./config.js";

const el = (id) => document.getElementById(id);
const HISTORY_KEY = "bolster.help/transcript";

// WebGPU is checked before anything else loads: without it there is no point
// pulling gigabytes of weights the browser cannot use.
if (!navigator.gpu) {
  el("unsupported").hidden = false;
  el("setup").hidden = true;
} else {
  main();
}

function loadHistory() {
  try {
    return JSON.parse(sessionStorage.getItem(HISTORY_KEY)) ?? [];
  } catch {
    return [];
  }
}

// sessionStorage only. Anonymous conversations never leave the tab, which is
// both the privacy claim on the front page and what keeps traffic off the
// free-tier storage budget.
function saveHistory(history) {
  try {
    sessionStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  } catch {
    // Quota exhausted by a long conversation; losing scrollback is acceptable.
  }
}

function render(transcript, history) {
  transcript.replaceChildren(
    ...history.map((turn) => {
      const li = document.createElement("li");
      li.className = turn.role;
      const who = document.createElement("span");
      who.className = "who";
      who.textContent = turn.role === "user" ? "You" : "bolster.help";
      const body = document.createElement("p");
      body.textContent = turn.content;
      li.append(who, body);
      if (turn.tools?.length) {
        const used = document.createElement("p");
        used.className = "tools";
        used.textContent = `Asked: ${turn.tools.join(", ")}`;
        li.append(used);
      }
      return li;
    }),
  );
  transcript.lastElementChild?.scrollIntoView({ block: "end" });
}

async function main() {
  const select = el("model");
  select.replaceChildren(
    ...MODELS.map((m) => {
      const option = document.createElement("option");
      option.value = m.id;
      option.textContent = `${m.label} (${m.size})`;
      option.selected = m.id === DEFAULT_MODEL;
      return option;
    }),
  );

  const history = loadHistory();
  const transcript = el("transcript");
  render(transcript, history);

  el("load").addEventListener("click", async () => {
    const button = el("load");
    const progress = el("progress");
    button.disabled = true;
    select.disabled = true;
    progress.textContent = "Fetching the runtime…";

    try {
      const [{ CreateMLCEngine }, snapshot, mcp] = await Promise.all([
        import(/* @vite-ignore */ WEBLLM_CDN),
        fetch("./src/tools.json").then((r) => r.json()),
        (async () => {
          const client = new McpClient(PROXY_ENDPOINT);
          await client.connect();
          return client;
        })(),
      ]);

      const engine = await CreateMLCEngine(select.value, {
        initProgressCallback: (p) => {
          progress.textContent = p.text;
        },
      });

      const agent = createAgent({ tools: snapshot.tools, engine, mcp });
      startChat(agent, history, transcript);
      el("setup").hidden = true;
      el("chat").hidden = false;
      el("prompt").focus();
    } catch (err) {
      progress.textContent = `Could not start: ${err.message}`;
      button.disabled = false;
      select.disabled = false;
    }
  });
}

function startChat(agent, history, transcript) {
  const form = el("composer");
  const input = el("prompt");

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const question = input.value.trim();
    if (!question) return;

    input.value = "";
    input.disabled = true;
    history.push({ role: "user", content: question });
    history.push({ role: "assistant", content: "…", tools: [] });
    render(transcript, history);

    const pending = history[history.length - 1];
    const used = [];

    try {
      // Only the plain user/assistant turns are replayed: tool payloads are
      // large and already summarised into the answer that followed them.
      const priorTurns = history
        .slice(0, -2)
        .map(({ role, content }) => ({ role, content }));

      const { content } = await agent(priorTurns, question, {
        onEvent: (e) => {
          if (e.type === "tool") {
            used.push(e.name);
            pending.content = `Checking ${e.name}…`;
            render(transcript, history);
          }
        },
      });
      pending.content = content;
      pending.tools = used;
    } catch (err) {
      pending.content = `Something went wrong: ${err.message}`;
    }

    render(transcript, history);
    saveHistory(history);
    input.disabled = false;
    input.focus();
  });
}
