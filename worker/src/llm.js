// Inference the deployment pays for.
//
// Three ways to reach a model, two of which arrive here:
//
//   anonymous          -> Workers AI, on Cloudflare's free daily allocation
//   allowlisted login  -> the LLM_* secrets, on someone's real credit
//   anyone, own key    -> never reaches this file; the browser calls the
//                         provider directly, so we never take custody of it
//
// Both paths that land here spend money that is not the caller's, so the model
// is pinned server-side in each — letting a request name it invites picking the
// most expensive one available.

import { budgetOf } from "./budget.js";
import { classify, freeTierEnabled, runFreeTier } from "./workers-ai.js";

const MAX_BODY_BYTES = 256 * 1024;

// Resource bounds, not a content filter. Matching the request against the app's
// own system prompt was considered and dropped: that prompt ships in the public
// bundle, so the check is bypassed by reading it, while coupling the Worker to a
// client-side string that would take the free tier down if it ever drifted.
// What actually bounds the damage is the daily allocation Cloudflare enforces,
// the per-IP rate limit, and the size caps here.
const MAX_MESSAGES = 24;
const MAX_CONTENT_CHARS = 24_000;
const MAX_SHARED_OUTPUT_TOKENS = 800;

const json = (body, status, headers) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, "content-type": "application/json" },
  });

export function allowedLogins(env) {
  return new Set(
    (env.GITHUB_ALLOWED_LOGINS ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

// Absent credentials and an empty allowlist both mean the same thing to the
// browser: this deployment has no key to lend you.
export function canUseSharedKey(env, user) {
  if (!env.LLM_API_KEY || !env.LLM_BASE_URL) return false;
  return Boolean(user) && allowedLogins(env).has(user.login.toLowerCase());
}

// Preference, not permission: the shared key is a real budget and the free
// tier is a shared allowance, so an allowlisted account should spend the
// former and leave the latter for visitors.
export function resolveTier(env, user) {
  if (canUseSharedKey(env, user)) return "shared";
  if (freeTierEnabled(env)) return "free";
  return null;
}

// Returns a rejection string, or null when the request is within bounds.
export function checkShape(body) {
  const { messages } = body;
  if (!Array.isArray(messages) || messages.length === 0) return "messages must be a non-empty array";
  if (messages.length > MAX_MESSAGES) return "too many messages";

  let chars = 0;
  for (const message of messages) {
    if (typeof message?.role !== "string") return "each message needs a role";
    chars += typeof message.content === "string" ? message.content.length : 0;
  }
  if (chars > MAX_CONTENT_CHARS) return "conversation too long";
  return null;
}

async function relayToProvider(env, body, headers) {
  const payload = {
    model: env.LLM_MODEL ?? "gpt-4o-mini",
    messages: body.messages,
    max_completion_tokens: MAX_SHARED_OUTPUT_TOKENS,
    ...(body.tools ? { tools: body.tools } : {}),
    ...(body.tool_choice ? { tool_choice: body.tool_choice } : {}),
  };

  const upstream = await fetch(`${env.LLM_BASE_URL.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.LLM_API_KEY}` },
    body: JSON.stringify(payload),
  });

  const text = await upstream.text();
  if (!upstream.ok) {
    // Upstream errors can quote the request, so report the status only rather
    // than risk relaying anything drawn from the key or its account.
    return json({ error: `provider HTTP ${upstream.status}` }, 502, headers);
  }
  return new Response(text, { status: 200, headers: { ...headers, "content-type": "application/json" } });
}

async function serveFreeTier(env, body, headers) {
  const budget = budgetOf(env);

  const before = await budget.peek();
  if (before.exhausted) {
    return json({ error: "free tier exhausted", usage: before }, 429, headers);
  }

  let outcome;
  try {
    outcome = await runFreeTier(env, body);
  } catch (err) {
    const kind = classify(err);

    // Cloudflare's own accounting says the allocation is gone. That is
    // authoritative and ours is not, so latch it and stop issuing requests that
    // cannot succeed until 00:00 UTC.
    if (kind.exhausted) {
      const usage = await budget.exhaust();
      return json({ error: "free tier exhausted", usage }, 429, headers);
    }
    if (kind.transient) {
      return json({ error: "model busy, try again", retry: true }, 503, headers);
    }
    // A pinned model that the plan cannot reach is a deploy mistake, not
    // something the visitor did or can fix.
    if (kind.misconfigured) {
      return json({ error: "free tier misconfigured" }, 500, headers);
    }
    return json({ error: "inference failed" }, 502, headers);
  }

  const usage = await budget.spend(outcome.neurons);
  return json({ ...outcome.reply, usage_budget: usage }, 200, headers);
}

export async function llm(request, env, headers, user) {
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405, headers);

  // Cheapest check first: an unauthorised caller must not be able to make the
  // Worker buffer 256KB before being turned away.
  const tier = resolveTier(env, user);
  if (!tier) return json({ error: "not permitted" }, 403, headers);

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return json({ error: "request too large" }, 413, headers);

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: "invalid JSON" }, 400, headers);
  }

  const wrong = checkShape(body);
  if (wrong) return json({ error: wrong }, 400, headers);

  return tier === "shared"
    ? relayToProvider(env, body, headers)
    : serveFreeTier(env, body, headers);
}

// What the page needs to decide which form to show, and to draw the bar. Public
// on purpose: it reports the deployment's own allowance, nothing about a caller.
export async function usage(env) {
  if (!freeTierEnabled(env)) return { enabled: false };
  return { enabled: true, ...(await budgetOf(env).peek()) };
}
