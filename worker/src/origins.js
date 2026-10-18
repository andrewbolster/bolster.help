// Origins allowed to call the Worker. Exact matches only.

export const DEFAULT_ORIGINS = "https://bolster.help,http://localhost:5173";

export const allowedOrigins = (env) => (env.ALLOWED_ORIGINS ?? DEFAULT_ORIGINS).split(",").map((s) => s.trim());

// A state-changing request needs an allowed origin and a header a cross-site
// form cannot set. The session is a bearer token, not a cookie, so this is a
// second line rather than the only one. `json` also requires a JSON content
// type, for requests that carry a body.
export function csrfProblem(request, env, { json = false } = {}) {
  if (!allowedOrigins(env).includes(request.headers.get("origin"))) return "origin not allowed";
  if (request.headers.get("x-bolster-csrf") !== "1") return "missing csrf header";
  if (json && !request.headers.get("content-type")?.startsWith("application/json")) {
    return "content-type must be application/json";
  }
  return null;
}
