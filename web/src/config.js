// Three places this runs, and the Worker is somewhere different in each.
//
// In production it is routed at bolster.help itself, so calls are same-origin:
// no preflight, and the session cookie flows under SameSite=Lax. That is the
// arrangement the auth design depends on.
//
// A Pages preview has no such route — Pages and the Worker are separate hosts —
// so it names the Worker explicitly and talks to it cross-origin. The Worker's
// CORS already allows *.pages.dev. Chatting works fine this way; signing in
// does not, because a Lax cookie will not cross origins. That is a property of
// the preview, not a bug, and it is why the auth tests stay gated on a real
// deployment.
const LOCAL = location.hostname === "localhost" || location.hostname === "127.0.0.1";
const PREVIEW = location.hostname.endsWith(".pages.dev");

const WORKER = "https://bolster-help.andrewbolster.workers.dev";

export const API_ORIGIN = LOCAL ? "http://127.0.0.1:8788" : PREVIEW ? WORKER : "";
export const PROXY_ENDPOINT = `${API_ORIGIN}/mcp-proxy`;
