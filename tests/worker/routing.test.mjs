// Worker routing and guardrails.
//
// Every case here resolves before the Worker makes any outbound request, so it
// runs with no network and no wrangler. Cases that would reach `fetch` live in
// integration.test.mjs, skip-gated, so nothing green here implies a working hop
// to mcp.bolster.online.

import assert from "node:assert/strict";
import { describe, it } from "vitest";

import worker from "../../worker/src/index.js";
import { parseUpstream } from "../../worker/src/sse.js";
import { fakeEnv, post, request, withSession } from "../helpers.mjs";

const rpc = (method, params) => ({
  jsonrpc: "2.0",
  id: 1,
  method,
  ...(params ? { params } : {}),
});
const callTool = (name) => rpc("tools/call", { name, arguments: {} });

const proxy = (body, options) => worker.fetch(post("/mcp-proxy", body, options), fakeEnv());

describe("CORS", () => {
  it("answers preflight without touching the router", async () => {
    const response = await worker.fetch(request("/mcp-proxy", { method: "OPTIONS" }), fakeEnv());
    assert.equal(response.status, 204);
    assert.equal(response.headers.get("access-control-allow-origin"), "https://bolster.help");
    assert.equal(response.headers.get("access-control-allow-credentials"), "true");
  });

  it("echoes an allowlisted origin", async () => {
    const response = await worker.fetch(request("/nope", { origin: "http://localhost:5173" }), fakeEnv());
    assert.equal(response.headers.get("access-control-allow-origin"), "http://localhost:5173");
  });

  // The allowlist is exact. A *.pages.dev wildcard was here for Cloudflare
  // preview deployments and admitted anyone's Pages site once we stopped using
  // them.
  it("does not admit a pages.dev origin", async () => {
    const response = await worker.fetch(request("/nope", { origin: "https://abc-123.pages.dev" }), fakeEnv());
    assert.equal(response.headers.get("access-control-allow-origin"), "https://bolster.help");
  });

  it("falls back to the canonical origin for anything else", async () => {
    for (const origin of ["https://evil.example", "https://bolster.help.evil.example"]) {
      const response = await worker.fetch(request("/nope", { origin }), fakeEnv());
      assert.equal(
        response.headers.get("access-control-allow-origin"),
        "https://bolster.help",
        `${origin} must not be echoed back`,
      );
    }
  });

  it("varies on origin so a cached response is not served cross-origin", async () => {
    const response = await worker.fetch(request("/nope"), fakeEnv());
    assert.equal(response.headers.get("vary"), "origin");
  });
});

describe("routing", () => {
  it("404s an unknown path", async () => {
    const response = await worker.fetch(request("/whatever"), fakeEnv());
    assert.equal(response.status, 404);
  });

  it("405s a non-POST to the proxy", async () => {
    for (const method of ["GET", "DELETE"]) {
      const response = await worker.fetch(request("/mcp-proxy", { method }), fakeEnv());
      assert.equal(response.status, 405, `${method} should not be accepted`);
    }
  });

  it("401s /me and /chats without a session cookie", async () => {
    for (const path of ["/me", "/chats", "/chats/abc"]) {
      const response = await worker.fetch(request(path), fakeEnv());
      assert.equal(response.status, 401, `${path} must require a session`);
    }
  });
});

describe("proxy guardrails", () => {
  // JSON-RPC keeps a 200 with an error member; the transport succeeded even
  // though the call was refused.
  const errorOf = async (response) => {
    assert.equal(response.status, 200);
    return (await response.json()).error;
  };

  it("refuses a body over the 16KB cap before parsing it", async () => {
    const response = await proxy("x".repeat(17 * 1024));
    assert.equal((await errorOf(response)).code, -32600);
  });

  it("refuses a body that is not JSON", async () => {
    const response = await proxy("{not json");
    assert.equal((await errorOf(response)).code, -32700);
  });

  it("refuses a method outside the allowlist", async () => {
    const response = await proxy(rpc("resources/list"));
    const error = await errorOf(response);
    assert.equal(error.code, -32601);
    assert.match(error.message, /method not permitted/);
  });

  it("refuses a tool outside the allowlist", async () => {
    const error = await errorOf(await proxy(callTool("rm_minus_rf")));
    assert.equal(error.code, -32601);
    assert.match(error.message, /tool not permitted/);
  });

  // The two deliberate exclusions, named individually: one spends a metered
  // third-party key on every call, the other delivers mail to a real inbox.
  it("refuses bolster_get_precipitation and send_contact_message by name", async () => {
    for (const name of ["bolster_get_precipitation", "send_contact_message"]) {
      const error = await errorOf(await proxy(callTool(name)));
      assert.equal(error.code, -32601, `${name} must stay unreachable`);
      assert.match(error.message, new RegExp(name));
    }
  });
});

describe("/me", () => {
  it("reports the login and withholds the shared key by default", async () => {
    const env = fakeEnv();
    const cookie = withSession(env, { github_id: 1, login: "octocat" });
    const response = await worker.fetch(request("/me", { headers: { cookie } }), env);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      login: "octocat",
      sharedKey: false,
    });
  });

  it("advertises the shared key only to an allowlisted login", async () => {
    const env = fakeEnv({
      LLM_API_KEY: "sk-test",
      LLM_BASE_URL: "https://provider.example/v1",
      GITHUB_ALLOWED_LOGINS: "andrewbolster",
    });
    const cookie = withSession(env, { github_id: 1, login: "andrewbolster" });
    const response = await worker.fetch(request("/me", { headers: { cookie } }), env);

    assert.equal((await response.json()).sharedKey, true);
  });
});

describe("parseUpstream", () => {
  // FastMCP streams one SSE frame per ctx.info()/ctx.warning() call made
  // during a tool's execution, then a final frame carrying the actual
  // JSON-RPC response. Notification frames have no "id"; the response frame
  // does. Grabbing the first `data:` line unconditionally — the bug this
  // guards against — returned check_availability's "Checking availability
  // from..." log line to users instead of their answer, because it calls
  // ctx.info() before it returns.
  it("skips a notification frame and returns the frame with an id", () => {
    const text = [
      'event: message\ndata: {"method":"notifications/message","params":{},"jsonrpc":"2.0"}\n',
      'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"answer"}]}}\n',
    ].join("\n");
    assert.deepEqual(parseUpstream(text), {
      jsonrpc: "2.0",
      id: 2,
      result: { content: [{ type: "text", text: "answer" }] },
    });
  });

  it("skips multiple notification frames ahead of the result", () => {
    const notify = 'event: message\ndata: {"method":"notifications/message","params":{},"jsonrpc":"2.0"}\n';
    const text = [notify, notify, notify, 'event: message\ndata: {"jsonrpc":"2.0","id":5,"result":{}}\n'].join("\n");
    assert.equal(parseUpstream(text).id, 5);
  });

  it("handles a single-frame SSE response (the common case)", () => {
    const text = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n';
    assert.deepEqual(parseUpstream(text), { jsonrpc: "2.0", id: 1, result: {} });
  });

  it("handles a plain JSON body with no SSE framing", () => {
    assert.deepEqual(parseUpstream('{"jsonrpc":"2.0","id":1,"result":{}}'), {
      jsonrpc: "2.0",
      id: 1,
      result: {},
    });
  });

  it("returns null for an empty body (a client-sent notification's 202)", () => {
    assert.equal(parseUpstream(""), null);
    assert.equal(parseUpstream("   "), null);
  });

  it("falls back to the last frame if somehow nothing carries an id", () => {
    // Shouldn't happen for a request we sent — every request we make has an
    // id, so FastMCP owes it a matching response frame — but this is the
    // fallback for that gap: return the last frame seen rather than throwing,
    // since a stale notification is still more useful to the caller than a
    // hard failure for a case that should be unreachable.
    const text = 'event: message\ndata: {"method":"notifications/message","params":{},"jsonrpc":"2.0"}\n';
    assert.deepEqual(parseUpstream(text), { method: "notifications/message", params: {}, jsonrpc: "2.0" });
  });

  it("throws when the body is neither JSON nor SSE", () => {
    assert.throws(() => parseUpstream("not json, not sse"), /neither JSON nor SSE/);
  });
});
