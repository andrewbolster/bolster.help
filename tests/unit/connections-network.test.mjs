// The connections flow against the real mcp.bolster.online. Needs
// CHECK_NETWORK=1, like the other network checks, and skips with a reason when
// the server is not ready for browser clients yet.

import { describe, expect, it } from "vitest";

import { discover } from "../../web/src/oauth.js";
import { gate, needsNetwork } from "../helpers.mjs";

const online = gate(it, needsNetwork);

const AUTHENTICATED = "https://mcp.bolster.online/auth/mcp";
const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "check", version: "0" } },
};

async function exposedHeaders(url) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      origin: "https://bolster.help",
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(INITIALIZE),
  });
  return (response.headers.get("access-control-expose-headers") ?? "").toLowerCase();
}

describe("mcp.bolster.online as a connection", () => {
  online(
    "can be discovered by the real flow, with nothing hard-coded",
    async () => {
      const found = await discover(AUTHENTICATED);
      expect(found.origin).toBe("https://mcp.bolster.online");
      expect(found.resource).toBe(AUTHENTICATED);
      expect(found.meta.registration_endpoint).toMatch(/^https:/);
    },
    30_000,
  );

  online(
    "exposes WWW-Authenticate to a web page",
    async (ctx) => {
      if (!(await exposedHeaders(AUTHENTICATED)).includes("www-authenticate")) {
        ctx.skip("mcp.bolster.online does not expose WWW-Authenticate yet (mcp.bolster.online#49 is not deployed)");
      }
    },
    30_000,
  );

  online(
    "exposes mcp-session-id to a web page",
    async (ctx) => {
      if (!(await exposedHeaders("https://mcp.bolster.online/mcp/")).includes("mcp-session-id")) {
        ctx.skip("mcp.bolster.online does not expose mcp-session-id yet (mcp.bolster.online#49 is not deployed)");
      }
    },
    30_000,
  );
});
