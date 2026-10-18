// Connected MCP servers: what this browser has registered with, and the tokens
// it holds. Everything lives in this browser and is never sent to the Worker.
//
// A token is attached only to requests for the origin it was issued for, and a
// redirect is refused rather than followed with it.

import {
  buildAuthorizeUrl,
  discover,
  exchangeCode,
  OAuthError,
  pkceChallenge,
  randomToken,
  refreshTokens,
  register,
} from "./oauth.js";

export const STORE_KEY = "bolster.help/mcp-connections";
export const PENDING_KEY = "bolster.help/mcp-pending";

// Refresh a little early so a token does not expire mid-request.
const REFRESH_MARGIN_MS = 60_000;

export class NeedsReconnect extends Error {
  constructor(origin) {
    super(`${origin} needs you to sign in again`);
    this.origin = origin;
  }
}

const trimSlash = (value) => String(value).replace(/\/+$/, "");

function hash(text) {
  let h = 0x811c9dc5;
  for (const char of text) h = Math.imul(h ^ char.charCodeAt(0), 0x01000193);
  return (h >>> 0).toString(36).slice(0, 5);
}

// A short, stable id: it becomes the prefix of every tool this server adds.
export function serverId(url) {
  const parsed = new URL(url);
  const host = parsed.hostname
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return `${host}-${hash(parsed.origin + trimSlash(parsed.pathname))}`;
}

// What the page may see of a connection: never a token or a client secret.
const view = ({ id, url, origin, status, issuer }) => ({ id, url, origin, status, issuer });

export function createConnections({
  redirectUri,
  storage = localStorage,
  session = sessionStorage,
  fetchFn = (...args) => fetch(...args),
  now = Date.now,
  navigate = (url) => location.assign(url),
  here = () => location.href,
}) {
  const read = () => {
    try {
      return JSON.parse(storage.getItem(STORE_KEY) ?? "{}");
    } catch {
      return {};
    }
  };
  const write = (records) => storage.setItem(STORE_KEY, JSON.stringify(records));
  const update = (id, change) => {
    const records = read();
    if (records[id]) write({ ...records, [id]: { ...records[id], ...change } });
  };
  const refreshing = new Map();

  const list = () => Object.values(read()).map(view);

  // Discovery first, so the page can say where you are about to be sent before
  // anything leaves the page.
  async function prepare(url) {
    const found = await discover(url, { fetchFn });
    return { ...found, authorizationOrigin: new URL(found.meta.authorization_endpoint).origin };
  }

  async function authorize(prepared, { returnTo = here() } = {}) {
    const id = serverId(prepared.server);
    const existing = read()[id];
    const reusable =
      existing?.registration?.redirect_uri === redirectUri && existing?.meta?.issuer === prepared.meta.issuer;
    const registration = reusable ? existing.registration : await register(prepared.meta, { redirectUri, fetchFn });

    const verifier = randomToken(32);
    const state = randomToken(16);
    const challenge = await pkceChallenge(verifier);

    write({
      ...read(),
      [id]: {
        id,
        url: prepared.server,
        origin: prepared.origin,
        resource: prepared.resource,
        issuer: prepared.issuer,
        meta: prepared.meta,
        registration,
        tokens: existing?.tokens ?? null,
        status: existing?.tokens ? existing.status : "pending",
      },
    });
    session.setItem(PENDING_KEY, JSON.stringify({ id, state, verifier, returnTo }));

    navigate(
      buildAuthorizeUrl({
        meta: prepared.meta,
        registration,
        resource: prepared.resource,
        scope: prepared.scopes.join(" "),
        state,
        challenge,
      }),
    );
  }

  // The callback page: verify the redirect, trade the code for tokens, and say
  // where to go next. The pending sign-in is single use.
  async function complete(search) {
    const params = new URLSearchParams(search);
    const pending = JSON.parse(session.getItem(PENDING_KEY) ?? "null");
    session.removeItem(PENDING_KEY);
    if (!pending) throw new OAuthError("no sign-in is in progress");
    if (params.get("error")) throw new OAuthError(`the server refused the login (${params.get("error").slice(0, 60)})`);
    if (params.get("state") !== pending.state) throw new OAuthError("the login response did not match the request");

    const record = read()[pending.id];
    if (!record) throw new OAuthError("that server is no longer registered");
    // RFC 9207: a response from some other authorization server is refused.
    if (params.has("iss") && trimSlash(params.get("iss")) !== trimSlash(record.issuer)) {
      throw new OAuthError("the login response came from a different authorization server");
    }
    const code = params.get("code");
    if (!code) throw new OAuthError("the login response had no code");

    const tokens = await exchangeCode(record.meta, record.registration, {
      code,
      verifier: pending.verifier,
      resource: record.resource,
      fetchFn,
      now,
    });
    update(pending.id, { tokens, status: "connected" });
    return pending.returnTo;
  }

  function markNeedsReconnect(id) {
    update(id, { status: "needs-reconnect" });
  }

  function refresh(id) {
    if (refreshing.has(id)) return refreshing.get(id);
    const record = read()[id];
    if (!record) throw new NeedsReconnect(id);
    const work = (async () => {
      try {
        const tokens = await refreshTokens(record.meta, record.registration, {
          previous: record.tokens,
          resource: record.resource,
          fetchFn,
          now,
        });
        update(id, { tokens, status: "connected" });
        return tokens;
      } catch {
        markNeedsReconnect(id);
        throw new NeedsReconnect(record.origin);
      } finally {
        refreshing.delete(id);
      }
    })();
    refreshing.set(id, work);
    return work;
  }

  async function accessToken(id) {
    const record = read()[id];
    if (!record?.tokens || record.status === "needs-reconnect") throw new NeedsReconnect(record?.origin ?? id);
    const { expires_at: expiresAt } = record.tokens;
    if (expiresAt && now() > expiresAt - REFRESH_MARGIN_MS) return (await refresh(id)).access_token;
    return record.tokens.access_token;
  }

  // A fetch for one server, and only that server. It adds the token, refuses
  // any other origin, never follows a redirect, and on a 401 refreshes once.
  function fetchFor(id) {
    const record = read()[id];
    if (!record) throw new OAuthError("that server is not connected");
    const send = async (input, init, token) => {
      const target = new URL(typeof input === "string" ? input : input.url);
      if (target.origin !== record.origin) throw new OAuthError("a token is only sent to the server it was issued for");
      const response = await fetchFn(target.href, {
        ...init,
        headers: { ...(init?.headers ?? {}), authorization: `Bearer ${token}` },
        redirect: "manual",
      });
      if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
        throw new OAuthError("the server redirected the request; a token is not sent along a redirect");
      }
      return response;
    };

    return async (input, init = {}) => {
      const first = await send(input, init, await accessToken(id));
      if (first.status !== 401) return first;
      const retried = await send(input, init, (await refresh(id)).access_token);
      if (retried.status === 401) {
        markNeedsReconnect(id);
        throw new NeedsReconnect(record.origin);
      }
      return retried;
    };
  }

  const disconnect = (id) => {
    const { [id]: _gone, ...rest } = read();
    write(rest);
  };

  const clearAll = () => {
    storage.removeItem(STORE_KEY);
    session.removeItem(PENDING_KEY);
  };

  return { list, prepare, authorize, complete, fetchFor, disconnect, clearAll, markNeedsReconnect };
}
