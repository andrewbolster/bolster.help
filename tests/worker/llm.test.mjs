// The shared-key route.
//
// /llm spends the deployment's own credit, so the interesting behaviour is all
// refusal. Every case below returns before the provider is contacted; the one
// case that does reach a provider is skip-gated in integration.test.mjs.

import { describe, it } from "vitest";
import assert from "node:assert/strict";

import { allowedLogins, canUseSharedKey, llm } from "../../worker/src/llm.js";
import { fakeEnv, post, request } from "../helpers.mjs";

const configured = (overrides = {}) => ({
  LLM_API_KEY: "sk-test",
  LLM_BASE_URL: "https://provider.example/v1",
  GITHUB_ALLOWED_LOGINS: "andrewbolster",
  ...overrides,
});

const andrew = { github_id: 1, login: "andrewbolster" };
const stranger = { github_id: 2, login: "someone-else" };

const body = { messages: [{ role: "user", content: "hi" }] };
const errorFrom = async (response) => (await response.json()).error;

describe("allowedLogins", () => {
  it("is empty when unset, so no one qualifies by default", () => {
    assert.equal(allowedLogins({}).size, 0);
  });

  it("trims, lowercases and drops blanks", () => {
    assert.deepEqual(
      [...allowedLogins({ GITHUB_ALLOWED_LOGINS: " AndrewBolster , ,octocat " })],
      ["andrewbolster", "octocat"],
    );
  });
});

describe("canUseSharedKey", () => {
  // Absent credentials and an empty allowlist mean the same thing to the
  // browser — show the bring-your-own-key form — so both must answer false.
  it("is false when the deployment has no key to lend", () => {
    assert.equal(canUseSharedKey({ GITHUB_ALLOWED_LOGINS: "andrewbolster" }, andrew), false);
    assert.equal(canUseSharedKey(configured({ LLM_API_KEY: undefined }), andrew), false);
    assert.equal(canUseSharedKey(configured({ LLM_BASE_URL: undefined }), andrew), false);
  });

  it("is false for an anonymous visitor even when configured", () => {
    assert.equal(canUseSharedKey(configured(), null), false);
  });

  it("is false for a signed-in login that is not on the allowlist", () => {
    assert.equal(canUseSharedKey(configured(), stranger), false);
  });

  it("is false when configured but the allowlist is empty", () => {
    assert.equal(canUseSharedKey(configured({ GITHUB_ALLOWED_LOGINS: "" }), andrew), false);
  });

  it("is true only for a signed-in, allowlisted login on a configured deployment", () => {
    assert.equal(canUseSharedKey(configured(), andrew), true);
  });

  it("matches the login case-insensitively", () => {
    assert.equal(canUseSharedKey(configured(), { login: "AndrewBolster" }), true);
  });
});

describe("/llm", () => {
  const call = (env, user, payload = body, options) =>
    llm(post("/llm", payload, options), env, {}, user);

  it("rejects a non-POST before any gate", async () => {
    const response = await llm(request("/llm"), configured(), {}, andrew);
    assert.equal(response.status, 405);
  });

  it("refuses an anonymous caller with 403", async () => {
    const response = await call(configured(), null);
    assert.equal(response.status, 403);
    assert.equal(await errorFrom(response), "not permitted");
  });

  it("refuses a signed-in caller who is not allowlisted", async () => {
    const response = await call(configured(), stranger);
    assert.equal(response.status, 403);
  });

  // /me only ever hints at this; the gate is re-evaluated on every call, so an
  // allowlist edit takes effect without waiting for a session to expire.
  it("refuses an allowlisted caller once the allowlist drops them", async () => {
    const response = await call(configured({ GITHUB_ALLOWED_LOGINS: "octocat" }), andrew);
    assert.equal(response.status, 403);
  });

  it("refuses a body over the 256KB cap", async () => {
    const response = await call(configured(), andrew, "x".repeat(257 * 1024));
    assert.equal(response.status, 413);
    assert.equal(await errorFrom(response), "request too large");
  });

  it("refuses a body that is not JSON", async () => {
    const response = await call(configured(), andrew, "{not json");
    assert.equal(response.status, 400);
    assert.equal(await errorFrom(response), "invalid JSON");
  });

  it("gates on permission before reading the body at all", async () => {
    // An oversized body from a stranger is a 403, not a 413: the cheap check
    // runs first, so an unauthorised caller cannot make the Worker buffer 256KB.
    const response = await call(configured(), stranger, "x".repeat(257 * 1024));
    assert.equal(response.status, 403);
  });
});
