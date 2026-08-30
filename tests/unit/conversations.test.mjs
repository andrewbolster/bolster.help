// Conversation storage, titling and its fallback.
//
// The fallback matters more than the model path here: it is what runs on every
// conversation before the third turn, and what runs on every conversation full
// stop whenever there is no inference capacity to spare.

import { describe, it, beforeEach } from "vitest";
import assert from "node:assert/strict";

import {
  TITLE_AFTER_TURNS,
  createConversations,
  fitTitle,
  requestTitle,
  titleFromHistory,
} from "../../web/src/conversations.js";

// localStorage as a Map, which is all this code asks of it.
function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => map.set(key, value),
    removeItem: (key) => map.delete(key),
  };
}

const engineReturning = (content) => ({
  chat: { completions: { create: async () => ({ choices: [{ message: { content } }] }) } },
});

const turns = (count) =>
  Array.from({ length: count * 2 }, (_, i) =>
    i % 2 === 0
      ? { role: "user", content: `question ${i / 2}` }
      : { role: "assistant", content: `answer ${(i - 1) / 2}` });

describe("fitTitle", () => {
  it("leaves a short title alone", () => {
    assert.equal(fitTitle("Marriages in 2024"), "Marriages in 2024");
  });

  it("breaks on a word rather than mid-word", () => {
    const original = "How many marriages were registered in Northern Ireland";
    const title = fitTitle(original);

    assert.ok(title.length <= 31, title);
    assert.ok(title.endsWith("…"));
    // The kept text must be whole words: a prefix of the original that the
    // original continues with a space, not a chopped "regist".
    assert.ok(original.startsWith(`${title.slice(0, -1)} `), `cut mid-word: ${title}`);
  });

  // A single long token has no word boundary to break on, so it is cut.
  it("cuts a title with nowhere to break", () => {
    const title = fitTitle("a".repeat(60));
    assert.equal(title, `${"a".repeat(30)}…`);
  });

  it("collapses whitespace so a pasted block fits one line", () => {
    assert.equal(fitTitle("two\n\n  words"), "two words");
  });

  it("names an untitled conversation rather than returning nothing", () => {
    assert.equal(fitTitle(""), "New conversation");
    assert.equal(fitTitle(null), "New conversation");
  });
});

describe("the fallback title", () => {
  it("is the first thing the person asked", () => {
    assert.equal(titleFromHistory([{ role: "user", content: "Marriages in 2024?" }]), "Marriages in 2024?");
  });

  it("ignores a leading system message", () => {
    const title = titleFromHistory([
      { role: "system", content: "You are Andrew." },
      { role: "user", content: "Hello" },
    ]);
    assert.equal(title, "Hello");
  });
});

describe("createConversations", () => {
  let store;
  beforeEach(() => {
    store = createConversations({ storage: fakeStorage() });
  });

  it("titles a new conversation from its opening question", () => {
    const created = store.create([{ role: "user", content: "What is the NICEI?" }]);
    assert.equal(created.title, "What is the NICEI?");
  });

  it("orders by most recently touched, not by creation", () => {
    const first = store.create([{ role: "user", content: "one" }]);
    const second = store.create([{ role: "user", content: "two" }]);
    store.save(first.id, [{ role: "user", content: "one again" }]);

    assert.deepEqual(store.list().map((c) => c.id), [first.id, second.id]);
  });

  it("keeps a renamed title when the messages change", () => {
    const created = store.create([{ role: "user", content: "first question" }]);
    store.rename(created.id, "Population work");
    store.save(created.id, [{ role: "user", content: "a completely different question" }]);

    assert.equal(store.get(created.id).title, "Population work");
  });

  // Without this, a conversation whose first turn was cleared and retyped would
  // keep advertising a question that is no longer in it.
  it("tracks the opening question while still untitled", () => {
    const created = store.create([{ role: "user", content: "first question" }]);
    store.save(created.id, [{ role: "user", content: "second question" }]);

    assert.equal(store.get(created.id).title, "second question");
  });

  it("does not let the model overwrite a title someone chose", () => {
    const created = store.create([{ role: "user", content: "q" }]);
    store.rename(created.id, "Mine");
    store.setModelTitle(created.id, "The model's");

    assert.equal(store.get(created.id).title, "Mine");
  });

  it("removes a conversation and leaves the rest", () => {
    const first = store.create([{ role: "user", content: "one" }]);
    const second = store.create([{ role: "user", content: "two" }]);
    store.remove(first.id);

    assert.deepEqual(store.list().map((c) => c.id), [second.id]);
    assert.equal(store.get(first.id), null);
  });

  it("asks for a model title only once there is enough conversation", () => {
    const created = store.create(turns(TITLE_AFTER_TURNS - 1));
    assert.equal(store.needsTitle(created.id), false);

    store.save(created.id, turns(TITLE_AFTER_TURNS));
    assert.equal(store.needsTitle(created.id), true);
  });

  it("stops asking once a title has been set", () => {
    const created = store.create(turns(TITLE_AFTER_TURNS));
    store.setModelTitle(created.id, "Titled");
    assert.equal(store.needsTitle(created.id), false);
  });

  // Corrupt storage should cost the history, not the page.
  it("survives unreadable storage", () => {
    const broken = createConversations({ storage: fakeStorage({ "bolster.help/conversations": "{not json" }) });
    assert.deepEqual(broken.list(), []);
  });

  it("survives storage that refuses to write", () => {
    const full = createConversations({
      storage: {
        getItem: () => null,
        setItem: () => { throw new Error("QuotaExceededError"); },
      },
    });
    assert.doesNotThrow(() => full.create([{ role: "user", content: "q" }]));
  });
});

describe("requestTitle", () => {
  it("takes a short reply as the title", async () => {
    assert.equal(await requestTitle(engineReturning("NI marriage figures"), turns(3)), "NI marriage figures");
  });

  it("strips the quotes and full stop a model adds unbidden", async () => {
    assert.equal(await requestTitle(engineReturning('"NI marriage figures."'), turns(3)), "NI marriage figures");
  });

  it("trims a reply that overshoots the character limit", async () => {
    const title = await requestTitle(engineReturning("Northern Ireland marriage registrations by month"), turns(3));
    assert.ok(title.length <= 31, title);
  });

  // A small model asked for a title sometimes writes about writing a title.
  it("declines a reply that is clearly not a title", async () => {
    const rambling = "Certainly! Here is a short summary of the conversation you have provided above, in 30 characters.";
    assert.equal(await requestTitle(engineReturning(rambling), turns(3)), null);
  });

  it("declines an empty reply", async () => {
    assert.equal(await requestTitle(engineReturning(""), turns(3)), null);
  });

  it("takes only the first line of a multi-line reply", async () => {
    assert.equal(await requestTitle(engineReturning("Marriage figures\n\nLet me know!"), turns(3)), "Marriage figures");
  });

  // The whole point of the fallback: no capacity must not mean no title.
  it("propagates a failure for the caller to fall back from", async () => {
    const dead = { chat: { completions: { create: async () => { throw new Error("free tier exhausted"); } } } };
    await assert.rejects(() => requestTitle(dead, turns(3)));
  });
});
