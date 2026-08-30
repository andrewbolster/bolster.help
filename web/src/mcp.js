// MCP client. Always talks to the Worker proxy, never to mcp.bolster.online
// directly — the origin sends no CORS headers, so a direct call cannot work.

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

  async #rpc(method, params, { notification = false } = {}) {
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
    await this.#rpc("notifications/initialized", undefined, { notification: true });
    return result;
  }

  async callTool(name, args) {
    const result = await this.#rpc("tools/call", { name, arguments: args ?? {} });
    const text = (result?.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n")
      .trim();

    return text || "(the tool returned nothing)";
  }
}
