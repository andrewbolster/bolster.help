// upgradeMermaidDiagrams() against a real DOM, with a fake loader so no test
// here ever reaches the real jsDelivr CDN.

import { describe, expect, it } from "vitest";

import { renderMarkdown } from "../../web/src/markdown.js";
import { upgradeMermaidDiagrams } from "../../web/src/mermaid.js";

const containerFor = (source) => {
  const div = document.createElement("div");
  div.append(renderMarkdown(`\`\`\`mermaid\n${source}\n\`\`\``));
  return div;
};

const fakeLoader = (svg) => async () => ({
  render: async () => ({ svg }),
});

// upgradeMermaidDiagrams caches by exact source text, and that cache is
// module-level state outliving any one test — every source below must be
// unique across this whole file, or a later test's loader is silently never
// called because an earlier test already cached that exact string's result.
let unique = 0;
const freshSource = () => {
  unique += 1;
  return `graph TD;\n  A-->B; %% test-${unique}`;
};

describe("upgradeMermaidDiagrams", () => {
  it("swaps the placeholder for a real <svg> and marks it rendered", async () => {
    const root = containerFor(freshSource());
    await upgradeMermaidDiagrams(root, {
      doc: document,
      loader: fakeLoader('<svg xmlns="http://www.w3.org/2000/svg"><text>diagram</text></svg>'),
    });

    const container = root.querySelector(".mermaid-diagram");
    expect(container.classList.contains("mermaid-rendered")).toBe(true);
    expect(container.querySelector("svg")).not.toBeNull();
    expect(container.querySelector("pre")).toBeNull(); // fallback replaced, not appended alongside
  });

  it("leaves the fallback code block in place and marks it failed when render() throws", async () => {
    const source = freshSource();
    const root = containerFor(source);
    const throwingLoader = async () => ({
      render: async () => {
        throw new Error("parse error");
      },
    });
    await upgradeMermaidDiagrams(root, { doc: document, loader: throwingLoader });

    const container = root.querySelector(".mermaid-diagram");
    expect(container.classList.contains("mermaid-failed")).toBe(true);
    expect(container.classList.contains("mermaid-rendered")).toBe(false);
    expect(container.querySelector("pre code").textContent).toBe(source);
  });

  it("fails closed when mermaid returns markup that doesn't parse as SVG", async () => {
    const root = containerFor(freshSource());
    await upgradeMermaidDiagrams(root, { doc: document, loader: fakeLoader("not xml at all <<<") });

    const container = root.querySelector(".mermaid-diagram");
    expect(container.classList.contains("mermaid-failed")).toBe(true);
    expect(container.querySelector("pre")).not.toBeNull();
  });

  it("does nothing when the subtree has no pending diagrams", async () => {
    const root = document.createElement("div");
    root.innerHTML = "<p>no diagrams here</p>";
    let called = 0;
    await upgradeMermaidDiagrams(root, {
      doc: document,
      loader: async () => {
        called += 1;
        return { render: async () => ({ svg: "<svg xmlns='http://www.w3.org/2000/svg'/>" }) };
      },
    });
    expect(called).toBe(0);
  });

  // render() rebuilds the whole transcript from scratch on every tool/display
  // event within a turn — without a source-keyed cache, a diagram already on
  // screen would be recomputed (and briefly reverted to its fallback) on
  // every sibling message.
  it("only invokes the loader once for two separately-rendered instances of the same source", async () => {
    const source = freshSource();
    let calls = 0;
    const loader = async () => {
      calls += 1;
      return { render: async () => ({ svg: '<svg xmlns="http://www.w3.org/2000/svg"/>' }) };
    };

    const first = containerFor(source);
    const second = containerFor(source);
    await upgradeMermaidDiagrams(first, { doc: document, loader });
    await upgradeMermaidDiagrams(second, { doc: document, loader });

    expect(calls).toBe(1);
    expect(first.querySelector(".mermaid-diagram").classList.contains("mermaid-rendered")).toBe(true);
    expect(second.querySelector(".mermaid-diagram").classList.contains("mermaid-rendered")).toBe(true);
  });

  it("does not re-upgrade a container already marked mermaid-rendered", async () => {
    const root = containerFor(freshSource());
    let calls = 0;
    const loader = async () => {
      calls += 1;
      return { render: async () => ({ svg: '<svg xmlns="http://www.w3.org/2000/svg"/>' }) };
    };
    await upgradeMermaidDiagrams(root, { doc: document, loader });
    await upgradeMermaidDiagrams(root, { doc: document, loader }); // second pass, same live DOM
    expect(calls).toBe(1);
  });
});
