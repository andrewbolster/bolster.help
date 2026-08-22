// In production the Worker is routed at bolster.help/mcp-proxy, so the call is
// same-origin and never triggers a preflight. Local dev points at wrangler.
const LOCAL = location.hostname === "localhost" || location.hostname === "127.0.0.1";

export const PROXY_ENDPOINT = LOCAL ? "http://127.0.0.1:8788/mcp-proxy" : "/mcp-proxy";
export const API_ORIGIN = LOCAL ? "http://127.0.0.1:8788" : "";

// sessionStorage, so a key survives a reload but not closing the tab. Anything
// longer-lived wants encryption at rest and a clear story about what that does
// and does not defend against; not worth it before the app has users.
export const CREDENTIALS_KEY = "bolster.help/byok";

export const DEFAULT_BASE_URL = "https://api.openai.com/v1";
