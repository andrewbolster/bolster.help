// The authorization flow against canned servers: what it asks for, what it
// accepts, and what it refuses.

import { describe, expect, it } from "vitest";

import {
  buildAuthorizeUrl,
  discover,
  exchangeCode,
  OAuthError,
  pkceChallenge,
  refreshTokens,
  register,
  resourceMetadataFrom,
} from "../../web/src/oauth.js";
import { AUTH, AUTH_SERVER, json, PROTECTED_RESOURCE, REDIRECT, SERVER, stubFetch } from "../web-helpers.mjs";

describe("PKCE", () => {
  it("matches the RFC 7636 test vector", async () => {
    expect(await pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });
});

describe("discovery", () => {
  it("finds the metadata through the path-aware well-known URLs", async () => {
    const found = await discover(SERVER, { fetchFn: stubFetch() });
    expect(found.resource).toBe(SERVER);
    expect(found.issuer).toBe(AUTH);
    expect(found.meta.token_endpoint).toBe(`${AUTH}/token`);
    expect(found.scopes).toEqual(["user"]);
  });

  it("prefers the URL the server hints at in WWW-Authenticate", async () => {
    const fetchFn = stubFetch({
      [`POST ${SERVER}`]: () =>
        new Response(null, {
          status: 401,
          headers: { "www-authenticate": 'Bearer resource_metadata="https://mcp.example.com/hinted"' },
        }),
      "GET https://mcp.example.com/hinted": () => json(PROTECTED_RESOURCE),
    });
    await discover(SERVER, { fetchFn });
    expect(fetchFn.calls.map((c) => c.url)).toContain("https://mcp.example.com/hinted");
    expect(fetchFn.calls.map((c) => c.url)).not.toContain(
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp",
    );
  });

  it("falls back to the root well-known URL", async () => {
    const fetchFn = stubFetch({
      "GET https://mcp.example.com/.well-known/oauth-protected-resource/mcp": () => new Response(null, { status: 404 }),
      "GET https://mcp.example.com/.well-known/oauth-protected-resource": () => json(PROTECTED_RESOURCE),
    });
    expect((await discover(SERVER, { fetchFn })).issuer).toBe(AUTH);
  });

  it("falls back to OpenID configuration for the authorization server", async () => {
    const fetchFn = stubFetch({
      [`GET ${AUTH}/.well-known/oauth-authorization-server`]: () => new Response(null, { status: 404 }),
      [`GET ${AUTH}/.well-known/openid-configuration`]: () => json(AUTH_SERVER),
    });
    expect((await discover(SERVER, { fetchFn })).meta.authorization_endpoint).toBe(`${AUTH}/authorize`);
  });

  it("refuses metadata that names a different issuer", async () => {
    const fetchFn = stubFetch({
      [`GET ${AUTH}/.well-known/oauth-authorization-server`]: () =>
        json({ ...AUTH_SERVER, issuer: "https://evil.example.com" }),
    });
    await expect(discover(SERVER, { fetchFn })).rejects.toThrow(/different issuer/);
  });

  it("refuses metadata that names a different resource", async () => {
    const fetchFn = stubFetch({
      "GET https://mcp.example.com/.well-known/oauth-protected-resource/mcp": () =>
        json({ ...PROTECTED_RESOURCE, resource: "https://other.example.com/mcp" }),
    });
    await expect(discover(SERVER, { fetchFn })).rejects.toThrow(/different resource/);
  });

  it("refuses an authorization endpoint that is not https", async () => {
    const fetchFn = stubFetch({
      [`GET ${AUTH}/.well-known/oauth-authorization-server`]: () =>
        json({ ...AUTH_SERVER, authorization_endpoint: "http://auth.example.com/authorize" }),
    });
    await expect(discover(SERVER, { fetchFn })).rejects.toThrow(/must use https/);
  });

  it("refuses an authorization server without PKCE S256", async () => {
    const fetchFn = stubFetch({
      [`GET ${AUTH}/.well-known/oauth-authorization-server`]: () =>
        json({ ...AUTH_SERVER, code_challenge_methods_supported: ["plain"] }),
    });
    await expect(discover(SERVER, { fetchFn })).rejects.toThrow(/PKCE/);
  });

  it("refuses a server URL that is not https, but allows localhost", async () => {
    await expect(discover("http://mcp.example.com/mcp", { fetchFn: stubFetch() })).rejects.toThrow(/must use https/);
    const local = "http://localhost:8000/mcp";
    const fetchFn = stubFetch({
      [`POST ${local}`]: () => new Response(null, { status: 401 }),
      "GET http://localhost:8000/.well-known/oauth-protected-resource/mcp": () =>
        json({ ...PROTECTED_RESOURCE, resource: local }),
    });
    expect((await discover(local, { fetchFn })).origin).toBe("http://localhost:8000");
  });

  it("says so when the server asks for no login", async () => {
    const fetchFn = stubFetch({ [`POST ${SERVER}`]: () => json({ result: {} }) });
    await expect(discover(SERVER, { fetchFn })).rejects.toThrow(/did not ask for a login/);
  });

  it("explains a server that cannot be reached from a page", async () => {
    const fetchFn = async () => {
      throw new TypeError("Failed to fetch");
    };
    await expect(discover(SERVER, { fetchFn })).rejects.toThrow(/cross-origin/);
  });

  it("parses the resource_metadata hint", () => {
    expect(resourceMetadataFrom('Bearer error="x", resource_metadata="https://a.example/m"')).toBe(
      "https://a.example/m",
    );
    expect(resourceMetadataFrom("Bearer")).toBeNull();
  });
});

describe("registration", () => {
  const meta = { registration_endpoint: `${AUTH}/register` };

  it("registers a public client with the callback", async () => {
    const fetchFn = stubFetch();
    const registration = await register(meta, { redirectUri: REDIRECT, fetchFn });
    expect(registration).toMatchObject({ client_id: "client-1", auth_method: "none", redirect_uri: REDIRECT });
    const body = JSON.parse(fetchFn.calls.at(-1).init.body);
    expect(body).toMatchObject({
      redirect_uris: [REDIRECT],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
  });

  it("keeps a client secret if the server insists on issuing one", async () => {
    const fetchFn = stubFetch({
      [`POST ${AUTH}/register`]: () =>
        json({ client_id: "c", client_secret: "s3cret", token_endpoint_auth_method: "client_secret_post" }, 201),
    });
    expect(await register(meta, { redirectUri: REDIRECT, fetchFn })).toMatchObject({
      client_secret: "s3cret",
      auth_method: "client_secret_post",
    });
  });

  it("says so when there is no registration endpoint or it refuses", async () => {
    await expect(register({}, { redirectUri: REDIRECT })).rejects.toThrow(/does not offer dynamic client registration/);
    const fetchFn = stubFetch({ [`POST ${AUTH}/register`]: () => json({}, 400) });
    await expect(register(meta, { redirectUri: REDIRECT, fetchFn })).rejects.toThrow(/refused \(HTTP 400\)/);
  });
});

describe("authorize URL", () => {
  it("carries PKCE, state, resource and scope", () => {
    const url = new URL(
      buildAuthorizeUrl({
        meta: AUTH_SERVER,
        registration: { client_id: "client-1", redirect_uri: REDIRECT },
        resource: SERVER,
        scope: "user",
        state: "st",
        challenge: "ch",
      }),
    );
    expect(url.origin + url.pathname).toBe(`${AUTH}/authorize`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: "client-1",
      redirect_uri: REDIRECT,
      state: "st",
      code_challenge: "ch",
      code_challenge_method: "S256",
      resource: SERVER,
      scope: "user",
    });
  });
});

describe("tokens", () => {
  const registration = { client_id: "client-1", redirect_uri: REDIRECT, auth_method: "none" };

  it("exchanges a code with the verifier, redirect and resource", async () => {
    const fetchFn = stubFetch();
    const tokens = await exchangeCode(AUTH_SERVER, registration, {
      code: "code-1",
      verifier: "ver",
      resource: SERVER,
      fetchFn,
      now: () => 1_000,
    });
    const sent = new URLSearchParams(fetchFn.calls.at(-1).init.body);
    expect(Object.fromEntries(sent)).toEqual({
      grant_type: "authorization_code",
      code: "code-1",
      code_verifier: "ver",
      redirect_uri: REDIRECT,
      resource: SERVER,
      client_id: "client-1",
    });
    expect(tokens).toMatchObject({
      access_token: "access-1",
      refresh_token: "refresh-1",
      expires_at: 1_000 + 3_600_000,
    });
  });

  it("sends a client secret only when it has one", async () => {
    const fetchFn = stubFetch();
    await exchangeCode(
      AUTH_SERVER,
      { ...registration, client_secret: "s3cret", auth_method: "client_secret_post" },
      {
        code: "c",
        verifier: "v",
        resource: SERVER,
        fetchFn,
      },
    );
    expect(new URLSearchParams(fetchFn.calls.at(-1).init.body).get("client_secret")).toBe("s3cret");
  });

  it("repeats only the error code when the endpoint refuses", async () => {
    const fetchFn = stubFetch({
      [`POST ${AUTH}/token`]: () => json({ error: "invalid_grant", error_description: "code abc123 expired" }, 400),
    });
    const failure = await exchangeCode(AUTH_SERVER, registration, {
      code: "abc123",
      verifier: "v",
      resource: SERVER,
      fetchFn,
    }).catch((e) => e);
    expect(failure).toBeInstanceOf(OAuthError);
    expect(failure.message).toContain("invalid_grant");
    expect(failure.message).not.toContain("abc123");
  });

  it("refuses a token type it cannot use", async () => {
    const fetchFn = stubFetch({ [`POST ${AUTH}/token`]: () => json({ access_token: "a", token_type: "MAC" }) });
    await expect(
      exchangeCode(AUTH_SERVER, registration, { code: "c", verifier: "v", resource: SERVER, fetchFn }),
    ).rejects.toThrow(/token type/);
  });

  it("keeps the old refresh token when the server does not rotate it", async () => {
    const fetchFn = stubFetch({
      [`POST ${AUTH}/token`]: () => json({ access_token: "access-2", token_type: "Bearer", expires_in: 60 }),
    });
    const tokens = await refreshTokens(AUTH_SERVER, registration, {
      previous: { refresh_token: "refresh-1" },
      resource: SERVER,
      fetchFn,
    });
    expect(tokens).toMatchObject({ access_token: "access-2", refresh_token: "refresh-1" });
    expect(Object.fromEntries(new URLSearchParams(fetchFn.calls.at(-1).init.body))).toMatchObject({
      grant_type: "refresh_token",
      refresh_token: "refresh-1",
    });
  });

  it("takes the new refresh token when the server rotates it", async () => {
    const fetchFn = stubFetch({
      [`POST ${AUTH}/token`]: () =>
        json({ access_token: "access-2", refresh_token: "refresh-2", token_type: "Bearer" }),
    });
    const tokens = await refreshTokens(AUTH_SERVER, registration, {
      previous: { refresh_token: "refresh-1" },
      resource: SERVER,
      fetchFn,
    });
    expect(tokens.refresh_token).toBe("refresh-2");
  });

  it("cannot refresh without a refresh token", async () => {
    await expect(refreshTokens(AUTH_SERVER, registration, { previous: {}, resource: SERVER })).rejects.toThrow(
      /no refresh token/,
    );
  });
});
