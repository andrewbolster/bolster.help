// Assumptions that cannot be checked from the repo alone.
//
// Each of these is a real, runnable test — none is a placeholder — but each
// depends on something the repo does not carry: network access, Cloudflare
// bindings that only exist on a deployment, OAuth credentials, or a provider
// key with credit on it. They are skipped by default with the reason attached,
// so a green suite says "these were not checked" rather than implying they were.
//
//   CHECK_NETWORK=1                      reach mcp.bolster.online
//   CHECK_DEPLOYED=https://bolster.help  reach a deployed Worker
//   GITHUB_CLIENT_ID / _SECRET           OAuth round-trip
//   LLM_BASE_URL / LLM_API_KEY           inference on a real provider

import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { ALLOWED_TOOLS } from "../../worker/src/allowlist.js";
import { parseUpstream } from "../../worker/src/sse.js";
import {
  deployedOrigin,
  gate,
  mcpOrigin,
  needsDeployment,
  needsNetwork,
  needsProvider,
  snapshot,
} from "../helpers.mjs";

// FastMCP's streamable-HTTP transport is stateful: `initialize` issues an
// mcp-session-id and every later call must carry it, or the origin answers 400
// "Missing session ID". It also frames replies as SSE even for single-shot
// calls. Reuse the Worker's own frame picker rather than a second copy of it —
// a hand-duplicated version here previously grabbed the first `data:` line
// unconditionally, same bug as the Worker had, so this file exercising a tool
// that never emits a mid-call notification (bolster_ni_executive, below) never
// caught check_availability's ctx.info() notification frame shadowing its
// result in production.
const unwrap = (text) => parseUpstream(text);

async function connect(endpoint) {
  let session = null;
  let id = 1;

  const rpc = async (method, params, { notification = false } = {}) => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(session ? { "mcp-session-id": session } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        ...(notification ? {} : { id: id++ }),
        method,
        ...(params ? { params } : {}),
      }),
    });

    const issued = response.headers.get("mcp-session-id");
    if (issued) session = issued;
    if (notification) return null;

    assert.ok(response.ok, `${method} returned HTTP ${response.status}`);
    const payload = unwrap(await response.text());
    assert.equal(payload.error, undefined, `${method}: ${payload.error?.message}`);
    return payload.result;
  };

  await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "bolster.help tests", version: "0.1.0" },
  });
  await rpc("notifications/initialized", undefined, { notification: true });
  return rpc;
}

describe("the MCP origin", () => {
  // This flipped: the origin's Sept-1 auth refactor (adding /auth/mcp) added
  // CORSMiddleware(allow_origins=["*"]) to guard an unrelated unmatched-route
  // case, which as a side effect means a direct browser fetch to /mcp/ would
  // now work CORS-wise. That never showed up here because this test was
  // checking the pre-refactor bare "/mcp" URL, which 404s before reaching the
  // origin's own middleware at all — this file had the same trailing-slash
  // bug bolster.help's Worker did (see git history), just never noticed
  // because it makes the origin CORS-permissive by accident. The Worker
  // proxy is still not optional: it's the only place the tool allowlist,
  // MAX_BODY_BYTES cap, and the shared-key/budget accounting live — none of
  // that exists at the origin.
  gate(it, needsNetwork)(
    "sends permissive CORS headers on its own — the proxy adds guardrails, not access",
    async () => {
      const response = await fetch(mcpOrigin, {
        method: "OPTIONS",
        headers: {
          origin: "https://bolster.help",
          "access-control-request-method": "POST",
        },
      });
      assert.equal(
        response.headers.get("access-control-allow-origin"),
        "*",
        "origin stopped sending CORS headers — the Worker is back to being the only way in",
      );
    },
  );

  // tools.json is a manual snapshot with no trigger to refresh it. Stale
  // entries fail silently: the model is offered a tool that no longer exists,
  // or never hears about one that does.
  gate(it, needsNetwork)("still exposes exactly the tools in the snapshot", async () => {
    const rpc = await connect(mcpOrigin);
    const live = new Set((await rpc("tools/list")).tools.map((t) => t.name));
    const known = new Set(snapshot.tools.map((t) => t.name));

    assert.deepEqual(
      [...live].filter((n) => !known.has(n)).sort(),
      [],
      "new tools upstream — run `npm run refresh-tools`",
    );
    assert.deepEqual(
      [...known].filter((n) => !live.has(n)).sort(),
      [],
      "snapshot names tools that no longer exist — run `npm run refresh-tools`",
    );
  });

  gate(it, needsNetwork)("answers an allowlisted tool call", async () => {
    const name = "bolster_ni_executive";
    assert.ok(ALLOWED_TOOLS.has(name), "pick a tool the proxy would actually forward");

    const rpc = await connect(mcpOrigin);
    const result = await rpc("tools/call", { name, arguments: {} });
    const text = (result?.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");
    assert.ok(text.trim(), `${name} returned no text content`);
  });

  // The specific gap that let the notification-shadowing bug reach
  // production: every other tool here answers in a single SSE frame, so
  // grabbing the first `data:` line happened to be correct by coincidence.
  // check_availability calls ctx.info() before it returns, which puts a
  // notification frame (no "id") ahead of the result frame — the case
  // parseUpstream must skip past rather than stop on.
  gate(it, needsNetwork)(
    "answers check_availability, which logs via ctx.info() before returning",
    async () => {
      assert.ok(ALLOWED_TOOLS.has("check_availability"), "pick a tool the proxy would actually forward");

      const rpc = await connect(mcpOrigin);
      const result = await rpc("tools/call", { name: "check_availability", arguments: { days_ahead: 7 } });
      const text = (result?.content ?? [])
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("");
      assert.ok(text.trim(), "check_availability returned no text content");
      assert.doesNotMatch(text, /^\{"method":"notifications\/message"/, "got the notification frame, not the result");
    },
    // Fetches several live ICS calendars server-side; the 5s default is too
    // tight for that round trip on a slow one.
    15_000,
  );
});

describe("the deployed Worker", () => {
  gate(it, needsDeployment)("serves the proxy and the page from one origin", async () => {
    // SameSite=Lax means the session cookie only travels if the page and the
    // Worker share an origin. In development they do not, which is why auth is
    // untestable there; in production this is what makes it work.
    const response = await fetch(`${deployedOrigin}/me`);
    assert.equal(response.status, 401, "/me should refuse an unauthenticated caller");
    assert.equal(new URL(`${deployedOrigin}/me`).origin, new URL(deployedOrigin).origin);
  });

  // Marked todo rather than skipped: unlike the cases above, no environment
  // variable makes this run. Driving it needs a signed-in session cookie, and
  // minting one means a human at a browser. Writing it means either a stored
  // session fixture or a headless login against GitHub — a decision not yet
  // taken, so the gap is recorded rather than papered over.
  it.todo(
    "persists a conversation across a session — needs a signed-in session cookie, blocked on the OAuth round-trip below",
  );
});

describe("GitHub OAuth", () => {
  it.todo(
    "completes the round-trip and mints a session — needs GITHUB_CLIENT_ID/SECRET, and the authorize step needs a human at a browser",
  );
});

describe("the shared key", () => {
  gate(it, needsProvider)("relays a completion to the configured provider", async () => {
    const endpoint = `${process.env.LLM_BASE_URL.replace(/\/+$/, "")}/chat/completions`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${process.env.LLM_API_KEY}`,
      },
      body: JSON.stringify({
        model: process.env.LLM_MODEL ?? "gpt-4o-mini",
        messages: [{ role: "user", content: "Reply with the single word: ok" }],
      }),
    });
    assert.ok(response.ok, `provider returned HTTP ${response.status}`);
    assert.ok((await response.json()).choices?.[0]?.message);
  });
});
