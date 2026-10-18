// GitHub OAuth, identity only.
//
// Signing in buys one thing: somewhere to keep a conversation. It has no
// bearing on inference, which always runs in the browser. So the only scope
// requested is the default (public profile) — no repo, no Copilot entitlement.

import { csrfProblem } from "./origins.js";

const SESSION_TTL = 60 * 60 * 24 * 30;
const STATE_TTL = 600;
// The shortest TTL KV accepts. The code is only the hand-off from the redirect
// to the page, which exchanges it straight away.
const CODE_TTL = 60;

// The session travels as `Authorization: Bearer <token>`, never as a cookie:
// the page and this Worker are on different sites, and browsers that block
// third-party cookies would drop one silently.
const bearerToken = (request) => /^Bearer (\S+)$/.exec(request.headers.get("authorization") ?? "")?.[1] ?? null;

// Only bounce back to an origin we already serve: an unchecked redirect
// parameter is an open redirect wearing a login button.
function safeRedirect(candidate, env) {
  const allowed = (env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim());
  try {
    const url = new URL(candidate);
    return allowed.includes(url.origin) ? url.toString() : allowed[0];
  } catch {
    return allowed[0];
  }
}

export async function login(request, env) {
  const back = safeRedirect(new URL(request.url).searchParams.get("redirect") ?? "", env);
  const state = crypto.randomUUID();
  await env.SESSIONS.put(`state:${state}`, back, { expirationTtl: STATE_TTL });

  const authorize = new URL("https://github.com/login/oauth/authorize");
  authorize.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  authorize.searchParams.set("redirect_uri", `${new URL(request.url).origin}/auth/github/callback`);
  authorize.searchParams.set("state", state);

  return Response.redirect(authorize.toString(), 302);
}

export async function callback(request, env) {
  const params = new URL(request.url).searchParams;
  const code = params.get("code");
  const state = params.get("state");
  if (!code || !state) return new Response("missing code or state", { status: 400 });

  const back = await env.SESSIONS.get(`state:${state}`);
  if (!back) return new Response("stale or unknown state", { status: 400 });
  await env.SESSIONS.delete(`state:${state}`);

  const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
    }),
  });
  const { access_token: accessToken } = await tokenResponse.json();
  if (!accessToken) return new Response("token exchange failed", { status: 502 });

  const userResponse = await fetch("https://api.github.com/user", {
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "application/vnd.github+json",
      "user-agent": "bolster.help",
    },
  });
  if (!userResponse.ok) return new Response("could not read profile", { status: 502 });
  const profile = await userResponse.json();

  await env.DB.prepare(
    "INSERT INTO users (github_id, login) VALUES (?, ?) ON CONFLICT(github_id) DO UPDATE SET login = excluded.login",
  )
    .bind(profile.id, profile.login)
    .run();

  // The GitHub token is deliberately not kept: nothing here ever calls GitHub
  // again on the user's behalf.
  const token = crypto.randomUUID();
  await env.SESSIONS.put(`session:${token}`, JSON.stringify({ github_id: profile.id, login: profile.login }), {
    expirationTtl: SESSION_TTL,
  });

  // The page gets a single-use code in the URL fragment (never sent to a server,
  // and never the session token itself) and trades it at POST /auth/session.
  const handoff = crypto.randomUUID();
  await env.SESSIONS.put(`code:${handoff}`, token, { expirationTtl: CODE_TTL });
  const destination = new URL(safeRedirect(back, env));
  destination.hash = new URLSearchParams({ code: handoff }).toString();

  return new Response(null, { status: 302, headers: { location: destination.toString() } });
}

export async function exchange(request, env, headers) {
  const reply = (body, status) =>
    new Response(JSON.stringify(body), { status, headers: { ...headers, "content-type": "application/json" } });
  const problem = csrfProblem(request, env, { json: true });
  if (problem) return reply({ error: problem }, 403);

  const code = (await request.json().catch(() => null))?.code;
  if (typeof code !== "string" || !code) return reply({ error: "code required" }, 400);
  const token = await env.SESSIONS.get(`code:${code}`);
  if (!token) return reply({ error: "invalid or expired code" }, 400);
  await env.SESSIONS.delete(`code:${code}`);
  return reply({ token }, 200);
}

export async function logout(request, env, headers) {
  const token = bearerToken(request);
  if (token) await env.SESSIONS.delete(`session:${token}`);
  return new Response(null, { status: 204, headers });
}

export async function session(request, env) {
  const token = bearerToken(request);
  if (!token) return null;
  const raw = await env.SESSIONS.get(`session:${token}`);
  return raw ? JSON.parse(raw) : null;
}
