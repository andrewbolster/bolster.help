// The Worker session, held as a bearer token.
//
// The page (bolster.help) and the API (a workers.dev Worker) are different
// sites, and browsers that block third-party cookies would silently drop a
// session cookie. So the sign-in redirect hands back a single-use code in the
// URL fragment, the page trades it for a token, and every API call carries it as
// `Authorization: Bearer`. The token sits in localStorage: a script injected
// into this page could read it, the same exposure connected-server tokens
// already have (see README "Connections"). It is sent only to the Worker, never
// to a connected server.

const KEY = "bolster.help/session";

export const getToken = () => {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
};

export const clearToken = () => {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Storage unavailable: there is nothing stored to clear.
  }
};

const setToken = (token) => {
  try {
    localStorage.setItem(KEY, token);
    return true;
  } catch {
    return false;
  }
};

export function authHeader() {
  const token = getToken();
  return token ? { authorization: `Bearer ${token}` } : {};
}

// A fetch to the Worker that carries the session, if there is one.
export const apiFetch = (url, init = {}, fetchFn = fetch) =>
  fetchFn(url, { ...init, headers: { ...authHeader(), ...init.headers } });

// Run once at load. If the page was reached from the sign-in redirect, trade the
// code in the fragment for a token, then strip the fragment either way so it is
// not left in the address bar or history.
export async function claimLoginCode({ apiOrigin, fetchFn = fetch, loc = location, hist = history } = {}) {
  const code = new URLSearchParams(loc.hash.slice(1)).get("code");
  if (!code) return false;
  hist.replaceState(null, "", loc.pathname + loc.search);
  try {
    const response = await fetchFn(`${apiOrigin}/auth/session`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-bolster-csrf": "1" },
      body: JSON.stringify({ code }),
    });
    if (!response.ok) return false;
    const { token } = await response.json();
    return typeof token === "string" && setToken(token);
  } catch {
    return false;
  }
}
