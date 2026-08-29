// Shared fixtures and fake bindings.
//
// The line these tests draw is the first outbound `fetch`. Everything that
// resolves before one — CORS computation, routing, the allowlists, body caps,
// the session and allowlist gates — is a pure function of the request and the
// env, and runs here with no network and no wrangler. Everything past it needs
// credentials or a deployment, and is skip-gated below rather than faked, so a
// green suite never implies a working integration.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export const readJson = (...parts) => readFile(join(root, ...parts), "utf8").then(JSON.parse);

export const [snapshot, fixtures] = await Promise.all([
  readJson("web", "src", "tools.json"),
  readJson("web", "src", "fixtures.json"),
]);

// A stand-in for the KV binding, not for any logic under test: `get`/`put`/
// `delete` is the whole contract the Worker uses.
export function memoryKV(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    get: async (key) => store.get(key) ?? null,
    put: async (key, value) => void store.set(key, value),
    delete: async (key) => void store.delete(key),
    store,
  };
}

// Cloudflare's rate-limit binding, pinned to one answer. That we handle
// `{ success: false }` is testable; that the real binding counts to 30 in 60s
// is not — see the deployed gate.
export const rateLimit = (success) => ({ limit: async () => ({ success }) });

export const fakeEnv = (overrides = {}) => ({
  ALLOWED_ORIGINS: "https://bolster.help,http://localhost:5173",
  SESSIONS: memoryKV(),
  ...overrides,
});

// Signs `env` in so `/me` and `/llm` see a user without an OAuth round-trip.
export function withSession(env, user, token = "test-token") {
  env.SESSIONS.store.set(`session:${token}`, JSON.stringify(user));
  return `bolster_session=${token}`;
}

export function request(path, { method = "GET", body, origin = "https://bolster.help", headers = {} } = {}) {
  return new Request(`https://bolster.help${path}`, {
    method,
    headers: { ...(origin ? { origin } : {}), ...headers },
    ...(body === undefined
      ? {}
      : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
}

export const post = (path, body, options = {}) => request(path, { ...options, method: "POST", body });

// Skip gates. The reason string is the point: it names the configuration the
// test needs, so a skipped run reads as a statement about the environment
// rather than an untested assertion.
export const needsNetwork =
  process.env.CHECK_NETWORK === "1"
    ? false
    : "set CHECK_NETWORK=1 — reaches mcp.bolster.online over the network";

export const needsDeployment = process.env.CHECK_DEPLOYED
  ? false
  : "set CHECK_DEPLOYED=<worker-url> — Cloudflare bindings are inert under `wrangler dev --local`";

export const needsProvider =
  process.env.LLM_BASE_URL && process.env.LLM_API_KEY
    ? false
    : "needs LLM_BASE_URL and LLM_API_KEY — spends real credit on a real provider";

export const deployedOrigin = process.env.CHECK_DEPLOYED?.replace(/\/+$/, "");
export const mcpOrigin = process.env.MCP_ORIGIN ?? "https://mcp.bolster.online/mcp";
