// MCP clients. `McpClient` talks to the Worker proxy: the public tools, for
// everyone, with no login. `DirectMcpClient` (below) talks to a server the
// person has signed in to, straight from the page.

// Tool output is raw CLI text: tables of quarterly NISRA figures run to tens of
// kilobytes, which would evict the conversation from a small context window.
// What to do about that is the store's decision, not this client's — see
// store.js. The client returns the whole thing and lets the caller choose.

export class McpClient {
  constructor(endpoint) {
    this.endpoint = endpoint;
    this.session = null;
    this.nextId = 1;
  }

  async #rpc(method, params, { notification = false, signal } = {}) {
    const body = notification
      ? { jsonrpc: "2.0", method, params }
      : { jsonrpc: "2.0", id: this.nextId++, method, params };

    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.session ? { "mcp-session-id": this.session } : {}),
      },
      body: JSON.stringify(body),
      signal,
    });

    const issued = res.headers.get("mcp-session-id");
    if (issued) this.session = issued;

    if (res.status === 204) return null;
    if (!res.ok) throw new Error(`proxy returned HTTP ${res.status}`);

    const payload = await res.json();
    if (payload.error) throw new Error(payload.error.message);
    return payload.result;
  }

  async connect() {
    const result = await this.#rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "bolster.help", version: "0.1.0" },
    });
    await this.#rpc("notifications/initialized", undefined, {
      notification: true,
    });
    return result;
  }

  async callTool(name, args, { signal } = {}) {
    const result = await this.#rpc("tools/call", { name, arguments: args ?? {} }, { signal });
    return toText(result);
  }
}

function toText(result) {
  const text = (result?.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n")
    .trim();

  return text || "(the tool returned nothing)";
}

// A server reached straight from the page, not through the Worker. The
// difference that matters is CORS: a page can only read the response headers a
// server exposes, so a server that hides `mcp-session-id` cannot be used.
export class McpWebError extends Error {}

const CORS_HINT = "this server doesn't allow connections from a web page (CORS), or could not be reached";

// A reply is either JSON or a stream of events; take the message answering `id`.
export async function readReply(response, id) {
  if (!(response.headers.get("content-type") ?? "").includes("text/event-stream")) return response.json();

  const frames = (await response.text()).split(/\r?\n\r?\n/);
  for (const frame of frames) {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) continue;
    try {
      const message = JSON.parse(data);
      if (message.id === id && (message.result !== undefined || message.error)) return message;
    } catch {
      // A frame that is not JSON is not the answer.
    }
  }
  throw new McpWebError("the server's reply held no answer");
}

export class DirectMcpClient {
  // `request` is a fetch that already knows how to authorise this server.
  constructor(url, request) {
    this.url = url;
    this.request = request;
    this.session = null;
    this.protocol = null;
    this.nextId = 1;
  }

  async #rpc(method, params, { notification = false, signal } = {}) {
    const id = notification ? undefined : this.nextId++;
    const body = notification ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id, method, params };

    let res;
    try {
      res = await this.request(this.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(this.session ? { "mcp-session-id": this.session } : {}),
          ...(this.protocol ? { "mcp-protocol-version": this.protocol } : {}),
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (err instanceof TypeError) throw new McpWebError(CORS_HINT);
      throw err;
    }

    const issued = res.headers.get("mcp-session-id");
    if (issued) this.session = issued;

    if (res.status === 202 || res.status === 204) return null;
    if (!res.ok) {
      // The usual sign of a hidden session header: the server wanted one back.
      if (method !== "initialize" && !this.session && (res.status === 400 || res.status === 404)) {
        throw new McpWebError("this server's session id can't be read from a web page (CORS)");
      }
      throw new McpWebError(`the server answered HTTP ${res.status}`);
    }
    if (notification) return null;

    const payload = await readReply(res, id);
    if (payload.error) throw new McpWebError(payload.error.message);
    return payload.result;
  }

  async connect() {
    const result = await this.#rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "bolster.help", version: "0.1.0" },
    });
    this.protocol = result?.protocolVersion ?? null;
    await this.#rpc("notifications/initialized", undefined, { notification: true });
    return result;
  }

  async listTools() {
    const tools = [];
    let cursor;
    for (let page = 0; page < 20; page += 1) {
      const result = await this.#rpc("tools/list", cursor ? { cursor } : {});
      tools.push(...(result?.tools ?? []));
      cursor = result?.nextCursor;
      if (!cursor) break;
    }
    return tools;
  }

  async callTool(name, args, { signal } = {}) {
    return toText(await this.#rpc("tools/call", { name, arguments: args ?? {} }, { signal }));
  }
}
