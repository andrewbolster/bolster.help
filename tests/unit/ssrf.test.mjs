// The SSRF guard for user-supplied base URLs. Every case is a way someone might
// point the Worker at something that is not a public provider.

import { afterEach, describe, expect, it, vi } from "vitest";
import { parseBaseUrl, readCapped, safeFetch, UrlError } from "../../worker/src/ssrf.js";

const rejects = (input) => expect(() => parseBaseUrl(input)).toThrow(UrlError);

describe("parseBaseUrl accepts", () => {
  it.each([
    ["https://api.openai.com/v1", "https://api.openai.com/v1"],
    ["https://openrouter.ai/api/v1", "https://openrouter.ai/api/v1"],
    ["https://API.OpenAI.com/v1/", "https://api.openai.com/v1"],
    ["https://api.openai.com./v1", "https://api.openai.com/v1"],
    ["https://api.openai.com:443/v1", "https://api.openai.com/v1"],
    ["  https://api.openai.com/v1  ", "https://api.openai.com/v1"],
    ["https://llm.example.co.uk", "https://llm.example.co.uk"],
    ["https://bücher.example/v1", "https://xn--bcher-kva.example/v1"],
  ])("%s", (input, expected) => {
    expect(parseBaseUrl(input)).toBe(expected);
  });
});

describe("parseBaseUrl rejects", () => {
  it("anything that is not a URL string", () => {
    for (const input of [undefined, null, 42, {}, "", "not a url", "https://", `https://${"a".repeat(3000)}.com`]) {
      rejects(input);
    }
  });

  it("plain http and other schemes", () => {
    for (const input of [
      "http://api.openai.com/v1",
      "ftp://api.openai.com",
      "file:///etc/passwd",
      "ws://api.openai.com",
    ]) {
      rejects(input);
    }
  });

  it("credentials, other ports, queries and fragments", () => {
    for (const input of [
      "https://user:pass@api.openai.com/v1",
      "https://user@api.openai.com/v1",
      "https://api.openai.com:8443/v1",
      "https://api.openai.com:80/v1",
      "https://api.openai.com/v1?x=1",
      "https://api.openai.com/v1#frag",
    ]) {
      rejects(input);
    }
  });

  it("IPv4 literals in every spelling", () => {
    for (const host of [
      "127.0.0.1",
      "10.0.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "0.0.0.0",
      "8.8.8.8",
      "2130706433", // decimal
      "0x7f000001", // hex
      "0x7f.0.0.1",
      "0177.0.0.1", // octal
      "017700000001",
      "127.1", // shorthand
      "127.0.1",
      "1.1.1.1.",
    ]) {
      rejects(`https://${host}/v1`);
    }
  });

  it("IPv6 literals, bracketed and mapped", () => {
    for (const host of ["[::1]", "[::]", "[fd00::1]", "[fe80::1]", "[::ffff:127.0.0.1]", "[2001:db8::1]"]) {
      rejects(`https://${host}/v1`);
    }
  });

  it("localhost and internal-only names", () => {
    for (const host of [
      "localhost",
      "LOCALHOST",
      "localhost.",
      "foo.localhost",
      "printer.local",
      "db.internal",
      "metadata.google.internal",
      "x.workers.dev",
      "workers.dev",
      "x.pages.dev",
      "pages.dev",
    ]) {
      rejects(`https://${host}/v1`);
    }
  });

  it("single-label names, which resolve through search domains", () => {
    for (const host of ["intranet", "router", "metadata"]) rejects(`https://${host}/v1`);
  });

  it("names that are not valid DNS names", () => {
    for (const input of [
      "https://exa mple.com/v1",
      "https://-bad.example/v1",
      "https://bad-.example/v1",
      "https://a..b.example/v1",
    ]) {
      rejects(input);
    }
  });
});

describe("safeFetch", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("never follows redirects and always sets a deadline", async () => {
    const fetchMock = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);
    await safeFetch("https://api.openai.com/v1/models", { headers: { accept: "application/json" } });
    const [, init] = fetchMock.mock.calls[0];
    expect(init.redirect).toBe("manual");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.headers).toEqual({ accept: "application/json" });
  });

  it("treats any 3xx as an error rather than a destination", async () => {
    for (const status of [301, 302, 307, 308]) {
      vi.stubGlobal(
        "fetch",
        async () => new Response(null, { status, headers: { location: "http://169.254.169.254/" } }),
      );
      await expect(safeFetch("https://api.openai.com/v1/models")).rejects.toThrow(/redirect/);
    }
  });

  it("returns non-redirect errors for the caller to interpret", async () => {
    vi.stubGlobal("fetch", async () => new Response("nope", { status: 401 }));
    expect((await safeFetch("https://api.openai.com/v1/models")).status).toBe(401);
  });
});

describe("readCapped", () => {
  it("returns a body within the cap", async () => {
    expect(await readCapped(new Response("hello"), 10)).toBe("hello");
  });

  it("refuses a body over the cap instead of buffering it", async () => {
    await expect(readCapped(new Response("x".repeat(1000)), 100)).rejects.toThrow(/too large/);
  });

  it("treats an empty body as empty", async () => {
    expect(await readCapped(new Response(null), 10)).toBe("");
  });
});
