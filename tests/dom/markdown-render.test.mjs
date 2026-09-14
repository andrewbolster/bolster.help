// renderMarkdown() against a real DOM — specifically the mermaid special
// case, since that's the one branch that builds something other than a plain
// <pre><code> for a fenced block.

import { describe, expect, it } from "vitest";

import { renderMarkdown } from "../../web/src/markdown.js";

const rendered = (text) => {
  const div = document.createElement("div");
  div.append(renderMarkdown(text));
  return div;
};

describe("renderMarkdown: mermaid fences", () => {
  it("wraps a mermaid fence in a placeholder container carrying the raw source", () => {
    const div = rendered("```mermaid\ngraph TD;\n  A-->B;\n```");
    const container = div.querySelector(".mermaid-diagram");
    expect(container).not.toBeNull();
    expect(container.dataset.mermaidSource).toBe("graph TD;\n  A-->B;");
  });

  it("shows the raw source as a code block until (and unless) it's upgraded", () => {
    const div = rendered("```mermaid\ngraph TD;\n  A-->B;\n```");
    const code = div.querySelector(".mermaid-diagram pre code");
    expect(code.textContent).toBe("graph TD;\n  A-->B;");
  });

  it("does not carry mermaid-rendered or mermaid-failed until mermaid.js says so", () => {
    const div = rendered("```mermaid\ngraph TD;\n  A-->B;\n```");
    const container = div.querySelector(".mermaid-diagram");
    expect(container.classList.contains("mermaid-rendered")).toBe(false);
    expect(container.classList.contains("mermaid-failed")).toBe(false);
  });

  it("leaves a non-mermaid fence as a plain code block, unaffected", () => {
    const div = rendered("```js\nconst x = 1;\n```");
    expect(div.querySelector(".mermaid-diagram")).toBeNull();
    const pre = div.querySelector("pre");
    expect(pre.querySelector("code").textContent).toBe("const x = 1;");
  });
});
