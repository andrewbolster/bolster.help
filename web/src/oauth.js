// The MCP authorization flow, run in the browser: discovery, dynamic client
// registration, authorization code with PKCE, token exchange and refresh.
// Nothing here is specific to one server; everything comes from its metadata.

export class OAuthError extends Error {}

const isLocal = (host) => host === "localhost" || host === "127.0.0.1";
const trimSlash = (value) => String(value).replace(/\/+$/, "");

// https only, except for a server on this machine. Credentials in a URL are
// never wanted.
export function requireSecureUrl(value, what) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new OAuthError(`${what} is not a URL`);
  }
  const secure = url.protocol === "https:" || (url.protocol === "http:" && isLocal(url.hostname));
  if (!secure) throw new OAuthError(`${what} must use https`);
  if (url.username || url.password) throw new OAuthError(`${what} must not contain credentials`);
  return url;
}

export function base64url(bytes) {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export const randomToken = (bytes = 32) => base64url(crypto.getRandomValues(new Uint8Array(bytes)));

export async function pkceChallenge(verifier) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

// A browser can only read this header if the server exposes it, so it is a
// hint: the well-known URLs below are the fallback.
export function resourceMetadataFrom(header) {
  return /resource_metadata="([^"]+)"/.exec(header ?? "")?.[1] ?? null;
}

async function getJson(url, fetchFn) {
  try {
    const response = await fetchFn(url, { headers: { accept: "application/json" } });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

async function firstJson(urls, fetchFn, accept) {
  for (const url of urls) {
    const body = await getJson(url, fetchFn);
    if (body && accept(body)) return body;
  }
  return null;
}

const MCP_INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "bolster.help", version: "0.1.0" },
  },
};

// Server URL in, everything needed to start signing in out. Throws OAuthError
// with a sentence a person can act on.
export async function discover(serverUrl, { fetchFn = fetch } = {}) {
  const server = requireSecureUrl(serverUrl, "the server URL");
  const path = trimSlash(server.pathname);

  let probe;
  try {
    probe = await fetchFn(server.href, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify(MCP_INITIALIZE),
    });
  } catch {
    throw new OAuthError("that server could not be reached from a web page (it may not allow cross-origin requests)");
  }
  if (probe.status !== 401) {
    throw new OAuthError(`that server did not ask for a login (HTTP ${probe.status})`);
  }

  const hinted = resourceMetadataFrom(probe.headers.get("www-authenticate"));
  const candidates = [
    ...(hinted ? [requireSecureUrl(hinted, "the resource metadata URL").href] : []),
    `${server.origin}/.well-known/oauth-protected-resource${path}`,
    `${server.origin}/.well-known/oauth-protected-resource`,
  ];
  const resourceMeta = await firstJson(candidates, fetchFn, (b) => Array.isArray(b.authorization_servers));
  if (!resourceMeta?.authorization_servers?.length) {
    throw new OAuthError("that server does not describe how to sign in (no protected resource metadata)");
  }
  if (!resourceMeta.resource || trimSlash(resourceMeta.resource) !== trimSlash(server.href)) {
    throw new OAuthError("the server's metadata names a different resource than the one you entered");
  }

  const issuer = requireSecureUrl(resourceMeta.authorization_servers[0], "the authorization server");
  const issuerPath = trimSlash(issuer.pathname);
  const asUrls = [
    `${issuer.origin}/.well-known/oauth-authorization-server${issuerPath}`,
    `${issuer.origin}/.well-known/openid-configuration${issuerPath}`,
    `${trimSlash(issuer.href)}/.well-known/openid-configuration`,
  ];
  const meta = await firstJson(asUrls, fetchFn, (b) => b.authorization_endpoint && b.token_endpoint);
  if (!meta) throw new OAuthError("the authorization server's metadata could not be found");
  if (!meta.issuer || trimSlash(meta.issuer) !== trimSlash(issuer.href)) {
    throw new OAuthError("the authorization server's metadata names a different issuer");
  }
  for (const field of ["authorization_endpoint", "token_endpoint", "registration_endpoint"]) {
    if (meta[field]) requireSecureUrl(meta[field], `the ${field.replace("_", " ")}`);
  }
  if (!meta.code_challenge_methods_supported?.includes("S256")) {
    throw new OAuthError("the authorization server does not support PKCE (S256)");
  }

  const scopes = resourceMeta.scopes_supported ?? meta.scopes_supported ?? [];
  return {
    server: server.href,
    origin: server.origin,
    resource: resourceMeta.resource,
    issuer: meta.issuer,
    meta: {
      issuer: meta.issuer,
      authorization_endpoint: meta.authorization_endpoint,
      token_endpoint: meta.token_endpoint,
      registration_endpoint: meta.registration_endpoint ?? null,
    },
    scopes,
  };
}

export async function register(meta, { redirectUri, clientName = "bolster.help", fetchFn = fetch }) {
  if (!meta.registration_endpoint) throw new OAuthError("that server does not offer dynamic client registration");
  let response;
  try {
    response = await fetchFn(meta.registration_endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        client_name: clientName,
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    });
  } catch {
    throw new OAuthError("client registration could not be reached from a web page");
  }
  if (!response.ok) throw new OAuthError(`client registration was refused (HTTP ${response.status})`);
  const data = await response.json().catch(() => ({}));
  if (!data.client_id) throw new OAuthError("client registration returned no client id");
  const authMethod = data.token_endpoint_auth_method ?? (data.client_secret ? "client_secret_post" : "none");
  return {
    client_id: data.client_id,
    ...(data.client_secret ? { client_secret: data.client_secret } : {}),
    auth_method: authMethod,
    redirect_uri: redirectUri,
  };
}

export function buildAuthorizeUrl({ meta, registration, resource, scope, state, challenge }) {
  const url = new URL(meta.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", registration.client_id);
  url.searchParams.set("redirect_uri", registration.redirect_uri);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("resource", resource);
  if (scope) url.searchParams.set("scope", scope);
  return url.toString();
}

function clientAuth(registration) {
  const params = { client_id: registration.client_id };
  const headers = {};
  if (registration.auth_method === "client_secret_basic" && registration.client_secret) {
    headers.authorization = `Basic ${btoa(`${registration.client_id}:${registration.client_secret}`)}`;
    delete params.client_id;
  } else if (registration.client_secret) {
    params.client_secret = registration.client_secret;
  }
  return { params, headers };
}

async function tokenRequest(meta, registration, params, { fetchFn, now }) {
  const auth = clientAuth(registration);
  let response;
  try {
    response = await fetchFn(meta.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", ...auth.headers },
      body: new URLSearchParams({ ...params, ...auth.params }).toString(),
    });
  } catch {
    throw new OAuthError("the token endpoint could not be reached from a web page");
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    // Only the error code is repeated: never anything that could carry a token.
    throw new OAuthError(
      `the token endpoint refused the request (${String(data.error ?? response.status).slice(0, 60)})`,
    );
  }
  if (String(data.token_type ?? "bearer").toLowerCase() !== "bearer") {
    throw new OAuthError("the token endpoint issued a token type this page cannot use");
  }
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token ?? null,
    scope: data.scope ?? null,
    expires_at: data.expires_in ? now() + Number(data.expires_in) * 1000 : null,
  };
}

export const exchangeCode = (meta, registration, { code, verifier, resource, fetchFn = fetch, now = Date.now }) =>
  tokenRequest(
    meta,
    registration,
    {
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: registration.redirect_uri,
      resource,
    },
    { fetchFn, now },
  );

// A server that rotates refresh tokens returns a new one; one that does not
// leaves the old one valid, so it is kept.
export async function refreshTokens(meta, registration, { previous, resource, fetchFn = fetch, now = Date.now }) {
  if (!previous?.refresh_token) throw new OAuthError("there is no refresh token to use");
  const fresh = await tokenRequest(
    meta,
    registration,
    { grant_type: "refresh_token", refresh_token: previous.refresh_token, resource },
    { fetchFn, now },
  );
  return { ...fresh, refresh_token: fresh.refresh_token ?? previous.refresh_token };
}
