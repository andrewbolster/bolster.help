// /auth/logout is POST-only and carries the same origin and header checks as the
// other state-changing routes: the session cookie is SameSite=None, so without
// them a cross-site page could sign someone out with a plain request.

import { describe, expect, it } from "vitest";
import worker from "../../worker/src/index.js";
import { fakeEnv, withSession } from "../helpers.mjs";

const user = { github_id: 1, login: "octocat" };
const SESSION_KEY = "session:test-token";

function logout(environment, cookie, { method = "POST", origin = "https://bolster.help", csrf = true } = {}) {
  return worker.fetch(
    new Request("https://bolster.help/auth/logout", {
      method,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(origin ? { origin } : {}),
        ...(csrf ? { "x-bolster-csrf": "1" } : {}),
      },
    }),
    environment,
  );
}

describe("/auth/logout", () => {
  it("deletes the session and clears the cookie", async () => {
    const environment = fakeEnv();
    const cookie = withSession(environment, user);
    expect(environment.SESSIONS.store.has(SESSION_KEY)).toBe(true);

    const response = await logout(environment, cookie);
    expect(response.status).toBe(204);
    expect(environment.SESSIONS.store.has(SESSION_KEY)).toBe(false);
    const setCookie = response.headers.get("set-cookie");
    expect(setCookie).toContain("bolster_session=;");
    expect(setCookie).toContain("Max-Age=0");

    const me = await worker.fetch(
      new Request("https://bolster.help/me", { headers: { cookie, origin: "https://bolster.help" } }),
      environment,
    );
    expect(me.status).toBe(401);
  });

  it("is idempotent for someone who is already signed out", async () => {
    expect((await logout(fakeEnv(), null)).status).toBe(204);
  });

  it("rejects a GET and leaves the session alone", async () => {
    const environment = fakeEnv();
    const cookie = withSession(environment, user);
    const response = await logout(environment, cookie, { method: "GET" });
    expect(response.status).toBe(405);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(environment.SESSIONS.store.has(SESSION_KEY)).toBe(true);
  });

  it.each([
    ["an origin that is not allowed", { origin: "https://evil.example" }, "origin not allowed"],
    ["no origin", { origin: null }, "origin not allowed"],
    ["no csrf header", { csrf: false }, "missing csrf header"],
  ])("rejects a POST with %s and leaves the session alone", async (_name, options, error) => {
    const environment = fakeEnv();
    const cookie = withSession(environment, user);
    const response = await logout(environment, cookie, options);
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe(error);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(environment.SESSIONS.store.has(SESSION_KEY)).toBe(true);
  });
});
