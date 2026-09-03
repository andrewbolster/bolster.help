// Proxy between the browser and mcp.bolster.online.
//
// The origin sends no CORS headers at all (OPTIONS /mcp answers 405), so this
// hop is mandatory rather than a hardening nicety. It is also the only place
// guardrails exist — the origin stays open, and anything bypassing this proxy
// reaches it unfiltered. That is a known, accepted trade.

import { ALLOWED_METHODS, ALLOWED_TOOLS } from "./allowlist.js";
import { callback, login, logout, session } from "./auth.js";
import { chats } from "./chats.js";
import { canUseSharedKey, llm, usage } from "./llm.js";

export { NeuronBudget } from "./budget.js";

const DEFAULT_ORIGINS = "https://bolster.help,http://localhost:5173";
const MAX_BODY_BYTES = 16 * 1024;

function corsHeaders(request, env) {
  const allowed = (env.ALLOWED_ORIGINS ?? DEFAULT_ORIGINS).split(",").map((s) => s.trim());
  const origin = request.headers.get("origin");
  // Exact matches only. A wildcard for *.pages.dev was here while the site ran
  // on Cloudflare Pages previews; it is served from GitHub Pages now, so the
  // pattern admitted anyone's Pages deployment in exchange for nothing.
  const ok = origin !== null && allowed.includes(origin);
  return {
    "access-control-allow-origin": ok ? origin : allowed[0],
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
    "access-control-allow-headers": "content-type, mcp-session-id",
    "access-control-expose-headers": "mcp-session-id",
    "access-control-allow-credentials": "true",
    "access-control-max-age": "86400",
    vary: "origin",
  };
}

function json(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, "content-type": "application/json" },
  });
}

function rpcError(id, code, message, headers) {
  return json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }, 200, headers);
}

// FastMCP's streamable-HTTP transport frames replies as SSE even for
// single-shot calls, so unwrap the `data:` line before handing it back.
function parseUpstream(text) {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  for (const line of trimmed.split("\n")) {
    if (line.startsWith("data:")) return JSON.parse(line.slice(5).trim());
  }
  throw new Error("upstream returned neither JSON nor SSE");
}

function reject(rpc, reason, headers) {
  return rpcError(rpc.id, -32601, reason, headers);
}

async function proxy(request, env, headers) {
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) {
    return rpcError(null, -32600, "request too large", headers);
  }

  let rpc;
  try {
    rpc = JSON.parse(raw);
  } catch {
    return rpcError(null, -32700, "invalid JSON", headers);
  }

  if (!ALLOWED_METHODS.has(rpc.method)) {
    return reject(rpc, `method not permitted: ${rpc.method}`, headers);
  }
  if (rpc.method === "tools/call" && !ALLOWED_TOOLS.has(rpc.params?.name)) {
    return reject(rpc, `tool not permitted: ${rpc.params?.name}`, headers);
  }

  const isToolCall = rpc.method === "tools/call";
  const started = Date.now();

  const session = request.headers.get("mcp-session-id");
  const upstream = await fetch(env.MCP_ORIGIN ?? "https://mcp.bolster.online/mcp/", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(session ? { "mcp-session-id": session } : {}),
    },
    body: raw,
  });

  const out = { ...headers };
  const issued = upstream.headers.get("mcp-session-id");
  if (issued) out["mcp-session-id"] = issued;

  if (!upstream.ok) {
    if (isToolCall) {
      console.error("tool call failed:", rpc.params?.name, `upstream HTTP ${upstream.status}`);
    }
    return rpcError(rpc.id, -32603, `upstream HTTP ${upstream.status}`, out);
  }

  const upstreamText = await upstream.text();

  let body;
  try {
    body = parseUpstream(upstreamText);
  } catch (err) {
    if (isToolCall) console.error("tool call failed:", rpc.params?.name, err.message);
    return rpcError(rpc.id, -32603, err.message, out);
  }

  if (isToolCall) {
    console.log("tool call:", {
      name: rpc.params?.name,
      arguments: rpc.params?.arguments,
      ok: !body?.error,
      resultChars: upstreamText.length,
      ms: Date.now() - started,
    });
  }

  // Notifications carry no id and get an empty 202 upstream.
  return body === null ? new Response(null, { status: 204, headers: out }) : json(body, 200, out);
}

export default {
  async fetch(request, env) {
    const headers = corsHeaders(request, env);
    const { pathname } = new URL(request.url);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });

    if (pathname === "/auth/github/login") return login(request, env);
    if (pathname === "/auth/github/callback") return callback(request, env);
    if (pathname === "/auth/logout") return logout(request, env, headers);

    if (pathname === "/me") {
      const user = await session(request, env);
      return user
        ? json({ login: user.login, sharedKey: canUseSharedKey(env, user) }, 200, headers)
        : json({ error: "not signed in" }, 401, headers);
    }

    // Public: it reports the deployment's own allowance, not anything about
    // the caller, and the page needs it before anyone has signed in.
    if (pathname === "/usage") return json(await usage(env), 200, headers);

    if (pathname === "/llm") {
      const user = await session(request, env);
      return llm(request, env, headers, user);
    }

    if (pathname === "/chats" || pathname.startsWith("/chats/")) {
      const user = await session(request, env);
      if (!user) return json({ error: "not signed in" }, 401, headers);
      const id = pathname.slice("/chats/".length) || null;
      return chats(request, env, headers, user, id);
    }

    // The Worker is an API, not the site — in production it answers on the same
    // origin as the page, but reached directly its root is bare. Say where the
    // site is rather than leaving a bare 404 to look like a broken deployment.
    if (pathname === "/") {
      return json(
        {
          service: "bolster.help",
          site: env.SITE_URL ?? "https://bolster.help",
        },
        200,
        headers,
      );
    }

    if (pathname !== "/mcp-proxy") return new Response("not found", { status: 404, headers });
    if (request.method !== "POST") return new Response("method not allowed", { status: 405, headers });

    return proxy(request, env, headers);
  },
};
