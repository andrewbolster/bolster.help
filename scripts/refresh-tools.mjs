#!/usr/bin/env node
// Re-snapshot the MCP server's tool list into web/src/tools.json.
// Run manually when mcp.bolster.online gains or changes tools.

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ORIGIN = process.env.MCP_ORIGIN ?? "https://mcp.bolster.online";
const ENDPOINT = `${ORIGIN}/mcp`;
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "web", "src", "tools.json");

const HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};

// FastMCP's streamable-HTTP transport answers with SSE framing even for
// single-shot JSON-RPC calls, so unwrap the `data:` line when present.
function parseBody(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  for (const line of trimmed.split("\n")) {
    if (line.startsWith("data:")) return JSON.parse(line.slice(5).trim());
  }
  throw new Error(`unparseable response: ${trimmed.slice(0, 200)}`);
}

async function rpc(method, params, sessionId) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: sessionId ? { ...HEADERS, "mcp-session-id": sessionId } : HEADERS,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`${method} -> HTTP ${res.status}`);
  return { body: parseBody(await res.text()), sessionId: res.headers.get("mcp-session-id") };
}

const init = await rpc("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "bolster.help-refresh", version: "0.1.0" },
});

const session = init.sessionId;
if (session) {
  await fetch(ENDPOINT, {
    method: "POST",
    headers: { ...HEADERS, "mcp-session-id": session },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
}

const listed = await rpc("tools/list", {}, session);
const tools = listed.body.result?.tools;
if (!Array.isArray(tools) || tools.length === 0) {
  throw new Error(`tools/list returned nothing: ${JSON.stringify(listed.body).slice(0, 300)}`);
}

const snapshot = {
  source: ENDPOINT,
  fetchedAt: new Date().toISOString().slice(0, 10),
  serverInfo: init.body.result?.serverInfo ?? null,
  tools: tools
    .map((t) => ({
      name: t.name,
      description: (t.description ?? "").trim(),
      inputSchema: t.inputSchema,
    }))
    .sort((a, b) => a.name.localeCompare(b.name)),
};

await writeFile(OUT, JSON.stringify(snapshot, null, 2) + "\n");
console.log(`wrote ${snapshot.tools.length} tools to ${OUT}`);
