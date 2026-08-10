// MCP client. Always talks to the Worker proxy, never to mcp.bolster.online
// directly — the origin sends no CORS headers, so a direct call cannot work.

// Tool output is raw CLI text: tables of quarterly NISRA figures run to tens of
// kilobytes. Feeding that back unabridged would evict the conversation from a
// 7-8B context window, so results are clipped before they re-enter the loop.
const MAX_RESULT_CHARS = 2000;

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

    if (res.status === 429) throw new Error("Too many requests — give it a minute.");
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

    if (!text) return "(the tool returned nothing)";
    return text.length > MAX_RESULT_CHARS
      ? `${text.slice(0, MAX_RESULT_CHARS)}\n… truncated, ${text.length - MAX_RESULT_CHARS} more characters`
      : text;
  }
}
