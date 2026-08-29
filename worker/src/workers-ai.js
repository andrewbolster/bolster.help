// The free tier: inference on Cloudflare's own daily allocation.
//
// 10,000 neurons a day, and on the Workers Free plan that ceiling is enforced
// by Cloudflare rather than by us — the same fail-closed posture as leaving the
// account without a payment method. Nothing here can produce a bill.
//
// The model is pinned server-side. granite-4.0-h-micro was chosen by measuring
// tool-selection accuracy against the retrieval fixtures, not by price: it
// scored 12/12 on the cases that matter (including the three near-identical
// NISRA index tools) at 1.2 neurons a round, while the reasoning models cost
// ten times as much and picked worse — glm-4.7-flash managed 1/4, spending 280
// completion tokens to get there.

// Not "the cheapest model": the cheapest model that reliably picks the right
// tool. A wrong tool is a wrong answer, however little it cost.
export const FREE_TIER_MODEL = "@cf/ibm-granite/granite-4.0-h-micro";

// Output is roughly 6.6x the price of input, and granite answers this workload
// in well under 100 tokens. The cap is an abuse ceiling, not a working limit.
export const MAX_OUTPUT_TOKENS = 400;

// Workers AI reuses HTTP 429 for two conditions needing opposite handling, so
// the internal code is what we branch on.
export const ACCOUNT_LIMITED = 3036; // daily allocation gone; no retry helps
export const OUT_OF_CAPACITY = 3040; // no data centre free; worth retrying

const TRANSIENT = new Set([OUT_OF_CAPACITY, 3007, 3008]);
const MISCONFIGURED = new Set([5035, 3042, 5007]);

// /ai/run rejects an assistant message whose content is null — which is exactly
// what the model returns alongside tool_calls. Echoing a turn back verbatim
// fails with 5006 "Type mismatch ... 'array' not in 'string'", and so does
// omitting the field. Only a string is accepted. The extra nulls the model
// returns alongside (refusal, annotations, audio, reasoning) are dropped for
// the same reason, so the message is rebuilt rather than spread.
export function sanitize(messages) {
  return messages.map((message) => {
    if (message.role !== "assistant") return message;
    const clean = { role: "assistant", content: message.content ?? "" };
    if (message.tool_calls?.length) clean.tool_calls = message.tool_calls;
    return clean;
  });
}

// Errors arrive differently from the binding and from REST, so read the code
// from either a property or the message text rather than trusting one shape.
export function classify(error) {
  const raw = error?.code ?? String(error?.message ?? error).match(/\b(\d{4})\b/)?.[1];
  const code = Number(raw) || 0;
  return {
    code,
    exhausted: code === ACCOUNT_LIMITED,
    transient: TRANSIENT.has(code),
    misconfigured: MISCONFIGURED.has(code),
  };
}

export function freeTierEnabled(env) {
  return Boolean(env.AI && env.NEURON_BUDGET);
}

// Returns the OpenAI-shaped reply plus the neurons it actually cost, so the
// caller can record spend from a measurement rather than an estimate.
export async function runFreeTier(env, { messages, tools, tool_choice }) {
  const reply = await env.AI.run(env.WORKERS_AI_MODEL ?? FREE_TIER_MODEL, {
    messages: sanitize(messages),
    ...(tools?.length ? { tools, tool_choice: tool_choice ?? "auto" } : {}),
    max_tokens: MAX_OUTPUT_TOKENS,
  });
  return { reply, neurons: reply?.usage?.neurons ?? 0 };
}
