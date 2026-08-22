import { createAgent } from "./agent.js";
import { McpClient } from "./mcp.js";
import { createProxyEngine, createRemoteEngine, listModels } from "./providers.js";
import { API_ORIGIN, CREDENTIALS_KEY, DEFAULT_BASE_URL, PROXY_ENDPOINT } from "./config.js";

const el = (id) => document.getElementById(id);
const HISTORY_KEY = "bolster.help/transcript";

// The agent loop runs here. The server is asked for the MCP hop (the origin
// sends no CORS headers, so it is unavoidable), somewhere to keep a
// conversation once signed in, and — only for allowlisted accounts —
// inference on the deployment's own key.
const state = { chatId: null, user: null };

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

const credentials = () => ({
  baseUrl: el("base-url").value.trim() || DEFAULT_BASE_URL,
  apiKey: el("api-key").value.trim(),
  model: el("remote-model").value.trim(),
});

// Offering the shared key is the deployment's decision, not the browser's:
// /me reports whether this account may use it, and /llm re-checks on every call.
const usingSharedKey = () => Boolean(state.user?.sharedKey) && !el("use-own-key").checked;

function buildEngine() {
  if (usingSharedKey()) return createProxyEngine(`${API_ORIGIN}/llm`);

  const creds = credentials();
  if (!creds.apiKey) throw new Error("an API key is required");
  if (!creds.model) throw new Error("a model name is required");
  write(CREDENTIALS_KEY, { baseUrl: creds.baseUrl, model: creds.model });
  return createRemoteEngine(creds);
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

    if (state.user.sharedKey) {
      el("shared-note").hidden = false;
      el("remote-options").hidden = true;
    }
  } catch {
    // Not signed in, or the Worker isn't reachable. Either way the app works.
  }
}

async function saveChat(history) {
  const state_ = el("save-state");
  state_.textContent = "Saving…";
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
    const body = await response.json();
    state.chatId = body.id;
    state_.textContent = "Saved.";
  } catch (err) {
    state_.textContent = `Could not save: ${err.message}`;
  }
}

function main() {
  const remembered = read(CREDENTIALS_KEY, {});
  el("base-url").value = remembered.baseUrl ?? DEFAULT_BASE_URL;
  el("remote-model").value = remembered.model ?? "";

  el("use-own-key").addEventListener("change", (event) => {
    el("remote-options").hidden = !event.target.checked;
  });

  refreshAccount();

  const history = read(HISTORY_KEY, []);
  const transcript = el("transcript");
  render(transcript, history);

  el("signin").addEventListener("click", () => {
    const back = encodeURIComponent(location.href);
    location.href = `${API_ORIGIN}/auth/github/login?redirect=${back}`;
  });

  el("save-chat").addEventListener("click", () => saveChat(history));

  el("list-models").addEventListener("click", async () => {
    const progress = el("progress");
    try {
      const names = await listModels(credentials());
      progress.textContent = names.length
        ? `${names.length} models: ${names.slice(0, 12).join(", ")}`
        : "That endpoint listed no models.";
    } catch (err) {
      progress.textContent = `Could not list models: ${err.message}`;
    }
  });

  el("load").addEventListener("click", async () => {
    const button = el("load");
    const progress = el("progress");
    button.disabled = true;
    progress.textContent = "Starting…";

    try {
      const [engine, snapshot, mcp] = await Promise.all([
        buildEngine(),
        fetch("./src/tools.json").then((r) => r.json()),
        (async () => {
          const client = new McpClient(PROXY_ENDPOINT);
          await client.connect();
          return client;
        })(),
      ]);

      startChat(createAgent({ tools: snapshot.tools, engine, mcp }), history, transcript);
      el("setup").hidden = true;
      el("chat").hidden = false;
      el("prompt").focus();
    } catch (err) {
      progress.textContent = `Could not start: ${err.message}`;
      button.disabled = false;
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
      const priorTurns = history.slice(0, -2).map(({ role, content }) => ({ role, content }));

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
    write(HISTORY_KEY, history);
    input.disabled = false;
    input.focus();
  });
}

main();
