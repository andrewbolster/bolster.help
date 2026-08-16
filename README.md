# bolster.help

A chat interface for the Northern Ireland open-data tools exposed by
[mcp.bolster.online](https://mcp.bolster.online). Inference, storage and the agent
loop all run in the browser. The Worker exists for two things only: the MCP hop,
and — for signed-in users — somewhere to keep a conversation.

Package documentation lives at [bolster.readthedocs.io](https://bolster.readthedocs.io) —
this site does not duplicate it.

## Inference tiers

| Tier | Needs | Where the model runs |
| --- | --- | --- |
| Local | WebGPU, ~4.5 GB download | In the tab, via WebLLM |
| BYOK | An OpenAI-compatible base URL and key | The provider the user names |

BYOK requests go from the browser straight to the provider. Relaying them through
the Worker would make it the custodian of the user's key and an open forwarder to
any URL they name — a worse trade than depending on the provider sending CORS
headers, which OpenAI, OpenRouter, Groq and LiteLLM all do.

Signing in is orthogonal to both: it buys conversation persistence and nothing
else. No OAuth scopes are requested and the GitHub token is discarded after the
profile read.

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
Nothing below is required for BYOK — a visitor supplies their own base URL and
key, and no tier needs an account to work.

**1. GitHub OAuth app** — register at
`github.com/settings/developers`. Homepage `https://bolster.help`, callback
`https://bolster.help/auth/github/callback`. Request no scopes; the app only
reads the public profile.

**2. Worker secrets**

```sh
cd worker
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
```

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
