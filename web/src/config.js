// The page and the API are always on different origins.
//
// GitHub Pages serves the site at bolster.help; the API is a Cloudflare Worker.
// Keeping them apart avoids moving the domain onto Cloudflare, and costs a CORS
// preflight per call — the Worker allowlists this origin and answers it.
//
// The consequence worth knowing: a `SameSite=Lax` cookie will not travel
// cross-site, so signing in needs the session cookie issued as
// `SameSite=None; Secure`. Chatting is unaffected, since it uses no cookie.
const LOCAL = location.hostname === "localhost" || location.hostname === "127.0.0.1";

export const API_ORIGIN = LOCAL ? "http://127.0.0.1:8788" : "https://bolster-help.andrewbolster.workers.dev";

export const PROXY_ENDPOINT = `${API_ORIGIN}/mcp-proxy`;

// The public MCP server. Its authenticated endpoint re-exports every public
// tool, so connecting to it replaces the public catalogue (see toolset.js).
export const PUBLIC_MCP_ORIGIN = "https://mcp.bolster.online";
export const SUGGESTED_SERVER = "https://mcp.bolster.online/auth/mcp";

// Where an authorization server sends you back to: a static page, because the
// site is static. It works on localhost too.
export const OAUTH_REDIRECT_URI = `${location.origin}/oauth/callback.html`;
