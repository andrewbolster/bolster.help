// The session is a bearer token. Coming back from GitHub, the page trades the
// one-time code in the URL fragment for a token, strips the fragment, and sends
// the token as `Authorization: Bearer` from then on, never as a cookie.

import { readdirSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch, authHeader, claimLoginCode } from "../../web/src/session.js";

const KEY = "bolster.help/session";
const API = "https://api.test";
const PAGE = readFileSync("web/index.html", "utf8");

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("claimLoginCode", () => {
  const where = (hash, search = "?topic=births") => ({ hash, pathname: "/chat", search });

  it("trades the code for a token, stores it and strips the fragment", async () => {
    const fetchFn = vi.fn(async () => json({ token: "tok-1" }));
    const hist = { replaceState: vi.fn() };

    expect(await claimLoginCode({ apiOrigin: API, fetchFn, loc: where("#code=abc"), hist })).toBe(true);

    expect(localStorage.getItem(KEY)).toBe("tok-1");
    expect(hist.replaceState).toHaveBeenCalledWith(null, "", "/chat?topic=births");
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe(`${API}/auth/session`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ code: "abc" });
    expect(init.headers["x-bolster-csrf"]).toBe("1");
    expect(init.headers["content-type"]).toBe("application/json");
  });

  it("does nothing, and asks for nothing, when the page has no code", async () => {
    const fetchFn = vi.fn();
    const hist = { replaceState: vi.fn() };
    expect(await claimLoginCode({ apiOrigin: API, fetchFn, loc: where(""), hist })).toBe(false);
    expect(await claimLoginCode({ apiOrigin: API, fetchFn, loc: where("#section"), hist })).toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(hist.replaceState).not.toHaveBeenCalled();
  });

  it("strips the fragment and stores nothing when the code is refused", async () => {
    const hist = { replaceState: vi.fn() };
    const fetchFn = async () => json({ error: "invalid or expired code" }, 400);
    expect(await claimLoginCode({ apiOrigin: API, fetchFn, loc: where("#code=stale"), hist })).toBe(false);
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(hist.replaceState).toHaveBeenCalled();
  });

  it("stores nothing when the Worker cannot be reached", async () => {
    const fetchFn = async () => Promise.reject(new TypeError("network"));
    expect(
      await claimLoginCode({ apiOrigin: API, fetchFn, loc: where("#code=abc"), hist: { replaceState() {} } }),
    ).toBe(false);
    expect(localStorage.getItem(KEY)).toBeNull();
  });
});

describe("apiFetch", () => {
  it("adds the bearer when there is a session and keeps the caller's headers", async () => {
    localStorage.setItem(KEY, "tok-1");
    const fetchFn = vi.fn(async () => json({}));
    await apiFetch(`${API}/me`, { headers: { "x-extra": "1" } }, fetchFn);
    expect(fetchFn.mock.calls[0][1].headers).toEqual({ authorization: "Bearer tok-1", "x-extra": "1" });
  });

  it("sends no Authorization header without a session", async () => {
    const fetchFn = vi.fn(async () => json({}));
    await apiFetch(`${API}/usage`, {}, fetchFn);
    expect(fetchFn.mock.calls[0][1].headers.authorization).toBeUndefined();
    expect(authHeader()).toEqual({});
  });
});

describe("the page, coming back from GitHub", () => {
  function markupOnly(html) {
    const template = document.createElement("template");
    template.innerHTML = html;
    for (const node of template.content.querySelectorAll("script, link, title, meta")) node.remove();
    return template.innerHTML;
  }
  const flush = async () => {
    for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  };

  async function startApp({ me = json({ error: "not signed in" }, 401), exchange = json({ token: "tok-new" }) } = {}) {
    document.body.innerHTML = markupOnly(PAGE);
    localStorage.setItem("bolster.help/conversations", "[]");
    const calls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url, options = {}) => {
        const href = typeof url === "string" ? url : url.url;
        calls.push({ href, options });
        if (href.endsWith("/tools.json")) return Promise.resolve(json({ tools: [] }));
        if (href.endsWith("/mcp-proxy")) return Promise.resolve(json({ jsonrpc: "2.0", id: 1, result: {} }));
        if (href.endsWith("/auth/session")) return Promise.resolve(exchange);
        if (href.endsWith("/me")) return Promise.resolve(me);
        if (href.endsWith("/usage")) return Promise.resolve(json({ enabled: false, model: "granite" }));
        return Promise.resolve(json({}, 500));
      }),
    );
    vi.resetModules();
    await import("../../web/src/app.js");
    await flush();
    return calls;
  }

  afterEach(() => {
    location.hash = "";
  });

  it("exchanges the code, strips the fragment and sends the token on /me and /usage", async () => {
    location.hash = "#code=abc";
    const calls = await startApp({ me: json({ login: "octocat", sharedKey: false, ownKey: false }) });

    const order = calls.map((c) => c.href.replace(/^.*\//, ""));
    expect(order.indexOf("session")).toBeGreaterThan(-1);
    expect(order.indexOf("session")).toBeLessThan(order.indexOf("me"));
    expect(location.hash).toBe("");
    expect(localStorage.getItem(KEY)).toBe("tok-new");

    for (const name of ["/me", "/usage"]) {
      expect(calls.find((c) => c.href.endsWith(name)).options.headers.authorization).toBe("Bearer tok-new");
    }
    expect(document.getElementById("whoami").textContent).toBe("Signed in as octocat");
    expect(document.getElementById("signin").hidden).toBe(true);
  });

  it("clears a token the Worker no longer recognises and offers Sign in", async () => {
    localStorage.setItem(KEY, "tok-old");
    await startApp({ me: json({ error: "not signed in" }, 401) });
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(document.getElementById("signin").hidden).toBe(false);
    expect(document.getElementById("signout").hidden).toBe(true);
  });

  it("behaves as signed out, with no Authorization header, when there is no token", async () => {
    const calls = await startApp();
    expect(calls.find((c) => c.href.endsWith("/me")).options.headers.authorization).toBeUndefined();
    expect(calls.some((c) => c.href.endsWith("/auth/session"))).toBe(false);
    expect(document.getElementById("signin").hidden).toBe(false);
  });

  it("stays signed out when the code is refused", async () => {
    location.hash = "#code=stale";
    await startApp({ exchange: json({ error: "invalid or expired code" }, 400) });
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(location.hash).toBe("");
    expect(document.getElementById("signin").hidden).toBe(false);
  });
});

describe("no cookies", () => {
  it('has no `credentials: "include"` left in the page code', () => {
    const files = readdirSync("web/src").filter((name) => name.endsWith(".js"));
    for (const name of files) {
      expect(readFileSync(`web/src/${name}`, "utf8"), name).not.toContain('credentials: "include"');
    }
  });
});
