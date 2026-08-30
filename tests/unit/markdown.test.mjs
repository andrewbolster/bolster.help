// Enough Markdown for what a model writes, and nothing that lets it write
// something other than text into the page.

import { describe, it, expect } from "vitest";
import { parseInline, parseMarkdown } from "../../web/src/markdown.js";

const types = (text) => parseMarkdown(text).map((b) => b.type);

describe("blocks", () => {
  it("reads headings, lists, quotes and rules", () => {
    expect(types("# Title\n\ntext\n\n- a\n- b\n\n> quoted\n\n---")).toEqual([
      "heading", "paragraph", "list", "quote", "rule",
    ]);
  });

  it("keeps a fenced block whole, emphasis and all", () => {
    const [block] = parseMarkdown("```js\nconst x = **not bold**;\n```");
    expect(block).toEqual({ type: "code", language: "js", text: "const x = **not bold**;" });
  });

  it("numbers an ordered list and not a bulleted one", () => {
    expect(parseMarkdown("1. one\n2. two")[0]).toEqual({ type: "list", ordered: true, items: ["one", "two"] });
    expect(parseMarkdown("- one")[0].ordered).toBe(false);
  });

  it("reads a table only when a divider row follows the header", () => {
    const [table] = parseMarkdown("| Month | Marriages |\n|---|---|\n| Aug | 1044 |\n| Sep | 853 |");
    expect(table).toEqual({ type: "table", header: ["Month", "Marriages"], rows: [["Aug", "1044"], ["Sep", "853"]] });

    // A sentence with pipes in it is a sentence.
    expect(types("a | b | c")).toEqual(["paragraph"]);
  });

  it("joins wrapped lines into one paragraph and splits on blank lines", () => {
    expect(types("one\ntwo\n\nthree")).toEqual(["paragraph", "paragraph"]);
  });
});

describe("inline spans", () => {
  it("reads the emphasis a model actually writes", () => {
    expect(parseInline("**7,251 marriages**")).toEqual([{ type: "strong", text: "7,251 marriages" }]);
    expect(parseInline("_italic_")).toEqual([{ type: "emphasis", text: "italic" }]);
    expect(parseInline("a `code` b").map((s) => s.type)).toEqual(["text", "code", "text"]);
  });

  it("leaves emphasis inside code alone", () => {
    expect(parseInline("`**not bold**`")).toEqual([{ type: "code", text: "**not bold**" }]);
  });

  // A link the model wrote is a link an upstream tool result can influence, so
  // only schemes that cannot execute survive as links.
  it("keeps http and mailto links, and demotes anything executable to text", () => {
    expect(parseInline("[site](https://bolster.help)")).toEqual([
      { type: "link", text: "site", href: "https://bolster.help" },
    ]);
    expect(parseInline("[mail](mailto:a@b.com)")[0].type).toBe("link");

    // What matters is that no link survives, not how the leftovers are split:
    // a URL containing a bracket leaves a stray character as text, which is
    // cosmetic. Assert the property, not the token boundaries.
    for (const href of ["javascript:alert(1)", "data:text/html;base64,PHM=", "vbscript:x", "JaVaScRiPt:x"]) {
      const spans = parseInline(`[x](${href})`);
      expect(spans.some((s) => s.type === "link")).toBe(false);
      expect(spans.every((s) => s.type === "text")).toBe(true);
    }
  });

  it("passes plain text through untouched", () => {
    expect(parseInline("nothing special here")).toEqual([{ type: "text", text: "nothing special here" }]);
  });
});

describe("markup never becomes markup", () => {
  it("treats raw HTML as text", () => {
    const blocks = parseMarkdown("<script>alert(1)</script>");
    expect(blocks).toEqual([{ type: "paragraph", text: "<script>alert(1)</script>" }]);
    // parseInline is what feeds the DOM builder, and it produces a text node.
    expect(parseInline("<img src=x onerror=alert(1)>")[0].type).toBe("text");
  });
});
