// Tools reachable through the public proxy.
//
// Derived from the tools.json snapshot rather than hand-maintained: every
// tool mcp.bolster.online exposes is available here too, today and as new
// tools are added upstream. Running `npm run refresh-tools` is enough to
// pick one up — no second file to remember to edit.
//
// EXCLUDED_TOOLS is the escape hatch for the rare tool that genuinely
// shouldn't be reachable anonymously (e.g. a real write side-effect, or a
// per-call cost the proxy has no budget for) — empty until a real case
// shows up. Add an entry only for a concrete, verified reason, not a
// precautionary default.
import snapshot from "../../web/src/tools.json";

export const EXCLUDED_TOOLS = {};

export const ALLOWED_TOOLS = new Set(
  snapshot.tools.map((tool) => tool.name).filter((name) => !(name in EXCLUDED_TOOLS)),
);

export const ALLOWED_METHODS = new Set(["initialize", "notifications/initialized", "tools/list", "tools/call", "ping"]);
