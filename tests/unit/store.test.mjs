// The tool output store.
//
// What is being tested is the judgement, not the plumbing: when output is
// small enough to hand over whole, what the model is told when it is not, and
// that a stale or wrong handle fails loudly rather than returning some other
// table.

import { describe, it, expect } from "vitest";

import { createStore, isStoreTool, STORE_TOOLS } from "../../web/src/store.js";

const csv = (rows) => ["month,sex,births", ...Array.from({ length: rows }, (_, i) => `2006-${i}-01,Persons,${1800 + i}`)].join("\n");

describe("what reaches the conversation", () => {
  it("passes small output straight through", () => {
    const store = createStore();
    const short = "There were 21,563 births.";
    expect(store.put("bolster_nisra_births", short)).toBe(short);
    expect(store.size).toBe(0);
  });

  it("stores large output and returns a handle, a shape and a preview", () => {
    const store = createStore();
    const out = store.put("bolster_nisra_births", csv(700));

    expect(out).toMatch(/Stored as nisra_births#1/);
    expect(out).toMatch(/701 lines/);
    expect(out).toMatch(/month,sex,births/);
    // The whole point: 17KB of CSV becomes a few hundred characters of context.
    expect(out.length).toBeLessThan(600);
    expect(store.size).toBe(1);
  });

  // The failure this exists to prevent: the model quoted "Total records: 741"
  // as a count of births, having been handed a header that reads like an answer.
  it("warns against quoting the summary lines as an answer", () => {
    const store = createStore();
    const out = store.put("births", `Total records: 741\n${csv(700)}`);
    expect(out).toMatch(/describe the output rather than the data/);
  });

  it("strips the bolster_ prefix so handles stay short", () => {
    const store = createStore();
    expect(store.put("bolster_nisra_emergency_care", csv(500))).toMatch(/nisra_emergency_care#1/);
  });
});

describe("offering the tools", () => {
  // The set does not vary with what is stored: a tool list that changes shape
  // mid-conversation is harder to follow than one that does not, and a reader
  // called with no handle explains itself.
  it("offers the same tools before and after anything is stored", () => {
    const store = createStore();
    expect(store.tools()).toHaveLength(STORE_TOOLS.length);
    store.put("x", csv(500));
    expect(store.tools()).toHaveLength(STORE_TOOLS.length);
  });

  it("explains itself when a reader is called with nothing stored", () => {
    expect(() => createStore().call("search_output", { handle: "x#1", pattern: "y" })).toThrow(/Nothing is stored/);
  });

  it("recognises its own tool names and no others", () => {
    expect(isStoreTool("read_output")).toBe(true);
    expect(isStoreTool("search_output")).toBe(true);
    expect(isStoreTool("bolster_nisra_births")).toBe(false);
  });
});

describe("reading stored output", () => {
  const seeded = () => {
    const store = createStore();
    store.put("births", csv(700));
    return store;
  };

  it("reads a window of lines and says where it is", () => {
    const out = seeded().call("read_output", { handle: "births#1", start: 3, lines: 2 });
    expect(out).toMatch(/lines 3-4 of 701/);
    expect(out.split("\n")).toHaveLength(3);
  });

  it("defaults to the top and caps the window", () => {
    const out = seeded().call("read_output", { handle: "births#1", lines: 9999 });
    expect(out).toMatch(/lines 1-200 of 701/);
  });

  it("says so rather than returning nothing past the end", () => {
    expect(seeded().call("read_output", { handle: "births#1", start: 5000 })).toMatch(/past the end/);
  });

  it("finds matching lines with their numbers", () => {
    const out = seeded().call("search_output", { handle: "births#1", pattern: "2006-5-01" });
    expect(out).toMatch(/match\(es\)/);
    expect(out).toMatch(/^\d+: 2006-5-01/m);
  });

  it("reports no match plainly instead of erroring", () => {
    expect(seeded().call("search_output", { handle: "births#1", pattern: "zzzz" })).toMatch(/No lines/);
  });

  // A model reaching for regex punctuation should get an answer, not a stack
  // trace, so an uncompilable pattern degrades to a substring search.
  it("falls back to substring search on an invalid regex", () => {
    const out = seeded().call("search_output", { handle: "births#1", pattern: "births[" });
    expect(out).toMatch(/No lines|match/);
  });
});

describe("failing safely", () => {
  it("names the available handles when given a wrong one", () => {
    const store = createStore();
    store.put("births", csv(500));
    expect(() => store.call("read_output", { handle: "nope#9" })).toThrow(/Available: births#1/);
  });

  it("says nothing is stored when nothing is", () => {
    expect(() => createStore().call("read_output", { handle: "x#1" })).toThrow(/Nothing is stored/);
  });

  // Bounded so a long conversation cannot grow without limit. Evicting the
  // oldest is safe because a stale handle throws; it cannot silently resolve
  // to a different table.
  it("evicts the oldest handle beyond the cap", () => {
    const store = createStore({ maxObjects: 2 });
    store.put("a", csv(500));
    store.put("b", csv(500));
    store.put("c", csv(500));
    expect(store.size).toBe(2);
    expect(() => store.call("read_output", { handle: "a#1" })).toThrow(/No such output/);
    expect(store.call("read_output", { handle: "c#3", lines: 1 })).toMatch(/lines 1-1/);
  });
});

describe("partial results announce themselves", () => {
  // Observed live: the model searched a monthly table for "2024", got the
  // default 20 of 36 matching rows, and reported January as the year total.
  // A truncated result that does not say it is truncated reads as complete.
  it("says how many matches were withheld", () => {
    const store = createStore();
    const rows = Array.from({ length: 36 }, (_, i) => `2024-${i}-01,Persons,${2000 + i}`);
    store.put("births", ["month,sex,births", ...rows, ...Array.from({ length: 700 }, () => "2019-01-01,Persons,1")].join("\n"));

    const out = store.call("search_output", { handle: "births#1", pattern: "^2024", limit: 20 });
    expect(out).toMatch(/Showing 20 of 36 matches/);
    expect(out).toMatch(/raise limit/);
  });

  it("does not claim truncation when everything fits", () => {
    const store = createStore();
    store.put("births", ["header", "2024-01-01,Persons,2002", ...Array.from({ length: 700 }, () => "x")].join("\n"));
    const out = store.call("search_output", { handle: "births#1", pattern: "2024" });
    expect(out).toMatch(/1 match\(es\)/);
    expect(out).not.toMatch(/Showing/);
  });
});

describe("line endings", () => {
  // Output is LF today, but csv.writer defaults to CRLF upstream. Normalising
  // on the way in keeps stray carriage returns out of what the model reads.
  it("normalises CRLF so it never reaches the model", () => {
    const store = createStore();
    const rows = Array.from({ length: 60 }, (_, i) => `2024-01-01,Persons,${900 + i}`);
    store.put("t", ["banner", "month,sex,births", ...rows, ...rows].join("\r\n"));

    const read = store.call("read_output", { handle: "t#1", lines: 5 });
    expect(read).not.toMatch(/\r/);
    expect(store.call("search_output", { handle: "t#1", pattern: "2024" })).not.toMatch(/\r/);
    expect(store.call("aggregate_output", { handle: "t#1", column: "births", op: "count" })).toMatch(/= 120/);
  });
});

describe("write_output as working memory", () => {
  const seeded = () => {
    const store = createStore();
    store.put("bolster_nisra_marriages", ["date,year,marriages", ...Array.from({ length: 120 }, (_, i) => `2024-01-01,2024,${i}`)].join("\n"));
    return store;
  };

  it("writes and reads back a note", () => {
    const store = seeded();
    expect(store.call("write_output", { handle: "notes", text: "2023 total = 7494" })).toMatch(/Wrote notes/);
    expect(store.call("read_output", { handle: "notes" })).toMatch(/2023 total = 7494/);
  });

  it("appends without losing what was there", () => {
    const store = seeded();
    store.call("write_output", { handle: "notes", text: "a" });
    store.call("write_output", { handle: "notes", text: "b", append: true });
    const read = store.call("read_output", { handle: "notes" });
    expect(read).toMatch(/a/);
    expect(read).toMatch(/b/);
    expect(read).toMatch(/lines 1-2 of 2/);
  });

  it("replaces when not appending", () => {
    const store = seeded();
    store.call("write_output", { handle: "notes", text: "first" });
    store.call("write_output", { handle: "notes", text: "second" });
    expect(store.call("read_output", { handle: "notes" })).not.toMatch(/first/);
  });

  // Tool output is evidence. If the model could overwrite it, a later read
  // would return something the model wrote, indistinguishable from what the
  // tool actually said.
  it("refuses to overwrite tool output", () => {
    const store = seeded();
    expect(() => store.call("write_output", { handle: "nisra_marriages#1", text: "nope" })).toThrow(/cannot be written to/);
    expect(store.call("read_output", { handle: "nisra_marriages#1", lines: 1 })).toMatch(/date,year,marriages/);
  });

  it("needs a handle", () => {
    expect(() => seeded().call("write_output", { text: "x" })).toThrow(/needs a handle/);
  });
});

describe("display_output goes to the reader, not the context", () => {
  it("hands content to the UI and tells the model only that it landed", () => {
    const shown = [];
    const store = createStore({ onDisplay: (d) => shown.push(d) });
    const table = "| Month | Marriages |\n|---|---|\n| Aug | 1044 |";

    const toModel = store.call("display_output", { content: table, caption: "2024 by month" });

    expect(shown).toHaveLength(1);
    expect(shown[0]).toEqual({ content: table, format: "markdown", caption: "2024 by month" });
    // The content itself must not come back — that would defeat the purpose.
    expect(toModel).not.toContain("Marriages");
    expect(toModel).toMatch(/Displayed 3 line\(s\) as markdown/);
  });

  // html is deliberately not offered: tool results are attacker-influenced, so
  // letting the model emit raw markup into the page is a script-injection path.
  it("accepts only the safe formats and falls back to markdown", () => {
    const shown = [];
    const store = createStore({ onDisplay: (d) => shown.push(d) });
    for (const format of ["code", "text", "html", "svg", undefined]) {
      store.call("display_output", { content: "x", format });
    }
    expect(shown.map((d) => d.format)).toEqual(["code", "text", "markdown", "markdown", "markdown"]);
  });

  it("refuses empty content", () => {
    expect(() => createStore().call("display_output", { content: "   " })).toThrow(/needs content/);
  });
});

describe("clearing", () => {
  // A conversation reset should not leave the next one holding handles from a
  // table it never fetched.
  it("forgets every handle and restarts numbering", () => {
    const store = createStore();
    store.put("births", csv(500));
    store.put("marriages", csv(500));
    expect(store.size).toBe(2);

    store.clear();

    expect(store.size).toBe(0);
    expect(() => store.call("read_output", { handle: "births#1" })).toThrow(/Nothing is stored/);
    expect(store.put("births", csv(500))).toMatch(/births#1/);
  });
});
