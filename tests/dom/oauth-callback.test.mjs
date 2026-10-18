// The page an authorization server sends you back to: it finishes the sign-in,
// then returns you to where you started, and only ever to this site.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { finish } from "../../web/src/oauth-callback.js";

let replace;

beforeEach(() => {
  document.body.innerHTML = '<p id="status">Finishing sign-in…</p><p id="back" hidden><a href="/">Back</a></p>';
  replace = vi.spyOn(window.location, "replace").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("finishing a sign-in", () => {
  it("returns you to where you started", async () => {
    await finish({ complete: async () => `${location.origin}/?chat=1` });
    expect(replace).toHaveBeenCalledWith(`${location.origin}/?chat=1`);
  });

  it("will not send you to another site", async () => {
    await finish({ complete: async () => "https://evil.example.com/phish" });
    expect(replace).toHaveBeenCalledWith("/");
  });

  it("will not send you to something that is not a URL", async () => {
    await finish({ complete: async () => "http://[bad" });
    expect(replace).toHaveBeenCalledWith("/");
  });

  it("says what went wrong and offers the way back", async () => {
    await finish({
      complete: async () => {
        throw new Error("the login response did not match the request");
      },
    });
    expect(replace).not.toHaveBeenCalled();
    expect(document.getElementById("status").textContent).toContain("did not match the request");
    expect(document.getElementById("back").hidden).toBe(false);
  });
});
