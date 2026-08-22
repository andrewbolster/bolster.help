# bolster.help

A chat interface for the Northern Ireland open-data tools exposed by
[mcp.bolster.online](https://mcp.bolster.online). The agent loop runs in the
browser against an OpenAI-compatible endpoint. The Worker exists for the MCP hop,
conversation storage, and — for allowlisted accounts — inference on the
deployment's own key.

Package documentation lives at [bolster.readthedocs.io](https://bolster.readthedocs.io) —
this site does not duplicate it.

## Where the key comes from

| Path | Who supplies the key | Route |
| --- | --- | --- |
| Visitor's own | Base URL, key and model typed into the page | Browser straight to the provider |
| Deployment's | `LLM_*` Worker secrets | Browser → Worker `/llm` → provider |

A key the visitor typed never reaches the Worker. Relaying it would make the
Worker the custodian of someone else's key and an open forwarder to any URL they
name — a worse trade than depending on the provider sending CORS headers, which
OpenAI, OpenRouter, Groq and LiteLLM all do. The key lives in `sessionStorage`,
so it survives a reload but not closing the tab.

The deployment's key is the opposite case: a Worker secret cannot be handed to
the browser, so those calls have to be relayed. `/llm` is therefore a way to
spend someone else's money, and is gated twice — signed in, and named in
`GITHUB_ALLOWED_LOGINS`. It also pins the model server-side; letting the caller
name it invites picking the most expensive one on the key. `/me` reports whether
an account qualifies so the page knows which form to show, but that flag is a
hint: `/llm` re-checks on every call.

Signing in otherwise buys conversation persistence and nothing else. No OAuth
scopes are requested and the GitHub token is discarded after the profile read.

GitHub Copilot is **not** a tier. Its endpoints are browser-reachable — both
`api.githubcopilot.com/chat/completions` and the `copilot_internal/v2/token`
endpoint send permissive CORS — but the token endpoint gates on a
`Copilot-Integration-Id` header, issued only to OAuth apps on GitHub's editor
integration allowlist. A generic app gets identity and no entitlement, whatever
the user's subscription.

## Layout

```
web/       static frontend (Cloudflare Pages)
worker/    Cloudflare Worker: MCP proxy, auth, chat persistence
scripts/   maintenance and verification scripts
```

## Why the proxy is mandatory

`mcp.bolster.online` sends no CORS headers — `OPTIONS /mcp` answers 405 — so a
browser cannot reach it directly. The Worker is also where the tool allowlist and
rate limiting live; the origin itself stays open and unauthenticated, so anything
bypassing the proxy reaches it unfiltered.

## Why tools are retrieved rather than sent wholesale

All 36 tool schemas measure ~6900 tokens, which crowds out the conversation in a
quantised 7–8B model. `web/src/retrieval.js` scores the user's message against
the catalogue and passes only the top six schemas per turn — ~1100 tokens mean,
~1750 worst case.

## Scripts

```sh
npm run refresh-tools     # re-snapshot tools/list into web/src/tools.json
npm run check-retrieval   # assert every fixture's tool ranks in the top 6
npm run check-agent       # agent loop behaviour and tool payload size
```

`check-retrieval` is a gate, not a metric: a tool that misses retrieval is never
shown to the model, so the failure is unrecoverable at runtime.

## Local development

```sh
cd worker && npx wrangler dev --port 8788 --local
```

The rate-limit binding is inert under `--local`; exercise it against a deployed
preview instead. Session cookies will not flow between the static server on 5173
and wrangler on 8788 under `SameSite=Lax`, so auth is only testable once both
sit behind one origin — which they do in production.

## Setup that needs account access

None of this can be done from the repo; it all needs Andrew's own credentials.
None of it is required for a visitor bringing their own base URL and key — that
path works without an account.

**1. GitHub OAuth app** — register at
`github.com/settings/developers`. Homepage `https://bolster.help`, callback
`https://bolster.help/auth/github/callback`. Request no scopes; the app only
reads the public profile.

**2. Worker secrets**

```sh
cd worker
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put LLM_BASE_URL
npx wrangler secret put LLM_API_KEY
npx wrangler secret put LLM_MODEL
```

The three `LLM_*` secrets are optional — leaving them unset disables `/llm`
entirely, and everyone brings their own key. Set `GITHUB_ALLOWED_LOGINS` in
`wrangler.toml` to say who may spend them.

**3. Storage** — create both, then replace the two `REPLACE_WITH_*` placeholders
in `wrangler.toml` with the ids they print.

```sh
npx wrangler kv namespace create SESSIONS
npx wrangler d1 create bolster-help
npx wrangler d1 execute bolster-help --file=schema.sql --remote
```

**4. Pages project** — create it against this repo with `web/` as the output
directory, verify on the `*.pages.dev` URL, then add `bolster.help` as a custom
domain and wait for the cert.

**5. Worker route** — bind the Worker to `bolster.help/mcp-proxy`,
`bolster.help/auth/*`, `bolster.help/me` and `bolster.help/chats*`. The frontend
assumes these are same-origin in production; that is what avoids a preflight on
every MCP call and lets the session cookie flow.

**6. Release the domain from GitHub Pages** — delete both `CNAME` and
`docs/CNAME` from `andrewbolster/bolster` and disable Pages on that repo, or it
will contend for `bolster.help`.

**7. DNS at DigitalOcean** — replace the four GitHub Pages A records for
`bolster.help` with a CNAME to the Pages project. Nameservers stay put.

**8. Leave the Cloudflare account without a payment method.** On the Free plan
Cloudflare fails closed past the limits rather than billing, which is the
behaviour we want while cost sensitivity is the priority.

Verify the cutover with `curl -I https://bolster.help` — it should report
Cloudflare rather than `server: GitHub.com`.
