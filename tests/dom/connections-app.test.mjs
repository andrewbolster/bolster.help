// Connections in the page: who sees the button, what a connected server adds to
// what the model is offered, what the Worker is never sent, and what signing
// out takes with it.

import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { STORE_KEY } from "../../web/src/connections.js";

const PAGE = readFileSync("web/index.html", "utf8");

function markupOnly(html) {
  const template = document.createElement("template");
  template.innerHTML = html;
  for (const node of template.content.querySelectorAll("script, link, title, meta")) node.remove();
  return template.innerHTML;
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));
const flush = async () => {
  for (let i = 0; i < 8; i += 1) await settled();
};
const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const PUBLIC_TOOLS = [
  { name: "bolster_births", description: "Births.", inputSchema: { type: "object", properties: {} } },
];
const record = (url, id) => ({
  id,
  url,
  origin: new URL(url).origin,
  resource: url,
  issuer: "https://auth.example.com",
  meta: { issuer: "https://auth.example.com", token_endpoint: "https://auth.example.com/token" },
  registration: { client_id: "c", redirect_uri: "http://localhost/oauth/callback.html", auth_method: "none" },
  tokens: { access_token: "access-1", refresh_token: "refresh-1", expires_at: null },
  status: "connected",
});

// The Worker, the public proxy and one connected server, all canned.
function startServer({ me, serverTools, serverFails = false }) {
  const calls = [];
  const fetchMock = vi.fn((url, options = {}) => {
    const href = typeof url === "string" ? url : url.url;
    calls.push({ href, options });
    if (href.endsWith("/tools.json")) return Promise.resolve(json({ tools: PUBLIC_TOOLS }));
    if (href.endsWith("/mcp-proxy")) return Promise.resolve(json({ jsonrpc: "2.0", id: 1, result: {} }));
    if (href.endsWith("/me")) return Promise.resolve(me ? json(me) : json({ error: "not signed in" }, 401));
    if (href.endsWith("/usage")) return Promise.resolve(json({ enabled: false, model: "granite" }));
    if (href.endsWith("/auth/logout")) return Promise.resolve(new Response(null, { status: 204 }));
    if (href.endsWith("/llm")) {
      return Promise.resolve(json({ choices: [{ message: { role: "assistant", content: "ok", tool_calls: [] } }] }));
    }
    if (href.startsWith("https://mcp.example.com/") || href.startsWith("https://mcp.bolster.online/auth/")) {
      if (serverFails) return Promise.reject(new TypeError("Failed to fetch"));
      const body = JSON.parse(options.body);
      if (body.method === "initialize") {
        const result = { protocolVersion: "2025-06-18" };
        return Promise.resolve(json({ jsonrpc: "2.0", id: body.id, result }, 200, { "mcp-session-id": "s" }));
      }
      if (body.method === "notifications/initialized") return Promise.resolve(new Response(null, { status: 202 }));
      if (body.method === "tools/list") {
        return Promise.resolve(json({ jsonrpc: "2.0", id: body.id, result: { tools: serverTools } }));
      }
    }
    return Promise.resolve(json({}, 500));
  });
  return { fetchMock, calls };
}

async function startApp(options) {
  document.body.innerHTML = markupOnly(PAGE);
  localStorage.setItem("bolster.help/conversations", "[]");
  const server = startServer(options);
  vi.stubGlobal("fetch", server.fetchMock);
  await import("../../web/src/app.js");
  await flush();
  return server;
}

// Ask the model something and report the tool names it was offered.
async function offeredTools(server) {
  const field = document.getElementById("prompt");
  field.value = "hello";
  field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", altKey: true, bubbles: true, cancelable: true }));
  await flush();
  const llm = server.calls.find((c) => c.href.endsWith("/llm"));
  return JSON.parse(llm.options.body).tools.map((t) => t.function.name);
}

const $ = (id) => document.getElementById(id);
const SIGNED_IN = { login: "octocat", sharedKey: false, ownKey: false };

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the Connections button", () => {
  it("is for signed-in people only", async () => {
    await startApp({ me: null, serverTools: [] });
    expect($("connections").hidden).toBe(true);
  });

  it("appears once signed in", async () => {
    await startApp({ me: SIGNED_IN, serverTools: [] });
    expect($("connections").hidden).toBe(false);
  });
});

describe("a connected server", () => {
  const url = "https://mcp.example.com/mcp";
  const tools = [{ name: "search", description: "Search.", inputSchema: { type: "object", properties: {} } }];

  it("adds its tools to what the model is offered, after the public ones", async () => {
    localStorage.setItem(STORE_KEY, JSON.stringify({ "ex-1": record(url, "ex-1") }));
    const server = await startApp({ me: SIGNED_IN, serverTools: tools });
    const names = await offeredTools(server);
    expect(names).toContain("bolster_births");
    expect(names).toContain("ex-1__search");
  });

  it("is signed in with its own token, and the Worker never sees it", async () => {
    localStorage.setItem(STORE_KEY, JSON.stringify({ "ex-1": record(url, "ex-1") }));
    const server = await startApp({ me: SIGNED_IN, serverTools: tools });
    await offeredTools(server);

    const toServer = server.calls.filter((c) => c.href === url);
    expect(toServer.length).toBeGreaterThan(0);
    for (const call of toServer) expect(call.options.headers.authorization).toBe("Bearer access-1");

    const toWorker = server.calls.filter((c) => c.href.startsWith("http://127.0.0.1:8788"));
    expect(toWorker.length).toBeGreaterThan(0);
    expect(JSON.stringify(toWorker)).not.toContain("access-1");
    expect(JSON.stringify(toWorker)).not.toContain("refresh-1");
  });

  it("leaves the public tools working, and says so, when the server cannot be used", async () => {
    localStorage.setItem(STORE_KEY, JSON.stringify({ "ex-1": record(url, "ex-1") }));
    const server = await startApp({ me: SIGNED_IN, serverTools: tools, serverFails: true });
    expect($("progress").textContent).toMatch(/Could not use https:\/\/mcp\.example\.com/);
    const names = await offeredTools(server);
    expect(names).toContain("bolster_births");
    expect(names.some((n) => n.startsWith("ex-1__"))).toBe(false);
  });
});

describe("the public server's authenticated endpoint", () => {
  it("replaces the public tools rather than sending them twice", async () => {
    const authed = "https://mcp.bolster.online/auth/mcp";
    localStorage.setItem(STORE_KEY, JSON.stringify({ "b-1": record(authed, "b-1") }));
    const server = await startApp({
      me: SIGNED_IN,
      serverTools: [
        { name: "bolster_births", description: "Births (authed).", inputSchema: { type: "object", properties: {} } },
        { name: "whoami", description: "Who.", inputSchema: { type: "object", properties: {} } },
      ],
    });
    const names = await offeredTools(server);
    expect(names.filter((n) => n === "bolster_births")).toHaveLength(1);
    expect(names).toContain("whoami");
    expect(names.some((n) => n.startsWith("b-1__"))).toBe(false);
  });
});

describe("signing out", () => {
  it("clears every connection and hides the button", async () => {
    localStorage.setItem(STORE_KEY, JSON.stringify({ "ex-1": record("https://mcp.example.com/mcp", "ex-1") }));
    sessionStorage.setItem("bolster.help/mcp-pending", "{}");
    await startApp({ me: SIGNED_IN, serverTools: [] });

    $("signout").click();
    await flush();

    expect(localStorage.getItem(STORE_KEY)).toBeNull();
    expect(sessionStorage.getItem("bolster.help/mcp-pending")).toBeNull();
    expect($("connections").hidden).toBe(true);
  });
});
