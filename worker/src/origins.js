// Origins allowed to call the Worker with credentials. Exact matches only.

export const DEFAULT_ORIGINS = "https://bolster.help,http://localhost:5173";

export const allowedOrigins = (env) => (env.ALLOWED_ORIGINS ?? DEFAULT_ORIGINS).split(",").map((s) => s.trim());

// The session cookie is SameSite=None, so a state-changing request needs more
// than a cookie: an allowed origin and a header a cross-site form cannot set.
// `json` also requires a JSON content type, for requests that carry a body.
export function csrfProblem(request, env, { json = false } = {}) {
  if (!allowedOrigins(env).includes(request.headers.get("origin"))) return "origin not allowed";
  if (request.headers.get("x-bolster-csrf") !== "1") return "missing csrf header";
  if (json && !request.headers.get("content-type")?.startsWith("application/json")) {
    return "content-type must be application/json";
  }
  return null;
}
