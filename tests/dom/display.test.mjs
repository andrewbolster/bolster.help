// buildDisplayNode(): what a display_output turn actually puts on the page.
//
// Extracted out of app.js's render() specifically so this could be tested
// directly, the same way markdown.js separates parsing from rendering.
// Exists because of a real bug: format: "markdown" was previously dumped via
// .textContent regardless of what format actually said, so a table shown
// this way never rendered — and if the model also restated it in prose
// (despite display_output's own "you do not need to repeat it"), the same
// content appeared once raw, once rendered.

import { describe, expect, it } from "vitest";

import { buildDisplayNode } from "../../web/src/app.js";

const rendered = (display) => {
  const div = document.createElement("div");
  div.append(buildDisplayNode(display, document));
  return div;
};

describe("buildDisplayNode", () => {
  it("renders format: markdown through the real Markdown pipeline", () => {
    const div = rendered({ content: "**bold**", format: "markdown" });
    const strong = div.querySelector(".shown.markdown strong");
    expect(strong).not.toBeNull();
    expect(strong.textContent).toBe("bold");
  });

  it("renders a markdown table as an actual <table>, not raw pipe syntax", () => {
    const div = rendered({
      content: "| a | b |\n|---|---|\n| 1 | 2 |",
      format: "markdown",
    });
    expect(div.querySelector(".shown.markdown table")).not.toBeNull();
    expect(div.textContent).not.toContain("|---|");
  });

  it("wraps a mermaid fence shown via display_output the same way inline prose does", () => {
    const div = rendered({ content: "```mermaid\ngraph TD;\n  A-->B;\n```", format: "markdown" });
    expect(div.querySelector(".shown.markdown .mermaid-diagram")).not.toBeNull();
  });

  it("keeps format: code literal — markdown syntax is not interpreted", () => {
    const div = rendered({ content: "**not bold**", format: "code" });
    const pre = div.querySelector("pre.shown.code");
    expect(pre.textContent).toBe("**not bold**");
    expect(pre.querySelector("strong")).toBeNull();
  });

  it("keeps format: text literal — markdown syntax is not interpreted", () => {
    const div = rendered({ content: "**not bold**", format: "text" });
    const shown = div.querySelector("div.shown.text");
    expect(shown.textContent).toBe("**not bold**");
    expect(shown.querySelector("strong")).toBeNull();
  });

  it("shows the caption when one is given", () => {
    const div = rendered({ content: "x", format: "text", caption: "Results" });
    expect(div.querySelector(".who").textContent).toBe("Results");
  });

  it("omits the caption element when none is given", () => {
    const div = rendered({ content: "x", format: "text" });
    expect(div.querySelector(".who")).toBeNull();
  });
});
