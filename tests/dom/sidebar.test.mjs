// The sidebar, driven against a real DOM.
//
// Everything here is about the glue rather than the store underneath it: that
// rows render in the right order, that one delegated listener routes clicks to
// the right conversation, and that deleting the conversation you are looking at
// leaves the page in a coherent state rather than showing a transcript that no
// longer exists.

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";

// Read relative to the repo root: under happy-dom, import.meta.url is the
// page's URL rather than a file: one, so it cannot be resolved against.
const PAGE = readFileSync("web/index.html", "utf8");

const KEY = "bolster.help/conversations";
const conversation = (id, title, updatedAt, messages) => ({
  id,
  title,
  titledByModel: true,
  messages: messages ?? [{ role: "user", content: title }],
  createdAt: updatedAt,
  updatedAt,
});

const rows = () => [...document.querySelectorAll("#conversations li")];
const titles = () => rows().map((li) => li.querySelector(".conversation-open")?.firstChild.textContent);
const stored = () => JSON.parse(localStorage.getItem(KEY) ?? "[]");

// The page's own <script> and <link> would send the environment off to fetch a
// module and a stylesheet that are not what these tests are about.
//
// Parsed into a <template> and pruned through the DOM rather than pattern-matched
// out. Two reasons: HTML is not a regular language, so a regex that looks like it
// strips script tags reliably does not — `</script >` walks straight past it —
// and a template's content is an inert fragment by specification, so nothing in
// it loads or runs even before it is pruned.
function markupOnly(html) {
  const template = document.createElement("template");
  template.innerHTML = html;
  for (const node of template.content.querySelectorAll("script, link, title, meta")) node.remove();
  return template.innerHTML;
}

// Handlers that touch the agent await a promise before they touch the DOM, so
// a single microtask is not enough to see their effect.
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Load the page, seed storage, and start the app against it. */
async function startApp(seed = []) {
  document.body.innerHTML = markupOnly(PAGE);
  localStorage.setItem(KEY, JSON.stringify(seed));

  // The app reaches for /usage, /me and the tool snapshot on start. None of
  // that is what these tests are about, and a hanging fetch would leave
  // unhandled rejections behind them.
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })));

  // Importing starts the app, because the injected page has the elements its
  // entry guard looks for. Calling main() as well would bind every listener
  // twice, which is its own class of bug and not one worth writing tests
  // against a second copy of.
  await import("../../web/src/app.js");
  // The account and budget probes are fired without being awaited.
  await settled();
}

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

// Stubs leak between tests otherwise, and a URL stub in particular takes the
// constructor with it.
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the conversation list", () => {
  it("says so when there is nothing in it", async () => {
    await startApp();
    expect(rows()).toHaveLength(0);
    expect(document.getElementById("sidebar-empty").hidden).toBe(false);
  });

  it("lists conversations most recently touched first", async () => {
    await startApp([
      conversation("a", "Oldest", 1_000),
      conversation("c", "Newest", 3_000),
      conversation("b", "Middle", 2_000),
    ]);

    expect(titles()).toEqual(["Newest", "Middle", "Oldest"]);
    expect(document.getElementById("sidebar-empty").hidden).toBe(true);
  });

  // A reload should land where you left off, not on a blank page.
  it("opens the most recent conversation on load", async () => {
    await startApp([
      conversation("a", "Older", 1_000, [{ role: "user", content: "old question" }]),
      conversation("b", "Newer", 2_000, [{ role: "user", content: "new question" }]),
    ]);

    expect(document.getElementById("chat-title").textContent).toBe("Newer");
    expect(document.getElementById("transcript").textContent).toContain("new question");
    expect(rows()[0].className).toBe("current");
  });

  it("switches conversation when a row is clicked", async () => {
    await startApp([
      conversation("a", "Older", 1_000, [{ role: "user", content: "old question" }]),
      conversation("b", "Newer", 2_000, [{ role: "user", content: "new question" }]),
    ]);

    rows()[1].querySelector('[data-action="open"]').click();
    await settled();

    expect(document.getElementById("chat-title").textContent).toBe("Older");
    expect(document.getElementById("transcript").textContent).toContain("old question");
    expect(document.getElementById("transcript").textContent).not.toContain("new question");
  });
});

describe("renaming", () => {
  it("commits a new title on Enter and keeps it in storage", async () => {
    await startApp([conversation("a", "Before", 1_000)]);

    rows()[0].querySelector('[data-action="rename"]').click();
    const field = document.querySelector(".conversation-rename");
    expect(field).not.toBeNull();

    field.value = "After";
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    expect(titles()).toEqual(["After"]);
    expect(stored()[0].title).toBe("After");
  });

  it("abandons the edit on Escape", async () => {
    await startApp([conversation("a", "Before", 1_000)]);

    rows()[0].querySelector('[data-action="rename"]').click();
    const field = document.querySelector(".conversation-rename");
    field.value = "Discarded";
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    expect(titles()).toEqual(["Before"]);
    expect(stored()[0].title).toBe("Before");
  });

  it("renames the visible conversation in the header too", async () => {
    await startApp([conversation("a", "Before", 1_000)]);

    rows()[0].querySelector('[data-action="rename"]').click();
    const field = document.querySelector(".conversation-rename");
    field.value = "Renamed";
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    expect(document.getElementById("chat-title").textContent).toBe("Renamed");
  });
});

describe("deleting", () => {
  it("asks first, and does nothing when refused", async () => {
    await startApp([conversation("a", "Keep me", 1_000)]);
    vi.stubGlobal("confirm", () => false);

    rows()[0].querySelector('[data-action="delete"]').click();

    expect(titles()).toEqual(["Keep me"]);
    expect(stored()).toHaveLength(1);
  });

  it("removes the conversation when confirmed", async () => {
    await startApp([conversation("a", "One", 1_000), conversation("b", "Two", 2_000)]);
    vi.stubGlobal("confirm", () => true);

    rows()[1].querySelector('[data-action="delete"]').click();

    expect(titles()).toEqual(["Two"]);
    expect(stored().map((c) => c.id)).toEqual(["b"]);
  });

  // Deleting what you are looking at must not leave its transcript on screen.
  it("clears the view when the open conversation is deleted", async () => {
    await startApp([conversation("a", "Open one", 1_000, [{ role: "user", content: "visible question" }])]);
    vi.stubGlobal("confirm", () => true);

    rows()[0].querySelector('[data-action="delete"]').click();

    expect(document.getElementById("transcript").textContent).not.toContain("visible question");
    expect(document.getElementById("chat-title").textContent).toBe("New conversation");
    expect(rows()).toHaveLength(0);
  });

  it("leaves the view alone when a different conversation is deleted", async () => {
    await startApp([
      conversation("a", "Other", 1_000),
      conversation("b", "Open one", 2_000, [{ role: "user", content: "visible question" }]),
    ]);
    vi.stubGlobal("confirm", () => true);

    rows()[1].querySelector('[data-action="delete"]').click();

    expect(document.getElementById("transcript").textContent).toContain("visible question");
    expect(document.getElementById("chat-title").textContent).toBe("Open one");
  });
});

describe("starting a new conversation", () => {
  it("empties the view without deleting what is stored", async () => {
    await startApp([conversation("a", "Existing", 1_000, [{ role: "user", content: "old question" }])]);

    document.getElementById("new-chat").click();
    await settled();

    expect(document.getElementById("transcript").textContent).not.toContain("old question");
    expect(document.getElementById("chat-title").textContent).toBe("New conversation");
    expect(stored()).toHaveLength(1);
  });
});

describe("export", () => {
  it("opens the dialog against the row it was asked for", async () => {
    await startApp([conversation("a", "One", 1_000), conversation("b", "Two", 2_000)]);
    const dialog = document.getElementById("export-dialog");
    dialog.showModal = vi.fn();

    rows()[1].querySelector('[data-action="export"]').click();

    expect(dialog.showModal).toHaveBeenCalled();
    expect(dialog.dataset.id).toBe("a");
  });

  it("hands over a file when the dialog is accepted", async () => {
    await startApp([conversation("a", "One", 1_000)]);
    const dialog = document.getElementById("export-dialog");
    dialog.showModal = vi.fn();

    // happy-dom implements neither of these, and both are the point of the
    // step. Patch the methods onto the real URL rather than replacing it:
    // a plain object spread loses the constructor everything else needs.
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:x");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const clicked = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    rows()[0].querySelector('[data-action="export"]').click();
    dialog.returnValue = "export";
    dialog.dispatchEvent(new Event("close"));

    expect(clicked).toHaveBeenCalled();
  });

  it("does nothing when the dialog is cancelled", async () => {
    await startApp([conversation("a", "One", 1_000)]);
    const dialog = document.getElementById("export-dialog");
    dialog.showModal = vi.fn();
    const clicked = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    rows()[0].querySelector('[data-action="export"]').click();
    dialog.returnValue = "cancel";
    dialog.dispatchEvent(new Event("close"));

    expect(clicked).not.toHaveBeenCalled();
  });
});
