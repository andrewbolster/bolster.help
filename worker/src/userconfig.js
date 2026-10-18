// Per-user LLM settings: a base URL, an API key and a model.
//
// The key is encrypted with AES-GCM under USER_CONFIG_KEY, bound to its owner
// by using the user id as additional data, and is never returned to the page or
// logged: the page only ever sees the last four characters. Callers decide who
// may use this (see canUseOwnKey in llm.js); everything here assumes they did.

import { csrfProblem } from "./origins.js";
import { parseBaseUrl, readCapped, safeFetch, UrlError } from "./ssrf.js";

const MAX_BODY_BYTES = 8 * 1024;
const MAX_MODELS = 500;
const MAX_MODELS_BYTES = 1024 * 1024;

const json = (body, status, headers) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, "content-type": "application/json" },
  });

const b64 = (bytes) => btoa(String.fromCharCode(...bytes));
const unb64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
const aad = (userId) => new TextEncoder().encode(String(userId));

// Null when the secret is missing or is not 32 base64-encoded bytes, which is
// how the feature fails closed.
export async function configKey(env) {
  try {
    const raw = unb64(env.USER_CONFIG_KEY ?? "");
    if (raw.length !== 32) return null;
    return await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
  } catch {
    return null;
  }
}

export async function encryptKey(key, userId, plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aad(userId) },
    key,
    new TextEncoder().encode(plaintext),
  );
  return { ciphertext: b64(new Uint8Array(data)), iv: b64(iv) };
}

export async function decryptKey(key, userId, { ciphertext, iv }) {
  const data = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: unb64(iv), additionalData: aad(userId) },
    key,
    unb64(ciphertext),
  );
  return new TextDecoder().decode(data);
}

// The table is also in schema.sql; creating it here too means a deploy does not
// depend on someone remembering to run a migration.
const TABLE = `CREATE TABLE IF NOT EXISTS user_llm_config (
  user_id        INTEGER PRIMARY KEY REFERENCES users(github_id),
  base_url       TEXT NOT NULL,
  key_ciphertext TEXT NOT NULL,
  key_iv         TEXT NOT NULL,
  key_last4      TEXT NOT NULL,
  model          TEXT,
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
)`;
const ready = new WeakSet();

async function db(env) {
  if (!ready.has(env.DB)) {
    await env.DB.prepare(TABLE).run();
    ready.add(env.DB);
  }
  return env.DB;
}

const loadRow = async (env, userId) =>
  (await db(env))
    .prepare("SELECT base_url, key_ciphertext, key_iv, key_last4, model FROM user_llm_config WHERE user_id = ?")
    .bind(userId)
    .first();

// What the tier gate needs, or null. A storage failure must not take chat down
// for everyone, so it reads as "no config" and is logged without detail.
export async function loadOwnConfig(env, user) {
  try {
    if (!(await configKey(env))) return null;
    const row = await loadRow(env, user.github_id);
    return row?.model ? { base_url: row.base_url, model: row.model } : null;
  } catch (err) {
    console.error("own config lookup failed:", err.name);
    return null;
  }
}

// Decrypted settings for one relay. Throws if anything is missing or unreadable.
export async function readOwnKey(env, user) {
  const key = await configKey(env);
  const row = await loadRow(env, user.github_id);
  if (!key || !row) throw new Error("no readable config");
  return {
    baseUrl: row.base_url,
    model: row.model,
    apiKey: await decryptKey(key, user.github_id, { ciphertext: row.key_ciphertext, iv: row.key_iv }),
  };
}

async function readBody(request) {
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) throw new UrlError("request too large");
  try {
    const body = JSON.parse(raw);
    if (body && typeof body === "object" && !Array.isArray(body)) return body;
  } catch {
    // falls through
  }
  throw new UrlError("body must be a JSON object");
}

function textField(value, name, pattern, min = 1) {
  if (typeof value !== "string" || value.length < min || !pattern.test(value)) {
    throw new UrlError(`${name} looks invalid`);
  }
  return value;
}

const keyField = (value) => textField(value, "api_key", /^[\x21-\x7e]{8,512}$/);
const modelField = (value) => textField(value, "model", /^[\w.:/@+-]{1,200}$/);

function view(row) {
  return { configured: true, base_url: row.base_url, key_last4: row.key_last4, model: row.model };
}

// The key to use for a request: the one in the body, or the stored one. A
// stored key is never sent to a different host than the one it was saved for.
async function effective(user, key, body, row) {
  const baseUrl = body.base_url === undefined ? row?.base_url : parseBaseUrl(body.base_url);
  if (!baseUrl) throw new UrlError("base_url required");
  if (body.api_key !== undefined) return { baseUrl, apiKey: keyField(body.api_key) };
  if (!row) throw new UrlError("api_key required");
  if (baseUrl !== row.base_url) throw new UrlError("api_key required when base_url changes");
  return {
    baseUrl,
    apiKey: await decryptKey(key, user.github_id, { ciphertext: row.key_ciphertext, iv: row.key_iv }),
  };
}

async function listModels(env, user, key, body) {
  const row = await loadRow(env, user.github_id);
  const { baseUrl, apiKey } = await effective(user, key, body, row);
  let parsed;
  try {
    const response = await safeFetch(`${parseBaseUrl(baseUrl)}/models`, {
      headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
    });
    if (!response.ok) return { status: 502, body: { error: `provider HTTP ${response.status}` } };
    parsed = JSON.parse(await readCapped(response, MAX_MODELS_BYTES));
  } catch (err) {
    // Detail is the provider's to give and ours not to relay: it can quote the request.
    console.error("model list failed:", err.name);
    return { status: 502, body: { error: err instanceof UrlError ? err.message : "provider unreachable or invalid" } };
  }
  const entries = Array.isArray(parsed?.data) ? parsed.data : Array.isArray(parsed) ? parsed : [];
  const ids = entries.map((m) => (typeof m === "string" ? m : m?.id)).filter((id) => typeof id === "string");
  return { status: 200, body: { models: [...new Set(ids)].sort().slice(0, MAX_MODELS) } };
}

async function save(env, user, key, body) {
  const row = await loadRow(env, user.github_id);
  const { baseUrl, apiKey } = await effective(user, key, body, row);
  const model = modelField(body.model);

  const sealed =
    body.api_key === undefined
      ? { ciphertext: row.key_ciphertext, iv: row.key_iv, last4: row.key_last4 }
      : { ...(await encryptKey(key, user.github_id, apiKey)), last4: apiKey.slice(-4) };

  await (await db(env))
    .prepare(
      `INSERT INTO user_llm_config (user_id, base_url, key_ciphertext, key_iv, key_last4, model, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(user_id) DO UPDATE SET base_url = excluded.base_url, key_ciphertext = excluded.key_ciphertext,
         key_iv = excluded.key_iv, key_last4 = excluded.key_last4, model = excluded.model, updated_at = excluded.updated_at`,
    )
    .bind(user.github_id, baseUrl, sealed.ciphertext, sealed.iv, sealed.last4, model)
    .run();
  return view({ base_url: baseUrl, key_last4: sealed.last4, model });
}

export async function llmConfig(request, env, headers, user, pathname) {
  const key = await configKey(env);
  if (!key) return json({ error: "not configured" }, 503, headers);

  const models = pathname === "/llm-config/models";
  const allowed = models ? ["POST"] : ["GET", "PUT", "DELETE"];
  if (!allowed.includes(request.method)) return json({ error: "method not allowed" }, 405, headers);

  if (request.method !== "GET") {
    const problem = csrfProblem(request, env, { json: request.method !== "DELETE" });
    if (problem) return json({ error: problem }, 403, headers);
  }

  try {
    if (request.method === "GET") {
      const row = await loadRow(env, user.github_id);
      return json(row ? view(row) : { configured: false }, 200, headers);
    }
    if (request.method === "DELETE") {
      await (await db(env)).prepare("DELETE FROM user_llm_config WHERE user_id = ?").bind(user.github_id).run();
      return new Response(null, { status: 204, headers });
    }
    const body = await readBody(request);
    if (models) {
      const result = await listModels(env, user, key, body);
      return json(result.body, result.status, headers);
    }
    return json(await save(env, user, key, body), 200, headers);
  } catch (err) {
    if (err instanceof UrlError) return json({ error: err.message }, 400, headers);
    console.error("llm-config failed:", err.name);
    return json({ error: "llm-config failed" }, 500, headers);
  }
}
