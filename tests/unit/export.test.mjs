// Exporting a conversation, with and without the tool calls.
//
// The toggle is the point: the same conversation has to come out readable when
// the calls are hidden and complete when they are shown.

import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { exportFilename, toJSON, toMarkdown } from "../../web/src/export.js";

const conversation = {
  id: "c1",
  title: "NI marriage figures",
  createdAt: Date.UTC(2026, 7, 30, 9, 15),
  updatedAt: Date.UTC(2026, 7, 30, 9, 20),
  messages: [
    { role: "user", content: "How many marriages in 2024?" },
    {
      role: "assistant",
      content: "7,251 in 2024.",
      calls: [
        {
          name: "bolster_nisra_marriages",
          args: { year: 2024 },
          result: "date,marriages\n2024-01,432",
        },
      ],
    },
  ],
};

describe("toMarkdown", () => {
  it("leads with the title and the date it started", () => {
    const text = toMarkdown(conversation);
    assert.ok(text.startsWith("# NI marriage figures\n"));
    assert.match(text, /2026-08-30 09:15/);
  });

  it("attributes both sides of the conversation", () => {
    const text = toMarkdown(conversation);
    assert.match(text, /### You\n\nHow many marriages in 2024\?/);
    assert.match(text, /### bolster\.help\n\n7,251 in 2024\./);
  });

  it("leaves the tool calls out by default", () => {
    const text = toMarkdown(conversation);
    assert.ok(!text.includes("bolster_nisra_marriages"), text);
    assert.ok(!text.includes("date,marriages"), text);
  });

  it("includes the call, its arguments and its output when asked", () => {
    const text = toMarkdown(conversation, { includeToolCalls: true });
    assert.match(text, /bolster_nisra_marriages/);
    assert.match(text, /"year": 2024/);
    assert.match(text, /date,marriages/);
  });

  // Folded, for the same reason the transcript folds them: worth being able to
  // check, not worth reading every time.
  it("folds the calls away rather than interrupting the conversation", () => {
    const text = toMarkdown(conversation, { includeToolCalls: true });
    assert.match(text, /<details>\n<summary>1 tool call<\/summary>/);
  });

  it("counts more than one call correctly", () => {
    const two = {
      ...conversation,
      messages: [
        {
          role: "assistant",
          content: "ok",
          calls: [{ name: "a" }, { name: "b" }],
        },
      ],
    };
    assert.match(toMarkdown(two, { includeToolCalls: true }), /<summary>2 tool calls<\/summary>/);
  });

  // Content shown to the reader never went through the model's context, so it
  // has no surrounding reply to carry it into the export.
  it("keeps displayed output", () => {
    const shown = {
      ...conversation,
      messages: [
        {
          role: "assistant",
          content: "",
          display: { content: "| a |\n| - |", caption: "Tools" },
        },
      ],
    };
    const text = toMarkdown(shown);
    assert.match(text, /\*\*Tools\*\*/);
    assert.match(text, /\| a \|/);
  });

  it("handles a conversation with nothing in it", () => {
    const text = toMarkdown({
      title: "Empty",
      createdAt: Date.UTC(2026, 0, 1),
      messages: [],
    });
    assert.ok(text.startsWith("# Empty"));
  });
});

describe("toJSON", () => {
  it("round-trips", () => {
    const parsed = JSON.parse(toJSON(conversation));
    assert.equal(parsed.title, "NI marriage figures");
    assert.equal(parsed.messages.length, 2);
  });

  it("drops the calls by default and keeps everything else", () => {
    const parsed = JSON.parse(toJSON(conversation));
    assert.equal(parsed.messages[1].calls, undefined);
    assert.equal(parsed.messages[1].content, "7,251 in 2024.");
  });

  it("keeps the calls when asked", () => {
    const parsed = JSON.parse(toJSON(conversation, { includeToolCalls: true }));
    assert.equal(parsed.messages[1].calls[0].result, "date,marriages\n2024-01,432");
  });
});

describe("exportFilename", () => {
  it("sorts by date and carries the title", () => {
    assert.equal(exportFilename(conversation, "md"), "2026-08-30-ni-marriage-figures.md");
  });

  it("survives a title made entirely of punctuation", () => {
    assert.equal(exportFilename({ ...conversation, title: "???" }, "json"), "2026-08-30-conversation.json");
  });

  it("does not emit path separators from a title containing them", () => {
    const name = exportFilename({ ...conversation, title: "../../etc/passwd" }, "md");
    assert.ok(!name.includes("/"), name);
  });
});
