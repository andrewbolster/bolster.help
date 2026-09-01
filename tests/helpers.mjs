// Shared fixtures and stand-ins.
//
// The line the suite draws is the first outbound `fetch`. Everything that
// resolves before one — CORS computation, routing, the allowlists, body caps,
// the tier gate — is a pure function of the request and the env. Everything
// past it needs credentials or a deployment, and is gated below rather than
// faked, so a green suite never implies a working integration.
//
// Bindings are real wherever workerd can provide them: the `worker` project
// runs against actual KV and a real Durable Object. Only Workers AI is stood
// in for, because inference has no local simulator — and what those tests
// check is our error handling, not Cloudflare's model.

import fixturesJson from "../web/src/fixtures.json";
import snapshotJson from "../web/src/tools.json";

export const snapshot = snapshotJson;
export const fixtures = fixturesJson;

// workerd has no `process`, and these gates are read from both projects.
const environment = globalThis.process?.env ?? {};

// The AI binding, pinned to one outcome. There is no local Workers AI
// simulator, so this is the one place a fake is unavoidable — and the tests
// using it assert our branching on the reply, not the reply itself.
export function fakeAI({ reply, throws, neurons = 1.2 } = {}) {
  const seen = [];
  return {
    seen,
    async run(model, inputs) {
      seen.push({ model, inputs });
      if (throws) throw throws;
      return (
        reply ?? {
          choices: [
            {
              message: {
                role: "assistant",
                content: "42 births.",
                tool_calls: [],
              },
            },
          ],
          usage: { prompt_tokens: 900, completion_tokens: 30, neurons },
        }
      );
    },
  };
}

export const aiError = (code) => Object.assign(new Error(`${code}: AiError: simulated`), { code });

// An in-memory stand-in for KV, used only by the `unit` project. The `worker`
// project gets the real binding from wrangler.toml.
export function memoryKV(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    get: async (key) => store.get(key) ?? null,
    put: async (key, value) => void store.set(key, value),
    delete: async (key) => void store.delete(key),
    store,
  };
}

export const fakeEnv = (overrides = {}) => ({
  ALLOWED_ORIGINS: "https://bolster.help,http://localhost:5173",
  SESSIONS: memoryKV(),
  ...overrides,
});

// Signs a session in so `/me` and `/llm` see a user without an OAuth round-trip.
export function withSession(env, user, token = "test-token") {
  env.SESSIONS.store.set(`session:${token}`, JSON.stringify(user));
  return `bolster_session=${token}`;
}

export function request(path, { method = "GET", body, origin = "https://bolster.help", headers = {} } = {}) {
  return new Request(`https://bolster.help${path}`, {
    method,
    headers: { ...(origin ? { origin } : {}), ...headers },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
}

export const post = (path, body, options = {}) => request(path, { ...options, method: "POST", body });

export const chatBody = (extra = {}) => ({
  messages: [
    { role: "system", content: "You answer questions about Northern Ireland." },
    { role: "user", content: "how many births were registered last year?" },
  ],
  ...extra,
});

// Skip gates. The reason is the point: it names the configuration the test
// needs, so a skipped run reads as a statement about the environment rather
// than an untested assertion. Vitest has no skip-with-reason, so the reason
// goes into the title, where every reporter prints it.
export const needsNetwork =
  environment.CHECK_NETWORK === "1" ? null : "CHECK_NETWORK=1 — reaches mcp.bolster.online over the network";

export const needsDeployment = environment.CHECK_DEPLOYED
  ? null
  : "CHECK_DEPLOYED=<worker-url> — Cloudflare bindings are inert under `wrangler dev --local`";

export const needsProvider =
  environment.LLM_BASE_URL && environment.LLM_API_KEY
    ? null
    : "LLM_BASE_URL and LLM_API_KEY — spends real credit on a real provider";

// Usage: const online = gate(it, needsNetwork); online("does X", async () => {})
export const gate = (it, reason) => (title, fn) => (reason ? it.skip(`${title} — needs ${reason}`, fn) : it(title, fn));

export const deployedOrigin = environment.CHECK_DEPLOYED?.replace(/\/+$/, "");
export const mcpOrigin = environment.MCP_ORIGIN ?? "https://mcp.bolster.online/mcp";
