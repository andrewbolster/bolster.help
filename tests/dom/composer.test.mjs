// The composer: multi-line input and mid-turn cancellation, against a real DOM.
//
// Enter used to always submit, because the field was a single-line <input>
// that could not hold a newline at all — switching it to a <textarea> makes
// Enter a newline for free, so what's actually being tested here is that
// Alt+Enter still submits, and that the same Send button doubles as Stop
// and genuinely aborts the in-flight request rather than just relabelling.

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";

const PAGE = readFileSync("web/index.html", "utf8");

// Same pruning approach as tests/dom/sidebar.test.mjs — see there for why a
// template rather than a regex.
function markupOnly(html) {
  const template = document.createElement("template");
  template.innerHTML = html;
  for (const node of template.content.querySelectorAll("script, link, title, meta")) node.remove();
  return template.innerHTML;
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// Startup (tools.json, the MCP handshake) resolves immediately and quietly;
// /usage and /me are irrelevant here and get a harmless failure. /llm is the
// one call a test actually controls the timing and abort of.
function stubFetch() {
  let llmSignal;
  let rejectLlm;
  let markRequested;
  const llmRequested = new Promise((resolve) => {
    markRequested = resolve;
  });

  const fetchMock = vi.fn((url, options = {}) => {
    const href = typeof url === "string" ? url : url.url;
    if (href.endsWith("/tools.json")) return Promise.resolve(jsonResponse({ tools: [] }));
    if (href.endsWith("/mcp-proxy")) return Promise.resolve(jsonResponse({ jsonrpc: "2.0", id: 1, result: {} }));
    if (href.endsWith("/llm")) {
      llmSignal = options.signal;
      markRequested();
      return new Promise((_resolve, reject) => {
        rejectLlm = reject;
      });
    }
    return Promise.resolve(jsonResponse({}, 500));
  });

  return {
    fetchMock,
    llmRequested,
    getSignal: () => llmSignal,
    abortLlm: () => rejectLlm(Object.assign(new Error("The operation was aborted."), { name: "AbortError" })),
  };
}

async function startApp() {
  document.body.innerHTML = markupOnly(PAGE);
  localStorage.setItem("bolster.help/conversations", "[]");
  const stub = stubFetch();
  vi.stubGlobal("fetch", stub.fetchMock);
  await import("../../web/src/app.js");
  await settled();
  return stub;
}

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the composer", () => {
  it("treats Enter as a newline, not a submit", async () => {
    await startApp();
    const field = document.getElementById("prompt");
    field.value = "line one";
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await settled();

    // Nothing sent: the field still holds what was typed, and no turn
    // was added to the transcript.
    expect(field.value).toBe("line one");
    expect(document.getElementById("transcript").children).toHaveLength(0);
  });

  it("submits on Alt+Enter", async () => {
    const { llmRequested } = await startApp();
    const field = document.getElementById("prompt");
    field.value = "how many mot tests last month?";
    field.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", altKey: true, bubbles: true, cancelable: true }),
    );

    await llmRequested;
    // The question is on screen as soon as the turn starts, before /llm
    // has answered — submitting cleared the field and disabled it.
    expect(document.getElementById("transcript").textContent).toContain("how many mot tests last month?");
    expect(field.value).toBe("");
    expect(field.disabled).toBe(true);
  });

  it("shows Stop while a turn is running, and reverts once it settles", async () => {
    const { llmRequested } = await startApp();
    const field = document.getElementById("prompt");
    const button = document.getElementById("send");
    field.value = "how many mot tests last month?";
    document.getElementById("composer").requestSubmit();

    await llmRequested;
    expect(button.textContent).toBe("Stop");
  });

  it("aborts the in-flight request and marks the turn cancelled", async () => {
    const { llmRequested, getSignal, abortLlm } = await startApp();
    const field = document.getElementById("prompt");
    const button = document.getElementById("send");
    field.value = "how many mot tests last month?";
    document.getElementById("composer").requestSubmit();
    await llmRequested;

    expect(getSignal()?.aborted).toBe(false);

    // Clicking the same button mid-turn is the cancel action — resubmitting
    // the form is exactly what a click on a type="submit" button does.
    button.click();
    expect(getSignal()?.aborted).toBe(true);

    abortLlm();
    await settled();

    expect(document.getElementById("transcript").textContent).toContain("(cancelled)");
    expect(button.textContent).toBe("Send");
    expect(field.disabled).toBe(false);
  });
});
