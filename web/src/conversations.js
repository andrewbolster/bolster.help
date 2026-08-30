// Conversations, kept in the browser.
//
// Nothing here reaches the network. An unauthenticated visitor's history is
// theirs alone, which is the honest arrangement for a chat that costs them
// nothing and asks them for nothing — and it means the sidebar works before
// anyone has signed in, rather than being a feature that appears after.
//
// localStorage rather than sessionStorage: a list of past conversations that
// dies with the tab is not a list of past conversations.

const STORAGE_KEY = "bolster.help/conversations";
const MAX_TITLE = 30;

// Asking the model for a title costs an inference call, so it happens once,
// after there is enough conversation to summarise. Before that — and whenever
// the model cannot be reached — the opening question is the title. It is a
// worse title but it is never wrong, and it costs nothing.
export const TITLE_AFTER_TURNS = 3;

// Date.now() has millisecond resolution, and two conversations created or
// touched inside the same millisecond would sort arbitrarily against each
// other. Nudging forward on a tie keeps "most recent" meaning what it says.
let last = 0;
const now = () => {
  last = Math.max(Date.now(), last + 1);
  return last;
};
const id = () => `c${now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/** Trim to something that fits a sidebar row, breaking on a word where it can. */
export function fitTitle(text, limit = MAX_TITLE) {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!clean) return "New conversation";
  if (clean.length <= limit) return clean;

  const cut = clean.slice(0, limit);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > limit * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/** The fallback title: the first thing the person asked. */
export const titleFromHistory = (messages) =>
  fitTitle(messages.find((m) => m.role === "user")?.content ?? "");

export function createConversations({ storage = localStorage } = {}) {
  const read = () => {
    try {
      const parsed = JSON.parse(storage.getItem(STORAGE_KEY));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      // Corrupt or unreadable storage should cost the history, not the app.
      return [];
    }
  };

  const write = (all) => {
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(all));
    } catch {
      // Quota exhausted. Losing the write is better than losing the turn.
    }
  };

  const sorted = (all) => [...all].sort((a, b) => b.updatedAt - a.updatedAt);

  return {
    /** Every conversation, most recently touched first. */
    list() {
      return sorted(read());
    },

    get(conversationId) {
      return read().find((c) => c.id === conversationId) ?? null;
    },

    create(messages = []) {
      const conversation = {
        id: id(),
        title: messages.length ? titleFromHistory(messages) : "New conversation",
        titledByModel: false,
        messages,
        createdAt: now(),
        updatedAt: now(),
      };
      write([conversation, ...read()]);
      return conversation;
    },

    /** Replace a conversation's messages, keeping its identity and title. */
    save(conversationId, messages) {
      const all = read();
      const existing = all.find((c) => c.id === conversationId);
      if (!existing) return this.create(messages);

      existing.messages = messages;
      existing.updatedAt = now();
      // A conversation that was never titled by the model tracks its opening
      // question, which can change if the first turn was cleared and retyped.
      if (!existing.titledByModel) existing.title = titleFromHistory(messages);
      write(all);
      return existing;
    },

    rename(conversationId, title) {
      const all = read();
      const existing = all.find((c) => c.id === conversationId);
      if (!existing) return null;
      // A title the person typed is theirs: it is not replaced by the model or
      // by a changing first question.
      existing.title = fitTitle(title, 60);
      existing.titledByModel = true;
      existing.updatedAt = now();
      write(all);
      return existing;
    },

    /** Record a model-written title, unless the person has set their own. */
    setModelTitle(conversationId, title) {
      const all = read();
      const existing = all.find((c) => c.id === conversationId);
      if (!existing || existing.titledByModel) return existing ?? null;
      existing.title = fitTitle(title);
      existing.titledByModel = true;
      write(all);
      return existing;
    },

    remove(conversationId) {
      write(read().filter((c) => c.id !== conversationId));
    },

    clear() {
      write([]);
    },

    /** Whether this conversation is ready for a model-written title. */
    needsTitle(conversationId) {
      const existing = this.get(conversationId);
      if (!existing || existing.titledByModel) return false;
      return existing.messages.filter((m) => m.role === "user").length >= TITLE_AFTER_TURNS;
    },
  };
}

// Asking the model to name the conversation.
//
// This is a second inference call on a turn the visitor has already paid for,
// so it is kept as small as it can be: no tools, no history beyond the first
// exchanges, and a hard instruction to answer with nothing but the title.
//
// It is also entirely optional. The conversation already has a usable title
// from `titleFromHistory` before this is called, and anything that goes wrong
// here — no capacity, a refusal, a model that answers with a paragraph — just
// leaves that title in place. Nothing surfaces to the visitor either way.
const TITLE_INSTRUCTION =
  "Summarise what this conversation is about in at most 30 characters. "
  + "Reply with the summary alone: no quotes, no full stop, no preamble.";

export async function requestTitle(engine, messages) {
  const exchange = messages
    .filter((m) => (m.role === "user" || m.role === "assistant") && m.content)
    .slice(0, TITLE_AFTER_TURNS * 2)
    .map((m) => `${m.role === "user" ? "Q" : "A"}: ${m.content}`)
    .join("\n\n");

  const reply = await engine.chat.completions.create({
    messages: [
      { role: "system", content: TITLE_INSTRUCTION },
      { role: "user", content: exchange },
    ],
  });

  // A small model asked for a title will sometimes produce a sentence about
  // producing a title. One line, unquoted, or it does not count.
  // A quoted title ends up quoted *and* punctuated — "Marriage figures." —
  // so one pass strips the quote and leaves the full stop behind it. Peel
  // until nothing more comes off.
  let raw = String(reply?.choices?.[0]?.message?.content ?? "").trim().split("\n")[0];
  for (let peeled = ""; peeled !== raw; ) {
    peeled = raw;
    raw = raw.replace(/^["'`*_]+|["'`*_.,;:]+$/g, "").trim();
  }

  if (!raw || raw.length > 80) return null;
  return fitTitle(raw);
}
