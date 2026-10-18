// Signing in without a cookie: the GitHub callback hands the page a single-use
// code in the URL fragment, the page trades it for a session token at
// POST /auth/session, and every later call carries that token as a bearer.

import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../worker/src/index.js";
import { fakeEnv, memoryKV } from "../helpers.mjs";

const PAGE = "https://bolster.help/chat?topic=births#old";

// A KV that remembers the TTL each key was written with.
function recordingKV() {
  const kv = memoryKV();
  const ttls = new Map();
  const put = kv.put;
  kv.put = async (key, value, options) => {
    ttls.set(key, options?.expirationTtl);
    return put(key, value, options);
  };
  kv.ttls = ttls;
  return kv;
}

const makeEnv = () =>
  fakeEnv({ DB: env.DB, SESSIONS: recordingKV(), GITHUB_CLIENT_ID: "client", GITHUB_CLIENT_SECRET: "secret" });

// GitHub, stubbed: the token exchange and the profile lookup.
function stubGitHub(profile = { id: 77, login: "octocat" }) {
  vi.stubGlobal("fetch", async (url) => {
    if (String(url).includes("/login/oauth/access_token")) return Response.json({ access_token: "gho_test" });
    if (String(url) === "https://api.github.com/user") return Response.json(profile);
    return new Response("unexpected", { status: 500 });
  });
}

// Walks login -> callback and returns the callback's response.
async function signIn(environment, back = PAGE) {
  const started = await worker.fetch(
    new Request(`https://api.example/auth/github/login?redirect=${encodeURIComponent(back)}`),
    environment,
  );
  const state = new URL(started.headers.get("location")).searchParams.get("state");
  return worker.fetch(new Request(`https://api.example/auth/github/callback?code=gh-code&state=${state}`), environment);
}

const codeFrom = (response) => new URLSearchParams(new URL(response.headers.get("location")).hash.slice(1)).get("code");

function exchange(environment, body, { origin = "https://bolster.help", csrf = true, type = "application/json" } = {}) {
  return worker.fetch(
    new Request("https://api.example/auth/session", {
      method: "POST",
      headers: {
        ...(origin ? { origin } : {}),
        ...(csrf ? { "x-bolster-csrf": "1" } : {}),
        "content-type": type,
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    environment,
  );
}

const me = (environment, headers) =>
  worker.fetch(
    new Request("https://api.example/me", { headers: { origin: "https://bolster.help", ...headers } }),
    environment,
  );

beforeEach(async () => {
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS users (github_id INTEGER PRIMARY KEY, login TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))",
  ).run();
  stubGitHub();
});

afterEach(() => vi.unstubAllGlobals());

describe("the GitHub callback", () => {
  it("sets no cookie and redirects back with a code in the fragment", async () => {
    const environment = makeEnv();
    const response = await signIn(environment);

    expect(response.status).toBe(302);
    expect(response.headers.get("set-cookie")).toBeNull();
    const location = new URL(response.headers.get("location"));
    expect(location.origin + location.pathname + location.search).toBe("https://bolster.help/chat?topic=births");
    expect(location.hash.startsWith("#code=")).toBe(true);
    expect(location.search).not.toContain("code");
  });

  it("never puts the session token itself in the redirect", async () => {
    const environment = makeEnv();
    const response = await signIn(environment);
    const sessionTokens = [...environment.SESSIONS.store.keys()]
      .filter((k) => k.startsWith("session:"))
      .map((k) => k.slice(8));

    expect(sessionTokens).toHaveLength(1);
    expect(response.headers.get("location")).not.toContain(sessionTokens[0]);
  });

  it("stores the one-time code for 60 seconds at most", async () => {
    const environment = makeEnv();
    const response = await signIn(environment);
    expect(environment.SESSIONS.ttls.get(`code:${codeFrom(response)}`)).toBeLessThanOrEqual(60);
  });
});

describe("POST /auth/session", () => {
  it("trades the code for a token that works as a bearer", async () => {
    const environment = makeEnv();
    const code = codeFrom(await signIn(environment));

    const traded = await exchange(environment, { code });
    expect(traded.status).toBe(200);
    const { token } = await traded.json();

    const signedIn = await me(environment, { authorization: `Bearer ${token}` });
    expect(signedIn.status).toBe(200);
    expect((await signedIn.json()).login).toBe("octocat");
  });

  it("works once: a second use of the same code fails", async () => {
    const environment = makeEnv();
    const code = codeFrom(await signIn(environment));

    expect((await exchange(environment, { code })).status).toBe(200);
    const again = await exchange(environment, { code });
    expect(again.status).toBe(400);
    expect((await again.json()).error).toBe("invalid or expired code");
  });

  it("refuses an unknown or expired code", async () => {
    const environment = makeEnv();
    const code = codeFrom(await signIn(environment));
    environment.SESSIONS.store.delete(`code:${code}`); // what the 60 second TTL does

    expect((await exchange(environment, { code })).status).toBe(400);
    expect((await exchange(environment, { code: "never-issued" })).status).toBe(400);
  });

  it.each([
    ["no code", {}, 400],
    ["a non-string code", { code: 7 }, 400],
    ["malformed JSON", "{nope", 400],
  ])("rejects a request with %s", async (_name, body, status) => {
    expect((await exchange(makeEnv(), body)).status).toBe(status);
  });

  it.each([
    ["an origin that is not allowed", { origin: "https://evil.example" }],
    ["no origin", { origin: null }],
    ["no csrf header", { csrf: false }],
    ["a non-JSON content type", { type: "text/plain" }],
  ])("rejects %s and leaves the code unspent", async (_name, options) => {
    const environment = makeEnv();
    const code = codeFrom(await signIn(environment));

    expect((await exchange(environment, { code }, options)).status).toBe(403);
    expect((await exchange(environment, { code })).status).toBe(200);
  });

  it("only answers POST", async () => {
    const response = await worker.fetch(new Request("https://api.example/auth/session"), makeEnv());
    expect(response.status).toBe(405);
  });
});

describe("the session is a bearer token", () => {
  it.each([
    ["no header", {}],
    ["an unknown token", { authorization: "Bearer nope" }],
    ["the wrong scheme", { authorization: "Basic dGVzdDp0ZXN0" }],
    ["a token with no scheme", { authorization: "test-token" }],
  ])("401s /me with %s", async (_name, headers) => {
    const environment = makeEnv();
    environment.SESSIONS.store.set("session:test-token", JSON.stringify({ github_id: 1, login: "octocat" }));
    expect((await me(environment, headers)).status).toBe(401);
  });

  it("does not accept the old session cookie", async () => {
    const environment = makeEnv();
    environment.SESSIONS.store.set("session:test-token", JSON.stringify({ github_id: 1, login: "octocat" }));
    expect((await me(environment, { cookie: "bolster_session=test-token" })).status).toBe(401);
  });

  it("answers the preflight for an Authorization header", async () => {
    const response = await worker.fetch(
      new Request("https://api.example/me", {
        method: "OPTIONS",
        headers: { origin: "https://bolster.help", "access-control-request-headers": "authorization" },
      }),
      makeEnv(),
    );
    expect(response.headers.get("access-control-allow-headers")).toContain("authorization");
  });
});
