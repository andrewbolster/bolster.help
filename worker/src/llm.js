// Inference on the deployment's own credentials.
//
// A key set as a Worker secret cannot be handed to the browser, so unlike a
// user's own key these requests have to be relayed. That makes this route a
// way to spend someone else's money, which is why it is gated twice: signed in,
// and named in GITHUB_ALLOWED_LOGINS. Everyone else supplies their own key and
// talks to their provider directly, never touching this code.

const MAX_BODY_BYTES = 256 * 1024;

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
// browser: this deployment has no key to lend you, so show the BYOK form.
export function canUseSharedKey(env, user) {
  if (!env.LLM_API_KEY || !env.LLM_BASE_URL) return false;
  return Boolean(user) && allowedLogins(env).has(user.login.toLowerCase());
}

export async function llm(request, env, headers, user) {
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405, headers);
  if (!canUseSharedKey(env, user)) return json({ error: "not permitted" }, 403, headers);

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return json({ error: "request too large" }, 413, headers);

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: "invalid JSON" }, 400, headers);
  }

  // The model is the deployment's choice, not the caller's: letting a request
  // name it invites picking the most expensive one available on the key.
  const payload = {
    model: env.LLM_MODEL ?? "gpt-4o-mini",
    messages: body.messages,
    ...(body.tools ? { tools: body.tools } : {}),
    ...(body.tool_choice ? { tool_choice: body.tool_choice } : {}),
  };

  const endpoint = `${env.LLM_BASE_URL.replace(/\/+$/, "")}/chat/completions`;
  const upstream = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.LLM_API_KEY}`,
    },
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
