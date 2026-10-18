// Signing out: the button exists only while signed in, calls the Worker the way
// a state-changing request must, and puts the page back as an anonymous visitor
// sees it.

import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const PAGE = readFileSync("web/index.html", "utf8");

function markupOnly(html) {
  const template = document.createElement("template");
  template.innerHTML = html;
  for (const node of template.content.querySelectorAll("script, link, title, meta")) node.remove();
  return template.innerHTML;
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));
const flush = async () => {
  for (let i = 0; i < 5; i += 1) await settled();
};
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const TOKEN_KEY = "bolster.help/session";

// `me` is what /me answers; `logout` is what POST /auth/logout answers; `token`
// is the session token already in storage.
async function startApp({ me, logout = () => new Response(null, { status: 204 }), token = null }) {
  document.body.innerHTML = markupOnly(PAGE);
  localStorage.setItem("bolster.help/conversations", "[]");
  if (token) localStorage.setItem(TOKEN_KEY, token);
  const calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url, options = {}) => {
      const href = typeof url === "string" ? url : url.url;
      calls.push({ href, options });
      if (href.endsWith("/tools.json")) return Promise.resolve(json({ tools: [] }));
      if (href.endsWith("/mcp-proxy")) return Promise.resolve(json({ jsonrpc: "2.0", id: 1, result: {} }));
      if (href.endsWith("/me")) return Promise.resolve(me ? json(me) : json({ error: "not signed in" }, 401));
      if (href.endsWith("/usage")) return Promise.resolve(json({ enabled: false, model: "granite" }));
      if (href.endsWith("/auth/logout")) return Promise.resolve(logout());
      if (href.endsWith("/llm-config")) return Promise.resolve(json({ configured: false }));
      return Promise.resolve(json({}, 500));
    }),
  );
  await import("../../web/src/app.js");
  await flush();
  return calls;
}

const $ = (id) => document.getElementById(id);
const SIGNED_IN = { login: "octocat", sharedKey: false, ownKey: false };

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the account area", () => {
  it("offers only Sign in to an anonymous visitor", async () => {
    await startApp({ me: null });
    expect($("signin").hidden).toBe(false);
    expect($("signout").hidden).toBe(true);
    expect($("whoami").hidden).toBe(true);
  });

  it("offers Sign out, not Sign in, once signed in", async () => {
    await startApp({ me: SIGNED_IN });
    expect($("signout").hidden).toBe(false);
    expect($("signin").hidden).toBe(true);
    expect($("whoami").textContent).toBe("Signed in as octocat");
  });
});

describe("signing out", () => {
  it("POSTs to /auth/logout with the bearer token and the csrf header", async () => {
    const calls = await startApp({ me: SIGNED_IN, token: "tok-1" });
    $("signout").click();
    await flush();
    const logout = calls.find((c) => c.href.endsWith("/auth/logout"));
    expect(logout.options.method).toBe("POST");
    expect(logout.options.headers.authorization).toBe("Bearer tok-1");
    expect(logout.options.headers["x-bolster-csrf"]).toBe("1");
    expect(logout.options.credentials).toBeUndefined();
  });

  it("removes the stored session token once the Worker has dropped the session", async () => {
    await startApp({ me: SIGNED_IN, token: "tok-1" });
    expect(localStorage.getItem(TOKEN_KEY)).toBe("tok-1");
    $("signout").click();
    await flush();
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
  });

  it("keeps the token when the Worker refuses, so signing out can be retried", async () => {
    await startApp({ me: SIGNED_IN, token: "tok-1", logout: () => json({ error: "origin not allowed" }, 403) });
    $("signout").click();
    await flush();
    expect(localStorage.getItem(TOKEN_KEY)).toBe("tok-1");
  });

  it("puts the page back to the signed-out state and refreshes /usage", async () => {
    const calls = await startApp({ me: { ...SIGNED_IN, ownKey: true } });
    expect($("llm-settings").hidden).toBe(false);
    $("llm-dialog").setAttribute("open", "");
    const usageBefore = calls.filter((c) => c.href.endsWith("/usage")).length;

    $("signout").click();
    await flush();

    expect($("signin").hidden).toBe(false);
    expect($("signout").hidden).toBe(true);
    expect($("whoami").hidden).toBe(true);
    expect($("save-chat").hidden).toBe(true);
    expect($("llm-settings").hidden).toBe(true);
    expect($("llm-dialog").open).toBe(false);
    expect(calls.filter((c) => c.href.endsWith("/usage")).length).toBeGreaterThan(usageBefore);
  });

  it("stays signed in and says so when the Worker refuses", async () => {
    await startApp({ me: SIGNED_IN, logout: () => json({ error: "origin not allowed" }, 403) });
    $("signout").click();
    await flush();
    expect($("signout").hidden).toBe(false);
    expect($("whoami").hidden).toBe(false);
    expect($("progress").textContent).toBe("Could not sign out. Try again.");
  });

  it("stays signed in and says so when the Worker cannot be reached", async () => {
    await startApp({
      me: SIGNED_IN,
      logout: () => Promise.reject(new TypeError("network")),
    });
    $("signout").click();
    await flush();
    expect($("signout").hidden).toBe(false);
    expect($("progress").textContent).toBe("Could not sign out. Try again.");
  });
});
