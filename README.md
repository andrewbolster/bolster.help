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
| Free tier | Cloudflare's daily Workers AI allocation | Browser → Worker `/llm` → `env.AI` |
| Visitor's own | Base URL, key and model typed into the page | Browser straight to the provider |
| Deployment's | `LLM_*` Worker secrets | Browser → Worker `/llm` → provider |

Anyone can ask a question without signing in or bringing a key: the Worker runs
`@cf/ibm-granite/granite-4.0-h-micro` on Cloudflare's free allocation of 10,000
neurons a day. On the Workers Free plan that ceiling is enforced by Cloudflare,
so the free tier cannot produce a bill — the same fail-closed posture as leaving
the account without a payment method.

The model was picked by measuring tool selection against the retrieval fixtures,
not by price. It scored 12/12 on the cases that matter — including the three
near-identical NISRA index tools — at ~1.2 neurons a round. The reasoning models
cost roughly ten times as much and chose worse: `glm-4.7-flash` managed 1/4,
spending 280 completion tokens to get there. A wrong tool is a wrong answer,
however little it cost.

`NeuronBudget`, a Durable Object, records what each reply actually cost from the
`usage.neurons` Workers AI reports, and the page draws a bar from it. The
counter is a Durable Object rather than KV for two reasons: KV is eventually
consistent with last-write-wins, so a read-modify-write counter silently loses
updates, and the free plan allows 1,000 KV writes a day — fewer than the
questions a day of neurons buys, so the meter would break before the tank
emptied.

When the allocation runs out Workers AI answers `429` with internal code `3036`.
That is authoritative where our own tally is not, so it latches the budget and
stops issuing requests that cannot succeed until 00:00 UTC. `3040` shares the
same HTTP status but means *out of capacity* and is retried instead — branching
on the status alone would get one of the two wrong.

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

## Tests

```sh
npm test                  # everything that runs without configuration
npm run test:network      # adds the checks that reach mcp.bolster.online
npm run refresh-tools     # re-snapshot tools/list into web/src/tools.json
```

Vitest, in two projects. `unit` is plain Node — retrieval scoring, the agent
loop, catalogue integrity. `worker` runs inside workerd through Cloudflare's
own plugin, so KV and the `NeuronBudget` Durable Object are real rather than
stood in for. That matters most for the budget: it exists because KV cannot
hold a counter safely, and a hand-written fake would assert the consistency we
wanted instead of the one workerd gives us.

`worker/wrangler.test.toml` is the production config minus the bindings with no
local simulator. Workers AI is the reason it exists at all: a config declaring
`[ai]` sends the plugin into a remote proxy session that demands
`CLOUDFLARE_API_TOKEN`, which would make the suite unrunnable without
credentials. `tests/unit/config.test.mjs` asserts the two files still agree on
everything they share, so the omissions stay deliberate.

The scripts set `WS_NO_BUFFER_UTIL=1`. Miniflare's websocket library optionally
loads a native `bufferutil`, resolved by walking up the directory tree — so a
stale copy in any parent directory gets picked up, and an old enough one exports
a different API, which crashes the socket on the first masked frame. The
acceleration buys nothing here.

The line the suite draws is the first outbound `fetch`. Routing, CORS, the
allowlists, body caps and the tier gate all resolve before one, so they are pure
functions of the request and the env and run offline. Anything past that
boundary needs a deployment, OAuth credentials or a provider key, and is skipped
with the reason attached rather than faked:

| Gate | Unlocks |
| --- | --- |
| `CHECK_NETWORK=1` | the origin sends no CORS headers; `tools.json` matches upstream |
| `CHECK_DEPLOYED=<url>` | rate limiting actually enforcing; same-origin cookies |
| `LLM_BASE_URL` + `LLM_API_KEY` | a real completion through the shared key |

A skipped test reports why, so a green run says which assumptions went
unchecked instead of implying they passed. Two cases are marked `todo` rather
than skipped: no environment variable makes them run, because driving them
needs a human at a browser to mint a session.

Three assertions are load-bearing rather than incidental:

- **Retrieval is a gate, not a metric.** The agent sends the top six schemas and
  nothing else, so a tool ranked seventh is invisible to the model that turn and
  no prompting recovers it. `recall@6` must be total.
- **Every allowlisted tool has a fixture.** Otherwise it is a tool nobody has
  checked is reachable by any phrasing at all.
- **`bolster_get_precipitation` and `send_contact_message` stay excluded**, by
  name — one spends a metered third-party key per call, the other delivers mail
  to a real inbox. The test fails if either is quietly added back.

`tools.json` is a manual snapshot and the allowlist is hand-written against it,
so nothing keeps them in step automatically. The network checks run weekly in CI
for that reason; drift there is silent at runtime.

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
