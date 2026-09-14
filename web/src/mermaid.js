// Turns a `.mermaid-diagram[data-mermaid-source]` placeholder (see
// markdown.js's renderMarkdown) into a real diagram, after it's already on
// the page.
//
// Diagram rendering is a deliberate, isolated exception to markdown.js's
// "never touches innerHTML" invariant. Mermaid's own render() returns SVG
// built from text that ultimately came from the model — public, anonymous,
// unmoderated input. securityLevel: "strict" is Mermaid's own sanitization of
// script-bearing content (labels, tooltips, click handlers) out of diagram
// source it did not author. The returned string is parsed via DOMParser into
// a detached document and the resulting node is imported in, never assigned
// through innerHTML on the live page.
//
// This is the first runtime third-party dependency in web/'s own JS —
// everything else external (mcp.bolster.online, GitHub OAuth, Cloudflare
// Workers AI) lives at the Worker layer. There's no build step for web/ (see
// .github/workflows/pages.yml), so a CDN ESM import is the only way to bring
// in a library this size without introducing a bundler. Pinned to a major
// version, not @latest, so a breaking Mermaid release can't silently change
// behaviour on a repo with nothing to catch it at CI time.
const CDN = "https://cdn.jsdelivr.net/npm/mermaid@11/+esm";

let mermaidPromise = null;
function loadMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import(CDN).then((mod) => {
      const mermaid = mod.default;
      mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });
      return mermaid;
    });
  }
  return mermaidPromise;
}

// Keyed by exact source text: app.js's render() rebuilds the whole transcript
// from scratch on every tool/display event within a turn, so a diagram
// already on screen would be recomputed — and briefly reverted to its
// fallback — on every sibling message without this, since the rebuilt DOM
// carries no memory of what was already upgraded.
const cache = new Map();
let counter = 0;

async function renderOne(source, loader) {
  if (cache.has(source)) return cache.get(source);
  const job = (async () => {
    const mermaid = await loader();
    counter += 1;
    const { svg } = await mermaid.render(`mermaid-${counter}`, source);
    const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
    if (parsed.querySelector("parsererror")) throw new Error("mermaid returned invalid SVG");
    return parsed.documentElement;
  })();
  cache.set(source, job);
  return job;
}

/**
 * Walk a freshly-rendered subtree and swap each pending diagram's fallback
 * code block for the real thing. A model can and will write invalid Mermaid
 * syntax; failure leaves the fallback <pre><code> in place, not a blank
 * space or a thrown error.
 *
 * `loader` is injectable so tests never need a real network fetch to a CDN.
 */
export async function upgradeMermaidDiagrams(root, { doc = document, loader = loadMermaid } = {}) {
  const pending = [...root.querySelectorAll(".mermaid-diagram[data-mermaid-source]:not(.mermaid-rendered)")];
  await Promise.all(
    pending.map(async (container) => {
      try {
        const svg = await renderOne(container.dataset.mermaidSource, loader);
        container.replaceChildren(doc.importNode(svg, true));
        container.classList.add("mermaid-rendered");
      } catch {
        container.classList.add("mermaid-failed"); // fallback pre/code is already there
      }
    }),
  );
}
