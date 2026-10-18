// Connected servers: signing in end to end against canned servers, and the rules
// that keep a token where it belongs.

import { describe, expect, it } from "vitest";

import { createConnections, NeedsReconnect, PENDING_KEY, STORE_KEY, serverId } from "../../web/src/connections.js";
import { json, memoryStorage, REDIRECT, SERVER, stubFetch } from "../web-helpers.mjs";

function setup(overrides = {}, { now = () => 1_000_000 } = {}) {
  const storage = memoryStorage();
  const session = memoryStorage();
  const fetchFn = stubFetch(overrides);
  const navigated = [];
  const connections = createConnections({
    redirectUri: REDIRECT,
    storage,
    session,
    fetchFn,
    now,
    navigate: (url) => navigated.push(url),
    here: () => "https://bolster.help/",
  });
  return { connections, storage, session, fetchFn, navigated };
}

// Sign in all the way: prepare, authorize, then the callback.
async function signIn(env, options = {}) {
  const prepared = await env.connections.prepare(SERVER);
  await env.connections.authorize(prepared, { returnTo: "https://bolster.help/" });
  const state = new URL(env.navigated.at(-1)).searchParams.get("state");
  const search = `?code=code-1&state=${state}${options.search ?? ""}`;
  return env.connections.complete(search);
}

describe("signing in", () => {
  it("names where you are being sent before anything is stored or sent", async () => {
    const env = setup();
    const prepared = await env.connections.prepare(SERVER);
    expect(prepared).toMatchObject({
      origin: "https://mcp.example.com",
      authorizationOrigin: "https://auth.example.com",
    });
    expect(env.storage.dump()).toEqual({});
    expect(env.navigated).toEqual([]);
  });

  it("registers, then redirects with PKCE, state and the resource", async () => {
    const env = setup();
    await env.connections.authorize(await env.connections.prepare(SERVER), { returnTo: "https://bolster.help/" });
    const url = new URL(env.navigated[0]);
    expect(url.origin).toBe("https://auth.example.com");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("resource")).toBe(SERVER);
    expect(url.searchParams.get("client_id")).toBe("client-1");
    expect(url.searchParams.get("scope")).toBe("user");
    // The verifier waits in this tab's session, not in the URL.
    const pending = JSON.parse(env.session.dump()[PENDING_KEY]);
    expect(url.search).not.toContain(pending.verifier);
    expect(pending.state).toBe(url.searchParams.get("state"));
  });

  it("registers a client once per server and callback", async () => {
    const env = setup();
    for (let i = 0; i < 2; i += 1) await env.connections.authorize(await env.connections.prepare(SERVER));
    expect(env.fetchFn.calls.filter((c) => c.url.endsWith("/register"))).toHaveLength(1);
  });

  it("completes the callback, stores tokens and returns where you started", async () => {
    const env = setup();
    expect(await signIn(env)).toBe("https://bolster.help/");
    expect(env.connections.list()).toMatchObject([{ origin: "https://mcp.example.com", status: "connected" }]);
    const exchange = env.fetchFn.calls.find((c) => c.url.endsWith("/token"));
    expect(new URLSearchParams(exchange.init.body).get("code_verifier")).toBeTruthy();
  });

  it("refuses a callback whose state does not match", async () => {
    const env = setup();
    await env.connections.authorize(await env.connections.prepare(SERVER));
    await expect(env.connections.complete("?code=code-1&state=forged")).rejects.toThrow(/did not match/);
    expect(env.fetchFn.calls.some((c) => c.url.endsWith("/token"))).toBe(false);
  });

  it("lets a pending sign-in be used once", async () => {
    const env = setup();
    await signIn(env);
    await expect(env.connections.complete("?code=code-2&state=anything")).rejects.toThrow(/no sign-in is in progress/);
  });

  it("refuses a response from a different authorization server", async () => {
    const env = setup();
    await expect(signIn(env, { search: "&iss=https%3A%2F%2Fevil.example.com" })).rejects.toThrow(
      /different authorization server/,
    );
  });

  it("reports an authorization error from the server", async () => {
    const env = setup();
    await env.connections.authorize(await env.connections.prepare(SERVER));
    await expect(env.connections.complete("?error=access_denied")).rejects.toThrow(/access_denied/);
  });

  it("never shows a token or secret through list()", async () => {
    const env = setup();
    await signIn(env);
    const text = JSON.stringify(env.connections.list());
    expect(text).not.toContain("access-1");
    expect(text).not.toContain("refresh-1");
  });
});

describe("using a token", () => {
  const ok = () => json({ result: "ok" });

  // The server answers 401 until a token is presented, as a real one does, so
  // discovery works; `handler` decides what an authorised request gets.
  async function connected(overrides = {}, options = {}) {
    const handler = overrides[`POST ${SERVER}`] ?? ok;
    const guarded = (url, init) =>
      init.headers?.authorization ? handler(url, init) : new Response(null, { status: 401 });
    const env = setup({ ...overrides, [`POST ${SERVER}`]: guarded }, options);
    await signIn(env);
    env.fetchFn.calls.length = 0;
    return { ...env, id: env.connections.list()[0].id };
  }

  it("attaches the token to its own server", async () => {
    const env = await connected();
    await env.connections.fetchFor(env.id)(SERVER, { method: "POST", body: "{}" });
    expect(env.fetchFn.calls[0].init.headers.authorization).toBe("Bearer access-1");
  });

  it("refuses to send the token to any other origin", async () => {
    const env = await connected();
    const request = env.connections.fetchFor(env.id);
    await expect(request("https://evil.example.com/mcp", { method: "POST" })).rejects.toThrow(
      /only sent to the server/,
    );
    await expect(request("https://mcp.example.com.evil.example/mcp", { method: "POST" })).rejects.toThrow(
      /only sent to the server/,
    );
    expect(env.fetchFn.calls).toEqual([]);
  });

  it("does not follow a redirect with the token", async () => {
    const env = await connected({
      [`POST ${SERVER}`]: () =>
        new Response(null, { status: 302, headers: { location: "https://evil.example.com/steal" } }),
    });
    await expect(env.connections.fetchFor(env.id)(SERVER, { method: "POST" })).rejects.toThrow(/redirected/);
    expect(env.fetchFn.calls).toHaveLength(1);
    expect(env.fetchFn.calls[0].init.redirect).toBe("manual");
  });

  it("treats an opaque redirect the same way", async () => {
    const env = await connected({
      [`POST ${SERVER}`]: () => Object.defineProperty(new Response(null), "type", { value: "opaqueredirect" }),
    });
    await expect(env.connections.fetchFor(env.id)(SERVER, { method: "POST" })).rejects.toThrow(/redirected/);
  });

  it("refreshes an expiring token before using it", async () => {
    let clock = 1_000_000;
    const env = await connected(
      {
        [`POST https://auth.example.com/token`]: (_, init) =>
          new URLSearchParams(init.body).get("grant_type") === "refresh_token"
            ? json({ access_token: "access-2", refresh_token: "refresh-2", token_type: "Bearer", expires_in: 3600 })
            : json({ access_token: "access-1", refresh_token: "refresh-1", token_type: "Bearer", expires_in: 3600 }),
      },
      { now: () => clock },
    );
    clock += 3_600_000;
    await env.connections.fetchFor(env.id)(SERVER, { method: "POST" });
    const call = env.fetchFn.calls.find((c) => c.url === SERVER);
    expect(call.init.headers.authorization).toBe("Bearer access-2");
    // Rotation: the next refresh uses the refresh token it was just given.
    clock += 3_600_000;
    await env.connections.fetchFor(env.id)(SERVER, { method: "POST" });
    const refreshes = env.fetchFn.calls
      .filter((c) => c.url.endsWith("/token"))
      .map((c) => new URLSearchParams(c.init.body).get("refresh_token"));
    expect(refreshes).toEqual(["refresh-1", "refresh-2"]);
  });

  it("refreshes once on a 401 and retries", async () => {
    let seen = 0;
    const env = await connected({
      [`POST ${SERVER}`]: (_, init) => {
        seen += 1;
        return init.headers.authorization === "Bearer access-1" ? new Response(null, { status: 401 }) : ok();
      },
      [`POST https://auth.example.com/token`]: (_, init) =>
        json({
          access_token: new URLSearchParams(init.body).get("grant_type") === "refresh_token" ? "access-2" : "access-1",
          refresh_token: "refresh-1",
          token_type: "Bearer",
        }),
    });
    const response = await env.connections.fetchFor(env.id)(SERVER, { method: "POST" });
    expect(response.status).toBe(200);
    expect(seen).toBe(2);
  });

  it("marks the connection as needing sign-in when a retry still fails", async () => {
    const env = await connected({ [`POST ${SERVER}`]: () => new Response(null, { status: 401 }) });
    await expect(env.connections.fetchFor(env.id)(SERVER, { method: "POST" })).rejects.toBeInstanceOf(NeedsReconnect);
    expect(env.connections.list()[0].status).toBe("needs-reconnect");
  });

  it("marks the connection when the refresh itself is refused", async () => {
    let clock = 1_000_000;
    const env = await connected(
      {
        [`POST https://auth.example.com/token`]: (_, init) =>
          new URLSearchParams(init.body).get("grant_type") === "refresh_token"
            ? json({ error: "invalid_grant" }, 400)
            : json({ access_token: "access-1", refresh_token: "refresh-1", token_type: "Bearer", expires_in: 60 }),
      },
      { now: () => clock },
    );
    clock += 3_600_000;
    await expect(env.connections.fetchFor(env.id)(SERVER, { method: "POST" })).rejects.toBeInstanceOf(NeedsReconnect);
    expect(env.connections.list()[0].status).toBe("needs-reconnect");
  });
});

describe("housekeeping", () => {
  it("disconnects one server and clears everything", async () => {
    const env = setup();
    await signIn(env);
    const [{ id }] = env.connections.list();
    env.connections.disconnect(id);
    expect(env.connections.list()).toEqual([]);

    await signIn(env);
    env.connections.clearAll();
    expect(env.storage.dump()[STORE_KEY]).toBeUndefined();
    expect(env.session.dump()[PENDING_KEY]).toBeUndefined();
  });

  it("gives each server a short, stable, tool-safe id", () => {
    const id = serverId("https://mcp.example.com/mcp");
    expect(id).toBe(serverId("https://mcp.example.com/mcp/"));
    expect(id).toMatch(/^[a-z0-9-]{1,30}$/);
    expect(id).not.toBe(serverId("https://mcp.example.com/other"));
    expect(id).not.toBe(serverId("https://mcp.example.net/mcp"));
  });
});
