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

import { describe, it } from "vitest";
import assert from "node:assert/strict";

import { ALLOWED_TOOLS } from "../../worker/src/allowlist.js";
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
// calls. This mirrors web/src/mcp.js — the Worker relays both, it does not
// originate either.
function unwrap(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  const line = trimmed.split("\n").find((l) => l.startsWith("data:"));
  if (!line) throw new Error("upstream returned neither JSON nor SSE");
  return JSON.parse(line.slice(5).trim());
}

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
  // The single assumption the Worker exists to work around. If this ever starts
  // sending CORS headers, the proxy stops being mandatory — though it would
  // still be the only place the allowlist and rate limit live.
  gate(it, needsNetwork)("sends no CORS headers, which is why the proxy is mandatory", async () => {
    const response = await fetch(mcpOrigin, {
      method: "OPTIONS",
      headers: { origin: "https://bolster.help", "access-control-request-method": "POST" },
    });
    assert.equal(
      response.headers.get("access-control-allow-origin"),
      null,
      "origin now sends CORS headers — revisit whether the proxy is still mandatory",
    );
  });

  // tools.json is a manual snapshot with no trigger to refresh it. Stale
  // entries fail silently: retrieval offers the model a tool that no longer
  // exists, or never offers one that does.
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
});

describe("the deployed Worker", () => {
  // Inert under `wrangler dev --local`: the binding exists but never refuses,
  // so only a deployment can show the limit actually enforcing.
  gate(it, needsDeployment)("rate limits a burst to 429", async () => {
    // `ping` rather than tools/list: it is on the method allowlist but the
    // Worker still forwards it, so this measures the limiter without leaning on
    // a session the burst does not establish.
    const send = () =>
      fetch(`${deployedOrigin}/mcp-proxy`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      }).then((r) => r.status);

    const burst = await Promise.all(Array.from({ length: 45 }, send));
    assert.ok(burst.includes(429), `no request was limited; saw ${[...new Set(burst)].join(", ")}`);
  });

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
