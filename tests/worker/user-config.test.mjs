// Per-user LLM config: who may save a key, how it is stored, and what the
// relay does with it.
//
// D1 is real (miniflare); the provider is a stubbed global fetch, because the
// only thing worth asserting about it is what the Worker sends and how it
// treats the reply. Every response and log line is checked for the key, since
// "never returned, never logged" is the property that matters most.

import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../worker/src/index.js";
import { llm, usage } from "../../worker/src/llm.js";
import { chatBody, fakeEnv, post, withSession } from "../helpers.mjs";

const KEY = "sk-test-SECRETSECRET1234";
const andrew = { github_id: 1, login: "andrewbolster" };
const octocat = { github_id: 2, login: "octocat" };
const BASE = "https://api.example.com/v1";
const secret = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));

const makeEnv = (overrides = {}) =>
  fakeEnv({ DB: env.DB, USER_CONFIG_KEY: secret, GITHUB_ALLOWED_LOGINS: "andrewbolster", ...overrides });

const seen = []; // every response body text, for the never-returned check
const logged = []; // every console argument, for the never-logged check

async function call(environment, cookie, path, options = {}) {
  const { method = "GET", body, csrf = true, origin = "https://bolster.help", type = "application/json" } = options;
  const response = await worker.fetch(
    new Request(`https://bolster.help${path}`, {
      method,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(origin ? { origin } : {}),
        ...(csrf ? { "x-bolster-csrf": "1" } : {}),
        ...(body === undefined ? {} : { "content-type": type }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    environment,
  );
  seen.push(await response.clone().text());
  return response;
}

// Replaces the provider. Returns the calls it received.
function provider(handler) {
  const calls = [];
  vi.stubGlobal("fetch", async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  });
  return calls;
}

const modelsReply = (ids) => new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }));

const save = (environment, cookie, body = {}) =>
  call(environment, cookie, "/llm-config", {
    method: "PUT",
    body: { base_url: BASE, api_key: KEY, model: "gpt-x", ...body },
  });

beforeEach(async () => {
  seen.length = 0;
  logged.length = 0;
  for (const level of ["log", "error", "warn"]) {
    vi.spyOn(console, level).mockImplementation((...args) => logged.push(JSON.stringify(args)));
  }
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS users (github_id INTEGER PRIMARY KEY, login TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))",
  ).run();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO users (github_id, login) VALUES (1, 'andrewbolster'), (2, 'octocat')",
  ).run();
  try {
    await env.DB.prepare("DELETE FROM user_llm_config").run();
  } catch {
    // the table is created on first use
  }
});

afterEach(() => {
  expect(seen.join("\n"), "a response contained the API key").not.toContain(KEY);
  expect(logged.join("\n"), "a log line contained the API key").not.toContain(KEY);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("who may use it", () => {
  it("answers 401 to an anonymous caller", async () => {
    expect((await call(makeEnv(), null, "/llm-config")).status).toBe(401);
  });

  it("answers 403 to a signed-in login that is not on the allowlist", async () => {
    const environment = makeEnv();
    const cookie = withSession(environment, octocat);
    expect((await call(environment, cookie, "/llm-config")).status).toBe(403);
    expect((await save(environment, cookie)).status).toBe(403);
    expect((await call(environment, cookie, "/llm-config/models", { method: "POST", body: {} })).status).toBe(403);
  });

  it("fails closed with 503 when USER_CONFIG_KEY is missing or malformed", async () => {
    for (const USER_CONFIG_KEY of [undefined, "", "tooshort", btoa("x".repeat(16))]) {
      const environment = makeEnv({ USER_CONFIG_KEY });
      const cookie = withSession(environment, andrew);
      expect((await call(environment, cookie, "/llm-config")).status).toBe(503);
      expect((await save(environment, cookie)).status).toBe(503);
    }
  });

  it("advertises ownKey in /me only to an allowlisted login on a configured deployment", async () => {
    const flag = async (environment, user) =>
      (await (await call(environment, withSession(environment, user), "/me")).json()).ownKey;
    expect(await flag(makeEnv(), andrew)).toBe(true);
    expect(await flag(makeEnv(), octocat)).toBe(false);
    expect(await flag(makeEnv({ USER_CONFIG_KEY: undefined }), andrew)).toBe(false);
  });
});

describe("CSRF", () => {
  it.each([
    ["an origin that is not allowed", { origin: "https://evil.example" }, "origin not allowed"],
    ["no origin at all", { origin: null }, "origin not allowed"],
    ["no csrf header", { csrf: false }, "missing csrf header"],
    ["a non-JSON content type", { type: "text/plain" }, "content-type must be application/json"],
  ])("rejects a PUT with %s and writes nothing", async (_name, options, error) => {
    const environment = makeEnv();
    const cookie = withSession(environment, andrew);
    const response = await call(environment, cookie, "/llm-config", {
      method: "PUT",
      body: { base_url: BASE, api_key: KEY, model: "gpt-x" },
      ...options,
    });
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe(error);
    expect(await (await call(environment, cookie, "/llm-config")).json()).toEqual({ configured: false });
  });

  it("rejects DELETE and model listing without the csrf header", async () => {
    const environment = makeEnv();
    const cookie = withSession(environment, andrew);
    await save(environment, cookie);
    expect((await call(environment, cookie, "/llm-config", { method: "DELETE", csrf: false })).status).toBe(403);
    expect(
      (await call(environment, cookie, "/llm-config/models", { method: "POST", body: {}, csrf: false })).status,
    ).toBe(403);
    expect((await (await call(environment, cookie, "/llm-config")).json()).configured).toBe(true);
  });

  it("allows the preflight for PUT and the csrf header", async () => {
    const response = await worker.fetch(
      new Request("https://bolster.help/llm-config", {
        method: "OPTIONS",
        headers: { origin: "https://bolster.help" },
      }),
      makeEnv(),
    );
    expect(response.headers.get("access-control-allow-methods")).toContain("PUT");
    expect(response.headers.get("access-control-allow-headers")).toContain("x-bolster-csrf");
  });
});

describe("saving and reading", () => {
  it("returns only a masked key, and stores only ciphertext", async () => {
    const environment = makeEnv();
    const cookie = withSession(environment, andrew);
    const saved = await save(environment, cookie);
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ configured: true, base_url: BASE, key_last4: "1234", model: "gpt-x" });
    expect(await (await call(environment, cookie, "/llm-config")).json()).toEqual({
      configured: true,
      base_url: BASE,
      key_last4: "1234",
      model: "gpt-x",
    });

    const row = await env.DB.prepare("SELECT * FROM user_llm_config WHERE user_id = 1").first();
    expect(JSON.stringify(row)).not.toContain(KEY);
    expect(JSON.stringify(row)).not.toContain("SECRETSECRET");
    expect(row.key_last4).toBe("1234");
  });

  it("normalises the base URL it stores", async () => {
    const environment = makeEnv();
    const cookie = withSession(environment, andrew);
    const saved = await (await save(environment, cookie, { base_url: "https://API.Example.com/v1/" })).json();
    expect(saved.base_url).toBe(BASE);
  });

  it.each([
    ["no model", { model: undefined }],
    ["a model with odd characters", { model: "bad model!" }],
    ["no api key on a first save", { api_key: undefined }],
    ["a short api key", { api_key: "short" }],
    ["an api key with whitespace", { api_key: "sk-has a space-1234" }],
    ["plain http", { base_url: "http://api.example.com/v1" }],
    ["a link-local address", { base_url: "https://169.254.169.254/v1" }],
    ["localhost", { base_url: "https://localhost/v1" }],
    ["credentials in the URL", { base_url: "https://u:p@api.example.com/v1" }],
  ])("rejects %s and stores nothing", async (_name, override) => {
    const environment = makeEnv();
    const cookie = withSession(environment, andrew);
    expect((await save(environment, cookie, override)).status).toBe(400);
    expect(await (await call(environment, cookie, "/llm-config")).json()).toEqual({ configured: false });
  });

  it("keeps the stored key when only the model changes", async () => {
    const environment = makeEnv();
    const cookie = withSession(environment, andrew);
    await save(environment, cookie);
    const updated = await call(environment, cookie, "/llm-config", {
      method: "PUT",
      body: { model: "gpt-y" },
    });
    expect(await updated.json()).toEqual({ configured: true, base_url: BASE, key_last4: "1234", model: "gpt-y" });
  });

  it("will not reuse the stored key for a different host", async () => {
    const environment = makeEnv();
    const cookie = withSession(environment, andrew);
    await save(environment, cookie);
    const calls = provider(() => modelsReply(["m"]));
    const moved = await call(environment, cookie, "/llm-config", {
      method: "PUT",
      body: { base_url: "https://other.example.com/v1", model: "gpt-x" },
    });
    expect(moved.status).toBe(400);
    expect((await moved.json()).error).toMatch(/api_key required/);
    const listed = await call(environment, cookie, "/llm-config/models", {
      method: "POST",
      body: { base_url: "https://other.example.com/v1" },
    });
    expect(listed.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("deletes the config", async () => {
    const environment = makeEnv();
    const cookie = withSession(environment, andrew);
    await save(environment, cookie);
    expect((await call(environment, cookie, "/llm-config", { method: "DELETE" })).status).toBe(204);
    expect(await (await call(environment, cookie, "/llm-config")).json()).toEqual({ configured: false });
  });

  it("keeps each user's config separate", async () => {
    const environment = makeEnv({ GITHUB_ALLOWED_LOGINS: "andrewbolster,octocat" });
    const mine = withSession(environment, andrew, "a");
    const theirs = withSession(environment, octocat, "b");
    await save(environment, mine);
    expect(await (await call(environment, theirs, "/llm-config")).json()).toEqual({ configured: false });
    await save(environment, theirs, { api_key: "sk-other-ABCDEFGH9999", model: "m2" });
    expect((await (await call(environment, mine, "/llm-config")).json()).key_last4).toBe("1234");
    expect((await (await call(environment, theirs, "/llm-config")).json()).key_last4).toBe("9999");
    await call(environment, theirs, "/llm-config", { method: "DELETE" });
    expect((await (await call(environment, mine, "/llm-config")).json()).configured).toBe(true);
  });

  it("refuses unsupported methods", async () => {
    const environment = makeEnv();
    const cookie = withSession(environment, andrew);
    expect((await call(environment, cookie, "/llm-config", { method: "POST", body: {} })).status).toBe(405);
    expect((await call(environment, cookie, "/llm-config/models")).status).toBe(405);
  });
});

describe("listing models", () => {
  it("calls the provider with the typed key and returns sorted, de-duplicated ids", async () => {
    const environment = makeEnv();
    const cookie = withSession(environment, andrew);
    const calls = provider(() => modelsReply(["b", "a", "a"]));
    const response = await call(environment, cookie, "/llm-config/models", {
      method: "POST",
      body: { base_url: BASE, api_key: KEY },
    });
    expect(await response.json()).toEqual({ models: ["a", "b"] });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${BASE}/models`);
    expect(calls[0].init.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(calls[0].init.redirect).toBe("manual");
  });

  it("uses the stored key when asked about the stored host", async () => {
    const environment = makeEnv();
    const cookie = withSession(environment, andrew);
    await save(environment, cookie);
    const calls = provider(() => modelsReply(["m"]));
    const response = await call(environment, cookie, "/llm-config/models", { method: "POST", body: {} });
    expect(await response.json()).toEqual({ models: ["m"] });
    expect(calls[0].init.headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it("accepts a bare array of ids and ignores entries that are not ids", async () => {
    const environment = makeEnv();
    const cookie = withSession(environment, andrew);
    provider(() => new Response(JSON.stringify(["x", { id: "y" }, { nope: 1 }, 5, null])));
    const response = await call(environment, cookie, "/llm-config/models", {
      method: "POST",
      body: { base_url: BASE, api_key: KEY },
    });
    expect((await response.json()).models).toEqual(["x", "y"]);
  });

  it("caps the list at 500", async () => {
    const environment = makeEnv();
    const cookie = withSession(environment, andrew);
    provider(() => modelsReply(Array.from({ length: 800 }, (_, i) => `m${String(i).padStart(4, "0")}`)));
    const response = await call(environment, cookie, "/llm-config/models", {
      method: "POST",
      body: { base_url: BASE, api_key: KEY },
    });
    expect((await response.json()).models).toHaveLength(500);
  });

  it("never calls out for a URL the validator rejects", async () => {
    const environment = makeEnv();
    const cookie = withSession(environment, andrew);
    const calls = provider(() => modelsReply(["m"]));
    for (const base_url of [
      "https://127.0.0.1/v1",
      "http://api.example.com/v1",
      "https://x.workers.dev/v1",
      "https://[::1]/v1",
    ]) {
      const response = await call(environment, cookie, "/llm-config/models", {
        method: "POST",
        body: { base_url, api_key: KEY },
      });
      expect(response.status).toBe(400);
    }
    expect(calls).toHaveLength(0);
  });

  it("reports the provider's status and nothing it said", async () => {
    const environment = makeEnv();
    const cookie = withSession(environment, andrew);
    provider(() => new Response(`bad key ${KEY}`, { status: 401 }));
    const response = await call(environment, cookie, "/llm-config/models", {
      method: "POST",
      body: { base_url: BASE, api_key: KEY },
    });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "provider HTTP 401" });
  });

  it("treats a redirect, an oversized reply, bad JSON and a network failure as a 502", async () => {
    const environment = makeEnv();
    const cookie = withSession(environment, andrew);
    const attempt = async (handler) => {
      provider(handler);
      return call(environment, cookie, "/llm-config/models", {
        method: "POST",
        body: { base_url: BASE, api_key: KEY },
      });
    };
    const redirected = await attempt(
      () => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } }),
    );
    expect(redirected.status).toBe(502);
    expect((await redirected.json()).error).toMatch(/redirect/);
    expect((await attempt(() => new Response("x".repeat(2 * 1024 * 1024)))).status).toBe(502);
    expect((await attempt(() => new Response("not json"))).status).toBe(502);
    expect(
      (
        await attempt(() => {
          throw new TypeError("network");
        })
      ).status,
    ).toBe(502);
  });
});

describe("the own-key tier", () => {
  const chat = (environment, user, body = chatBody()) => llm(post("/llm", body), environment, {}, user);

  async function saved(overrides) {
    const environment = makeEnv(overrides);
    const cookie = withSession(environment, andrew);
    await save(environment, cookie);
    return environment;
  }

  it("relays to the saved host with the saved key and the saved model, ignoring any model in the request", async () => {
    const environment = await saved();
    const reply = { choices: [{ message: { role: "assistant", content: "42" } }] };
    const calls = provider(() => new Response(JSON.stringify(reply)));
    const response = await chat(environment, andrew, chatBody({ model: "evil-expensive-model" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(reply);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${BASE}/chat/completions`);
    expect(calls[0].init.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(calls[0].init.redirect).toBe("manual");
    const sent = JSON.parse(calls[0].init.body);
    expect(sent.model).toBe("gpt-x");
    expect(sent.messages).toEqual(chatBody().messages);
  });

  it("passes tools through and does not touch the shared or free budget", async () => {
    const environment = await saved();
    const calls = provider(() => new Response(JSON.stringify({ choices: [] })));
    const tools = [{ type: "function", function: { name: "t", parameters: {} } }];
    const response = await chat(environment, andrew, chatBody({ tools, tool_choice: "auto" }));
    expect((await response.json()).usage_budget).toBeUndefined();
    const sent = JSON.parse(calls[0].init.body);
    expect(sent.tools).toEqual(tools);
    expect(sent.tool_choice).toBe("auto");
  });

  it("reports a provider failure as its status only", async () => {
    const environment = await saved();
    provider(() => new Response(`echoed ${KEY}`, { status: 500 }));
    const response = await chat(environment, andrew);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "provider HTTP 500" });
  });

  it("re-validates the stored URL on every relay", async () => {
    const environment = await saved();
    await env.DB.prepare("UPDATE user_llm_config SET base_url = 'https://127.0.0.1/v1' WHERE user_id = 1").run();
    const calls = provider(() => new Response("{}"));
    const response = await chat(environment, andrew);
    expect(response.status).toBe(502);
    expect(calls).toHaveLength(0);
  });

  it("says so when the stored key can no longer be decrypted", async () => {
    const environment = await saved();
    const calls = provider(() => new Response("{}"));
    const response = await chat(
      makeEnv({ USER_CONFIG_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))) }),
      andrew,
    );
    expect(response.status).toBe(500);
    expect((await response.json()).reason).toBe("config_unreadable");
    expect(calls).toHaveLength(0);
    expect(environment).toBeDefined();
  });

  it("is not used by a login that has since left the allowlist", async () => {
    await saved();
    const calls = provider(() => new Response("{}"));
    const response = await chat(makeEnv({ GITHUB_ALLOWED_LOGINS: "someone-else" }), andrew);
    expect(response.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it("is off when USER_CONFIG_KEY is not set", async () => {
    await saved();
    const calls = provider(() => new Response("{}"));
    const response = await chat(makeEnv({ USER_CONFIG_KEY: undefined }), andrew);
    expect(response.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it("is never used for an anonymous caller", async () => {
    const environment = await saved();
    provider(() => new Response("{}"));
    expect((await chat(environment, null)).status).toBe(403);
  });

  it("reports tier and model from /usage, with no budget bar", async () => {
    const environment = await saved();
    expect(await usage(environment, andrew)).toEqual({ tier: "own", enabled: false, model: "gpt-x" });
  });

  it("leaves /usage as it was for someone without a saved config", async () => {
    expect(await usage(makeEnv(), andrew)).toEqual({ enabled: false, model: null });
  });

  it("falls back rather than breaking chat when the config lookup fails", async () => {
    const broken = {
      prepare: () => ({
        run: async () => {
          throw new Error("d1 down");
        },
        bind: () => ({
          first: async () => {
            throw new Error("d1 down");
          },
        }),
      }),
    };
    expect(await usage(makeEnv({ DB: broken }), andrew)).toEqual({ enabled: false, model: null });
  });
});
