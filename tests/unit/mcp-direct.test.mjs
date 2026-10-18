// The client for a server reached straight from the page.

import { describe, expect, it } from "vitest";

import { DirectMcpClient, McpWebError, readReply } from "../../web/src/mcp.js";

const URL_ = "https://mcp.example.com/mcp";

const sse = (...messages) =>
  new Response(messages.map((m) => `event: message\ndata: ${JSON.stringify(m)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
const reply = (id, result) => ({ jsonrpc: "2.0", id, result });

// A server that answers by method, remembering what it was sent.
function server(handlers) {
  const seen = [];
  const request = async (_url, init) => {
    const body = JSON.parse(init.body);
    seen.push({ body, headers: init.headers });
    return handlers[body.method](body, init);
  };
  request.seen = seen;
  return request;
}

describe("replies", () => {
  it("reads a JSON reply", async () => {
    const response = new Response(JSON.stringify(reply(1, { ok: true })), {
      headers: { "content-type": "application/json" },
    });
    expect((await readReply(response, 1)).result).toEqual({ ok: true });
  });

  it("reads the answer from an event stream, past other messages", async () => {
    const response = sse({ jsonrpc: "2.0", method: "notifications/message", params: {} }, reply(7, { text: "hi" }));
    expect((await readReply(response, 7)).result).toEqual({ text: "hi" });
  });

  it("says so when the stream holds no answer", async () => {
    await expect(readReply(sse({ jsonrpc: "2.0", method: "ping" }), 1)).rejects.toBeInstanceOf(McpWebError);
  });
});

describe("a session", () => {
  const handlers = {
    initialize: (body) =>
      new Response(JSON.stringify(reply(body.id, { protocolVersion: "2025-06-18" })), {
        headers: { "content-type": "application/json", "mcp-session-id": "sess-1" },
      }),
    "notifications/initialized": () => new Response(null, { status: 202 }),
    "tools/list": (body) => sse(reply(body.id, { tools: [{ name: "a" }] })),
    "tools/call": (body) => sse(reply(body.id, { content: [{ type: "text", text: "result text" }] })),
  };

  it("initializes, announces it, and keeps the session id and protocol version", async () => {
    const request = server(handlers);
    const client = new DirectMcpClient(URL_, request);
    await client.connect();
    expect(request.seen.map((s) => s.body.method)).toEqual(["initialize", "notifications/initialized"]);
    expect(request.seen[1].headers["mcp-session-id"]).toBe("sess-1");
    expect(request.seen[1].headers["mcp-protocol-version"]).toBe("2025-06-18");
  });

  it("calls a tool and returns its text", async () => {
    const client = new DirectMcpClient(URL_, server(handlers));
    await client.connect();
    expect(await client.callTool("a", { x: 1 })).toBe("result text");
  });

  it("lists every page of tools", async () => {
    const pages = {
      "tools/list": (body) =>
        sse(
          reply(
            body.id,
            body.params.cursor ? { tools: [{ name: "b" }] } : { tools: [{ name: "a" }], nextCursor: "next" },
          ),
        ),
    };
    const client = new DirectMcpClient(URL_, server({ ...handlers, ...pages }));
    await client.connect();
    expect((await client.listTools()).map((t) => t.name)).toEqual(["a", "b"]);
  });

  it("reports a JSON-RPC error as its message", async () => {
    const failing = {
      "tools/call": (body) => sse({ jsonrpc: "2.0", id: body.id, error: { message: "no such tool" } }),
    };
    const client = new DirectMcpClient(URL_, server({ ...handlers, ...failing }));
    await client.connect();
    await expect(client.callTool("zzz", {})).rejects.toThrow("no such tool");
  });
});

describe("a server that does not allow a web page", () => {
  it("explains a blocked or unreachable request", async () => {
    const client = new DirectMcpClient(URL_, async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(client.connect()).rejects.toThrow(/CORS/);
  });

  it("explains a session id the page cannot read", async () => {
    // The server issued a session, but did not expose the header: the page
    // never sees it, so the next call is answered 400.
    const hidden = server({
      initialize: (body) =>
        new Response(JSON.stringify(reply(body.id, {})), { headers: { "content-type": "application/json" } }),
      "notifications/initialized": () => new Response("Missing session ID", { status: 400 }),
    });
    await expect(new DirectMcpClient(URL_, hidden).connect()).rejects.toThrow(/session id can't be read/);
  });
});
