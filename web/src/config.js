// In production the Worker is routed at bolster.help/mcp-proxy, so the call is
// same-origin and never triggers a preflight. Local dev points at wrangler.
export const PROXY_ENDPOINT =
  location.hostname === "localhost" || location.hostname === "127.0.0.1"
    ? "http://127.0.0.1:8788/mcp-proxy"
    : "/mcp-proxy";

export const MODELS = [
  { id: "Hermes-2-Pro-Llama-3-8B-q4f16_1-MLC", label: "Hermes 2 Pro 8B", size: "~4.5 GB" },
  { id: "Qwen2.5-7B-Instruct-q4f16_1-MLC", label: "Qwen 2.5 7B", size: "~4.5 GB" },
];

export const DEFAULT_MODEL = MODELS[0].id;

export const WEBLLM_CDN = "https://esm.run/@mlc-ai/web-llm";
