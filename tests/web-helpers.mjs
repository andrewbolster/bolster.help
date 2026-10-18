// Stand-ins for the browser pieces the connections code depends on: storage and
// a fetch that answers from a table, so tests drive real code against canned
// servers and can see exactly what was sent.

export const SERVER = "https://mcp.example.com/mcp";
export const AUTH = "https://auth.example.com";
export const REDIRECT = "https://bolster.help/oauth/callback.html";

export const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

export function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
    dump: () => Object.fromEntries(data),
  };
}

export const PROTECTED_RESOURCE = {
  resource: SERVER,
  authorization_servers: [AUTH],
  scopes_supported: ["user"],
};

export const AUTH_SERVER = {
  issuer: AUTH,
  authorization_endpoint: `${AUTH}/authorize`,
  token_endpoint: `${AUTH}/token`,
  registration_endpoint: `${AUTH}/register`,
  code_challenge_methods_supported: ["S256"],
};

// A well-behaved server and authorization server, each route overridable.
// A handler receives (url, init) and returns a Response; a missing route is a 404.
export function stubFetch(overrides = {}) {
  const routes = {
    [`POST ${SERVER}`]: () => new Response(null, { status: 401 }),
    "GET https://mcp.example.com/.well-known/oauth-protected-resource/mcp": () => json(PROTECTED_RESOURCE),
    [`GET ${AUTH}/.well-known/oauth-authorization-server`]: () => json(AUTH_SERVER),
    [`POST ${AUTH}/register`]: () => json({ client_id: "client-1" }, 201),
    [`POST ${AUTH}/token`]: () =>
      json({ access_token: "access-1", refresh_token: "refresh-1", token_type: "Bearer", expires_in: 3600 }),
    ...overrides,
  };
  const calls = [];
  const fn = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    const method = init.method ?? "GET";
    calls.push({ method, url, init });
    const handler = routes[`${method} ${url}`];
    return handler ? handler(url, init) : new Response("not found", { status: 404 });
  };
  fn.calls = calls;
  return fn;
}
