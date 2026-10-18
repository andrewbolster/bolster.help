// The one rule for any URL a user can make the Worker call: a public HTTPS DNS
// name on port 443, fetched without following redirects, with a deadline and a
// response size cap. Applied on save, when listing models and on every relay.
//
// A name that resolves to a private address cannot be caught here, because a
// Worker cannot resolve DNS itself; its egress is not on a private network,
// which is what makes this acceptable.

export class UrlError extends Error {}

const BLOCKED = ["localhost", "local", "internal", "workers.dev", "pages.dev"];

function publicName(host) {
  if (!host || host.includes(":") || host.startsWith("[")) return false; // IPv6 literal
  const labels = host.split(".");
  if (labels.length < 2) return false;
  const tld = labels.at(-1);
  if (/^(0x[0-9a-f]*|\d+)$/i.test(tld)) return false; // any spelling of an IPv4 address
  if (!/^([a-z]{2,63}|xn--[a-z0-9-]{1,59})$/.test(tld)) return false;
  if (!labels.every((l) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(l))) return false;
  return !BLOCKED.some((b) => host === b || host.endsWith(`.${b}`));
}

// Returns the normalised base URL (no trailing slash), or throws UrlError.
export function parseBaseUrl(input) {
  if (typeof input !== "string" || input.length > 2048) throw new UrlError("base_url must be a URL");
  let url;
  try {
    url = new URL(input.trim());
  } catch {
    throw new UrlError("base_url must be a URL");
  }
  if (url.protocol !== "https:") throw new UrlError("base_url must use https");
  if (url.username || url.password) throw new UrlError("base_url must not contain credentials");
  if (url.port) throw new UrlError("base_url must use the default https port");
  if (url.search || url.hash) throw new UrlError("base_url must not have a query or fragment");
  const host = url.hostname.replace(/\.$/, "").toLowerCase();
  if (!publicName(host)) throw new UrlError("base_url must be a public DNS name");
  return `https://${host}${url.pathname.replace(/\/+$/, "")}`;
}

export async function safeFetch(url, init, { timeoutMs = 15_000 } = {}) {
  const response = await fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
  if (response.status >= 300 && response.status < 400) throw new UrlError("provider redirected, which is not followed");
  return response;
}

export async function readCapped(response, maxBytes) {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new UrlError("provider response too large");
    }
    chunks.push(value);
  }
  return new Blob(chunks).text();
}
