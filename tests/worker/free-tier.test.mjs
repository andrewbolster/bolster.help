// The free tier: anonymous inference on Cloudflare's daily allocation.
//
// The budget here is the real Durable Object, running in workerd. That matters:
// NeuronBudget exists because KV cannot hold a counter safely, so testing it
// against a hand-written fake would assert the consistency we wanted rather
// than the one workerd actually gives us.
//
// Workers AI is the one binding stood in for, because there is no local
// simulator for inference. What those cases check is our branching on the
// reply — which error code means stop, which means retry — not the model.

import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:workers";

import { checkShape, llm, resolveTier, usage } from "../../worker/src/llm.js";
import { classify, sanitize, FREE_TIER_MODEL, MAX_OUTPUT_TOKENS } from "../../worker/src/workers-ai.js";
import { DAILY_NEURONS, resetsAt, utcDay } from "../../worker/src/budget.js";
import { aiError, chatBody, fakeAI, fakeEnv, post } from "../helpers.mjs";
import { MAX_ROUNDS } from "../../web/src/agent.js";

const andrew = { github_id: 1, login: "andrewbolster" };

// A fresh Durable Object per test, so one test's spend cannot colour the next.
let budgetName = 0;
const withBudget = (overrides = {}) => {
  const namespace = env.NEURON_BUDGET;
  const stub = namespace.getByName(`test-${budgetName}`);
  return {
    stub,
    env: fakeEnv({
      AI: fakeAI(),
      NEURON_BUDGET: { get: () => stub, idFromName: () => `test-${budgetName}` },
      ...overrides,
    }),
  };
};

beforeEach(() => {
  budgetName += 1;
});

const call = (environment, user, body = chatBody()) => llm(post("/llm", body), environment, {}, user);

describe("NeuronBudget", () => {
  it("starts a day empty", async () => {
    const { stub } = withBudget();
    const view = await stub.peek();
    expect(view.used).toBe(0);
    expect(view.remaining).toBe(DAILY_NEURONS);
    expect(view.exhausted).toBe(false);
  });

  it("accumulates spend across calls", async () => {
    const { stub } = withBudget();
    await stub.spend(1.2);
    await stub.spend(2.3);
    const view = await stub.peek();
    expect(view.used).toBeCloseTo(3.5, 2);
    expect(view.requests).toBe(2);
  });

  // The property KV could not give us: concurrent read-modify-write against one
  // instance serialises, so no update is lost.
  it("loses no updates under concurrent spend", async () => {
    const { stub } = withBudget();
    await Promise.all(Array.from({ length: 50 }, () => stub.spend(1)));
    const view = await stub.peek();
    expect(view.used).toBe(50);
    expect(view.requests).toBe(50);
  });

  it("reports exhaustion once the allocation is gone", async () => {
    const { stub } = withBudget();
    await stub.spend(DAILY_NEURONS);
    expect((await stub.peek()).exhausted).toBe(true);
    expect((await stub.peek()).remaining).toBe(0);
  });

  it("latches to the ceiling when Cloudflare says so", async () => {
    const { stub } = withBudget();
    await stub.spend(10);
    const view = await stub.exhaust();
    expect(view.exhausted).toBe(true);
    expect(view.used).toBe(DAILY_NEURONS);
  });

  it("ignores a negative or malformed spend rather than crediting itself", async () => {
    const { stub } = withBudget();
    await stub.spend(-100);
    await stub.spend(undefined);
    expect((await stub.peek()).used).toBe(0);
  });
});

describe("tier resolution", () => {
  it("gives an anonymous visitor the free tier when it is configured", () => {
    expect(resolveTier(withBudget().env, null)).toBe("free");
  });

  it("refuses everyone when neither tier is configured", () => {
    expect(resolveTier(fakeEnv(), null)).toBe(null);
    expect(resolveTier(fakeEnv(), andrew)).toBe(null);
  });

  // The shared key is a real budget; the free tier is a shared allowance. An
  // account entitled to the former should not draw down the latter.
  it("prefers the shared key for an allowlisted account", () => {
    const { env: environment } = withBudget({
      LLM_API_KEY: "sk-test",
      LLM_BASE_URL: "https://provider.example/v1",
      GITHUB_ALLOWED_LOGINS: "andrewbolster",
    });
    expect(resolveTier(environment, andrew)).toBe("shared");
    expect(resolveTier(environment, { login: "stranger" })).toBe("free");
  });
});

describe("request bounds", () => {
  // Resource limits, not a content filter — matching against the app's own
  // system prompt was dropped, since that prompt ships in the public bundle.
  it("accepts the app's own request", () => {
    expect(checkShape(chatBody())).toBe(null);
  });

  it("rejects a missing or empty message list", () => {
    expect(checkShape({})).toMatch(/non-empty array/);
    expect(checkShape({ messages: [] })).toMatch(/non-empty array/);
  });

  // The regression this file exists to prevent. A tool-calling turn appends an
  // assistant message and a result message per round, so a loop allowed 32
  // rounds sends upwards of 65 messages. A count-based cap here would cut that
  // off partway through and surface as the model mysteriously giving up.
  it("accepts as many messages as a full tool-calling loop produces", () => {
    const messages = [{ role: "system", content: "s" }, { role: "user", content: "q" }];
    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      messages.push({ role: "assistant", content: "" }, { role: "tool", content: "result" });
    }
    expect(messages.length).toBeGreaterThan(60);
    expect(checkShape({ messages })).toBeNull();
  });

  it("rejects a conversation past the model's context window", () => {
    const body = chatBody();
    body.messages.push({ role: "user", content: "x".repeat(400_001) });
    expect(checkShape(body)).toMatch(/too long/);
  });

  it("accepts a long conversation that still fits the context window", () => {
    const body = chatBody();
    body.messages.push({ role: "user", content: "x".repeat(100_000) });
    expect(checkShape(body)).toBeNull();
  });
});

describe("/llm on the free tier", () => {
  it("serves an anonymous visitor and records what it cost", async () => {
    const { stub, env: environment } = withBudget({ AI: fakeAI({ neurons: 2.5 }) });
    const response = await call(environment, null);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.choices).toBeTruthy();
    expect(body.usage_budget.used).toBeCloseTo(2.5, 2);
    expect((await stub.peek()).used).toBeCloseTo(2.5, 2);
  });

  it("pins the model and caps output rather than letting the caller choose", async () => {
    const ai = fakeAI();
    const { env: environment } = withBudget({ AI: ai });
    await call(environment, null, chatBody({ model: "@cf/expensive", max_tokens: 100_000 }));

    expect(ai.seen[0].model).toBe(FREE_TIER_MODEL);
    expect(ai.seen[0].inputs.max_tokens).toBe(MAX_OUTPUT_TOKENS);
  });

  it("refuses before calling the model once the allowance is gone", async () => {
    const ai = fakeAI();
    const { stub, env: environment } = withBudget({ AI: ai });
    await stub.spend(DAILY_NEURONS);

    const response = await call(environment, null);
    expect(response.status).toBe(429);
    const body = await response.json();
    expect(body.error).toBe("free tier exhausted");
    expect(body.usage.resetsAt).toBeTruthy();
    expect(ai.seen.length).toBe(0);
  });
});

describe("Workers AI error handling", () => {
  // 429 covers two conditions needing opposite responses: 3036 cannot be
  // retried before midnight UTC, 3040 should be retried immediately.
  it("latches the budget when Cloudflare reports the allocation gone", async () => {
    const { stub, env: environment } = withBudget({ AI: fakeAI({ throws: aiError(3036) }) });
    const response = await call(environment, null);

    expect(response.status).toBe(429);
    expect((await stub.peek()).exhausted).toBe(true);
  });

  it("treats out-of-capacity as retryable and does not burn the day", async () => {
    const { stub, env: environment } = withBudget({ AI: fakeAI({ throws: aiError(3040) }) });
    const response = await call(environment, null);

    expect(response.status).toBe(503);
    expect((await response.json()).retry).toBe(true);
    expect((await stub.peek()).exhausted).toBe(false);
  });

  it("distinguishes a deploy mistake from a visitor's problem", async () => {
    // 5035 means the pinned model needs a paid plan — nothing the caller did.
    const { env: environment } = withBudget({ AI: fakeAI({ throws: aiError(5035) }) });
    const response = await call(environment, null);
    expect(response.status).toBe(500);
    expect((await response.json()).error).toMatch(/misconfigured/);
  });

  it("reads the code from the message when the binding gives no property", () => {
    expect(classify(new Error("3036: AiError: used up your daily free allocation")).exhausted).toBe(true);
    expect(classify(aiError(3040)).transient).toBe(true);
    expect(classify(new Error("something else")).code).toBe(0);
  });

  // The case that actually turned up: the account's allocation was spent by
  // something other than this Worker, so our own counter still read healthy and
  // Cloudflare refused with no numeric code to go on. Only the text said why.
  it("recognises exhaustion from the message when there is no code", () => {
    for (const message of [
      "You have used up your daily free allocation of neurons",
      "Account limited",
      "quota exceeded for this account",
    ]) {
      expect(classify(new Error(message)).exhausted, message).toBe(true);
    }
  });

  it("recognises an authentication failure from the message", () => {
    const kind = classify(new Error("Authentication error (10000)"));
    expect(kind.unauthorised).toBe(true);
    expect(kind.exhausted).toBe(false);
  });

  it("does not read exhaustion into an unrelated failure", () => {
    const kind = classify(new Error("upstream connection reset"));
    expect(kind.exhausted).toBe(false);
    expect(kind.unauthorised).toBe(false);
    expect(kind.transient).toBe(false);
    expect(kind.misconfigured).toBe(false);
  });
});

// Every failure carries a machine-readable reason, because "inference failed"
// on its own tells the visitor nothing about whether waiting, retrying or
// giving up is the right response.
describe("failures say why", () => {
  const reasonFor = async (thrown) => {
    const { env: environment } = withBudget({ AI: fakeAI({ throws: thrown }) });
    return (await (await call(environment, null)).json()).reason;
  };

  it("names a busy model as retryable", async () => {
    expect(await reasonFor(aiError(3040))).toBe("busy");
  });

  it("names a deploy mistake as ours", async () => {
    expect(await reasonFor(aiError(5035))).toBe("misconfigured");
  });

  it("names an unrecognised failure rather than leaving it blank", async () => {
    expect(await reasonFor(new Error("upstream connection reset"))).toBe("unknown");
  });

  // The scenario this covers happened for real: a sibling project spent the
  // account's shared allocation, so Cloudflare refused with no numeric code —
  // and until this latched, /usage kept reporting the healthy number this
  // Worker's own tally last saw, which is exactly backwards for a visitor
  // trying to decide whether to wait it out or come back tomorrow.
  it("reports an authentication failure as unauthorised and latches the budget", async () => {
    const { stub, env: environment } = withBudget({ AI: fakeAI({ throws: new Error("Authentication error (10000)") }) });
    const response = await call(environment, null);

    expect(response.status).toBe(503);
    expect((await response.json()).reason).toBe("unauthorised");
    expect((await stub.peek()).exhausted).toBe(true);
  });

  it("distinguishes a conversation that outgrew the context window", async () => {
    const { env: environment } = withBudget({ AI: fakeAI({ neurons: 1 }) });
    const body = chatBody();
    body.messages.push({ role: "user", content: "x".repeat(400_001) });

    const response = await call(environment, null, body);
    expect(response.status).toBe(400);
    expect((await response.json()).reason).toBe("too_long");
  });
});

describe("assistant message sanitising", () => {
  // /ai/run rejects content: null, which is exactly what the model returns
  // beside tool_calls — so replaying a turn verbatim fails with 5006.
  it("coerces null content to a string and drops the model's extra nulls", () => {
    const [clean] = sanitize([
      { role: "assistant", content: null, refusal: null, reasoning: null, tool_calls: [{ id: "c1" }] },
    ]);
    expect(clean).toEqual({ role: "assistant", content: "", tool_calls: [{ id: "c1" }] });
  });

  it("leaves system, user and tool messages untouched", () => {
    const messages = [
      { role: "system", content: "prompt" },
      { role: "user", content: "hi" },
      { role: "tool", tool_call_id: "c1", content: "42" },
    ];
    expect(sanitize(messages)).toEqual(messages);
  });
});

describe("budget arithmetic", () => {
  it("buckets by UTC day, matching when Cloudflare resets", () => {
    expect(utcDay(new Date("2026-08-29T23:59:59Z"))).toBe("2026-08-29");
    expect(utcDay(new Date("2026-08-30T00:00:01Z"))).toBe("2026-08-30");
  });

  it("resets at the next UTC midnight", () => {
    expect(resetsAt(new Date("2026-08-29T13:00:00Z"))).toBe("2026-08-30T00:00:00.000Z");
  });
});

describe("/usage", () => {
  it("says the free tier is off when there is no binding", async () => {
    expect(await usage(fakeEnv())).toEqual({ enabled: false });
  });

  it("reports the allowance without needing a session", async () => {
    const { stub, env: environment } = withBudget();
    await stub.spend(2_500);
    const report = await usage(environment);
    expect(report.enabled).toBe(true);
    expect(report.remaining).toBeCloseTo(7_500, 2);
    expect(report.exhausted).toBe(false);
  });
});
