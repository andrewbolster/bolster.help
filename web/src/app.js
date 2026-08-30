import { createAgent } from "./agent.js";
import { McpClient } from "./mcp.js";
import { createProxyEngine } from "./providers.js";
import { API_ORIGIN, PROXY_ENDPOINT } from "./config.js";
import { renderMarkdown } from "./markdown.js";
import { createConversations, requestTitle } from "./conversations.js";
import { download, exportFilename, toJSON, toMarkdown } from "./export.js";

const el = (id) => document.getElementById(id);

// There is no setup step. Inference runs on the deployment's own allocation, so
// a visitor has nothing to configure and nothing to bring — the page is the
// chat. Signing in adds one thing: somewhere to keep the conversation.
const state = { chatId: null, user: null, budget: null, agent: null, conversationId: null };

const conversations = createConversations();

// Nothing to clear until there is something in the transcript.
const updateClear = () => {
  const button = el("clear");
  if (button) button.hidden = !el("transcript").children.length;
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
  // When capacity is gone the bar shows full rather than whatever fraction we
  // last counted: our tally only sees what came through here, and the
  // allocation is the whole account's.
  if (budget.exhausted) el("budget-fill").style.width = "100%";
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

// What to tell someone when a turn fails. The distinction that matters is
// whether waiting helps, whether retrying helps, or whether neither does.
const FAILURES = {
  exhausted: "That's today's free capacity used up. It resets at midnight UTC — or sign in and bring your own model later.",
  unauthorised: "That's today's free capacity used up elsewhere on the same account. It resets at midnight UTC, same as running out here.",
  busy: "The model is busy. Worth trying that again in a moment.",
  misconfigured: "Something is misconfigured at my end — this one needs Andrew rather than another attempt.",
  too_long: "This conversation has got too long for the model to hold. Start a new one and it'll have room again.",
};

function explainFailure(error) {
  if (error?.reason && FAILURES[error.reason]) return FAILURES[error.reason];
  return `Something went wrong: ${error?.message ?? error}`;
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

// Conversation management
//
// The transcript on screen and the stored conversation are the same array; this
// writes it back after every turn. `history` is mutated in place throughout, so
// there is nothing to reconcile.
function persist(history) {
  if (!history.length) {
    // An empty conversation is not worth a row in the sidebar. If one was
    // already created — cleared rather than never started — drop it.
    if (state.conversationId) {
      conversations.remove(state.conversationId);
      state.conversationId = null;
    }
    renderSidebar();
    setTitle("New conversation");
    return;
  }

  const saved = state.conversationId
    ? conversations.save(state.conversationId, history)
    : conversations.create(history);

  state.conversationId = saved.id;
  setTitle(saved.title);
  renderSidebar();
}

const setTitle = (title) => {
  el("chat-title").textContent = title;
};

// The model names the conversation once, after there is enough of it to
// summarise. Until then — and if this never succeeds — the title is the
// opening question, which is already in place before this runs.
async function maybeTitle(history) {
  if (!state.conversationId || !conversations.needsTitle(state.conversationId)) return;

  try {
    const engine = state.engine;
    if (!engine) return;
    const title = await requestTitle(engine, history);
    if (!title) return;
    conversations.setModelTitle(state.conversationId, title);
    setTitle(conversations.get(state.conversationId)?.title ?? title);
    renderSidebar();
  } catch {
    // No capacity, or the model declined. The fallback title stands and the
    // visitor is told nothing, because nothing they care about has failed.
  }
}

const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const SPANS = [["day", 86_400_000], ["hour", 3_600_000], ["minute", 60_000]];

function whenever(ms) {
  const elapsed = Date.now() - ms;
  for (const [unit, size] of SPANS) {
    if (elapsed >= size) return RELATIVE.format(-Math.floor(elapsed / size), unit);
  }
  return "just now";
}

function renderSidebar() {
  const list = el("conversations");
  const all = conversations.list();

  list.replaceChildren(
    ...all.map((conversation) => {
      const li = document.createElement("li");
      li.dataset.id = conversation.id;
      if (conversation.id === state.conversationId) li.className = "current";

      const open = document.createElement("button");
      open.type = "button";
      open.className = "conversation-open";
      open.dataset.action = "open";
      open.append(document.createTextNode(conversation.title));
      const when = document.createElement("time");
      when.dateTime = new Date(conversation.updatedAt).toISOString();
      when.textContent = whenever(conversation.updatedAt);
      open.append(when);
      li.append(open);

      // A details element rather than a popup: it opens and closes without
      // JavaScript, and closes on its own when another one is opened below.
      const menu = document.createElement("details");
      menu.className = "row-menu";
      const dots = document.createElement("summary");
      dots.append(document.createTextNode("⋯"));
      const label = document.createElement("span");
      label.className = "visually-hidden";
      label.textContent = `Actions for ${conversation.title}`;
      dots.append(label);
      menu.append(dots);

      const actions = document.createElement("div");
      actions.className = "menu";
      for (const [action, text, className] of [
        ["rename", "Rename", ""],
        ["export", "Export…", ""],
        ["delete", "Delete", "danger"],
      ]) {
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.action = action;
        button.className = className;
        button.textContent = text;
        actions.append(button);
      }
      menu.append(actions);
      li.append(menu);
      return li;
    }),
  );

  el("sidebar-empty").hidden = all.length > 0;
}

/** Swap the visible conversation for a stored one. */
async function openConversation(id, history, transcript) {
  const conversation = conversations.get(id);
  if (!conversation) return;

  history.length = 0;
  history.push(...conversation.messages);
  state.conversationId = id;
  state.chatId = null;

  // Tool handles belong to the conversation that created them; carrying them
  // across would let the model read output it was never shown.
  (await state.agent)?.reset?.();

  el("save-state").textContent = "";
  el("progress").textContent = "";
  setTitle(conversation.title);
  render(transcript, history);
  renderSidebar();
  updateClear();
  el("sidebar").classList.remove("open");
}

/** Replace a row's title with an input, and commit on Enter or blur. */
function startRename(li, id) {
  const open = li.querySelector(".conversation-open");
  const field = document.createElement("input");
  field.className = "conversation-rename";
  field.value = conversations.get(id)?.title ?? "";
  field.setAttribute("aria-label", "Conversation title");

  const finish = (commit) => {
    if (commit && field.value.trim()) {
      conversations.rename(id, field.value);
      if (id === state.conversationId) setTitle(conversations.get(id).title);
    }
    renderSidebar();
  };

  field.addEventListener("keydown", (event) => {
    if (event.key === "Enter") finish(true);
    if (event.key === "Escape") finish(false);
  });
  field.addEventListener("blur", () => finish(true));

  open.replaceWith(field);
  field.focus();
  field.select();
}

function openExport(id) {
  const dialog = el("export-dialog");
  dialog.dataset.id = id;
  dialog.showModal();
}

function runExport(dialog) {
  const conversation = conversations.get(dialog.dataset.id);
  if (!conversation) return;

  const format = dialog.querySelector('input[name="format"]:checked').value;
  const includeToolCalls = el("include-calls").checked;

  const [text, type] = format === "json"
    ? [toJSON(conversation, { includeToolCalls }), "application/json"]
    : [toMarkdown(conversation, { includeToolCalls }), "text/markdown"];

  download(text, exportFilename(conversation, format === "json" ? "json" : "md"), type);
}

// Built once, in the background. The composer is live before this resolves; a
// message sent early waits on the same promise rather than being rejected.
async function buildAgent() {
  const engine = createProxyEngine(`${API_ORIGIN}/llm`, (budget) => {
    state.budget = { ...state.budget, ...budget, enabled: true };
    renderBudget();
  });
  // Titling uses the same engine, so it reports against the same budget bar.
  state.engine = engine;

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

export function main() {
  const transcript = el("transcript");

  // Open the most recent conversation, so a reload lands where you left off.
  const [latest] = conversations.list();
  const history = latest ? [...latest.messages] : [];
  state.conversationId = latest?.id ?? null;
  setTitle(latest?.title ?? "New conversation");

  render(transcript, history);
  renderSidebar();
  updateClear();

  refreshAccount();
  refreshBudget();

  // Kick off immediately; the first message awaits whatever this settles to.
  state.agent = buildAgent().catch((err) => {
    el("progress").textContent = `Could not reach the tools: ${err.message}`;
    return null;
  });

  el("sidebar-toggle").addEventListener("click", (event) => {
    const open = el("sidebar").classList.toggle("open");
    event.currentTarget.setAttribute("aria-expanded", String(open));
  });

  el("new-chat").addEventListener("click", async () => {
    history.length = 0;
    state.conversationId = null;
    state.chatId = null;
    (await state.agent)?.reset?.();
    el("save-state").textContent = "";
    el("progress").textContent = "";
    setTitle("New conversation");
    render(transcript, history);
    renderSidebar();
    updateClear();
    el("sidebar").classList.remove("open");
    el("prompt").focus();
  });

  // One listener for the whole list: rows come and go on every render, and
  // rebinding three handlers per row on each of those is work for nothing.
  el("conversations").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const li = button.closest("li");
    const id = li?.dataset.id;
    if (!id) return;

    if (button.dataset.action === "open") {
      openConversation(id, history, transcript);
      return;
    }

    li.querySelector(".row-menu")?.removeAttribute("open");

    if (button.dataset.action === "rename") startRename(li, id);
    if (button.dataset.action === "export") openExport(id);
    if (button.dataset.action === "delete") {
      const conversation = conversations.get(id);
      if (!confirm(`Delete "${conversation?.title}"? This cannot be undone.`)) return;
      conversations.remove(id);
      // Deleting the conversation on screen leaves the composer empty rather
      // than jumping to another one, which would be a surprising place to land.
      if (id === state.conversationId) {
        history.length = 0;
        state.conversationId = null;
        setTitle("New conversation");
        render(transcript, history);
        updateClear();
      }
      renderSidebar();
    }
  });

  el("export-dialog").addEventListener("close", (event) => {
    if (event.currentTarget.returnValue === "export") runExport(event.currentTarget);
  });

  el("signin").addEventListener("click", () => {
    const back = encodeURIComponent(location.href);
    location.href = `${API_ORIGIN}/auth/github/login?redirect=${back}`;
  });

  el("save-chat").addEventListener("click", () => saveChat(history));

  // Clear empties the conversation on screen without deleting it from the
  // list — that is what the row's Delete is for. The agent's stored tool
  // output goes too: handles from an abandoned line of enquiry would otherwise
  // survive into the next question.
  el("clear").addEventListener("click", async () => {
    history.length = 0;
    state.chatId = null;
    persist(history);
    (await state.agent)?.reset?.();
    el("save-state").textContent = "";
    el("progress").textContent = "";
    render(transcript, history);
    updateClear();
    el("prompt").focus();
  });

  el("composer").addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = el("prompt");
    const question = input.value.trim();
    if (!question) return;

    input.value = "";
    input.disabled = true;
    history.push({ role: "user", content: question });
    history.push({ role: "assistant", content: "…", calls: [] });
    render(transcript, history);
    updateClear();

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
      pending.content = explainFailure(err);
      // A failure that means capacity is gone should be reflected in the bar,
      // which otherwise goes on reporting whatever it last saw.
      if (err?.reason === "exhausted" || err?.reason === "unauthorised") {
        state.budget = { ...state.budget, enabled: true, exhausted: true };
        renderBudget();
      }
    }

    render(transcript, history);
    persist(history);
    updateClear();
    input.disabled = false;
    input.focus();

    // Titling happens after the turn is on screen and stored, so a failure
    // here costs nothing that has not already been kept.
    maybeTitle(history);
  });
}

// The page runs it; a test imports the module and calls it against a DOM of
// its own, having stubbed the network first.
if (typeof document !== "undefined" && document.getElementById("composer")) main();
