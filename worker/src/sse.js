// Its own module, with no other imports, specifically so tests/unit — plain
// Node, no `cloudflare:workers` shim — can import it directly rather than
// through worker/src/index.js and its Durable Object dependency chain.

// FastMCP's streamable-HTTP transport frames replies as SSE even for
// single-shot calls. A tool that logs via ctx.info()/ctx.warning() while it
// runs (check_availability does) gets one SSE frame per log line *before*
// the frame carrying the actual result — those are JSON-RPC notifications
// (no "id"), so grabbing the first `data:` line returned the log message
// instead of the answer. Only a frame with "id" is the real response; keep
// scanning past notification frames until one shows up.
export function parseUpstream(text) {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  let lastFrame = null;
  for (const line of trimmed.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const parsed = JSON.parse(line.slice(5).trim());
    lastFrame = parsed;
    if ("id" in parsed) return parsed;
  }
  if (lastFrame) return lastFrame;
  throw new Error("upstream returned neither JSON nor SSE");
}
