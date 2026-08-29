# bolster.help

A chat interface backed by [mcp.bolster.online](https://mcp.bolster.online). The
agent loop runs in the browser; the Worker exists for the MCP hop, inference,
and conversation storage.

## Where inference comes from

There is nothing to configure and nothing to bring. Every visitor, signed in or
not, gets `@cf/ibm-granite/granite-4.0-h-micro` on Cloudflare's free allocation
of 10,000 neurons a day. On the Workers Free plan that ceiling is enforced by
Cloudflare, so this cannot produce a bill — the same fail-closed posture as
leaving the account without a payment method.

An earlier design let visitors paste their own provider key. It was removed: it
asked people to hand a credential to someone else's website, which nobody
sensible does, in exchange for three engine code paths and a form standing
between the visitor and the chat.

Signing in adds one thing — somewhere to keep the conversation. No OAuth scopes
are requested and the GitHub token is discarded after the profile read. If the
account is named in `GITHUB_ALLOWED_LOGINS` and the `LLM_*` secrets are set,
`/llm` quietly uses those instead; there is no UI for it, and `/llm` re-decides
on every call.

The model was picked by measuring tool selection against the retrieval fixtures,
not by price. It scored 12/12 on the cases that matter — including the three
near-identical NISRA index tools — at ~1.2 neurons a round. The reasoning models
cost roughly ten times as much and chose worse: `glm-4.7-flash` managed 1/4,
spending 280 completion tokens to get there. A wrong tool is a wrong answer,
however little it cost.

`NeuronBudget`, a Durable Object, records what each reply actually cost from the
`usage.neurons` Workers AI reports, and the page draws a bar from it. It is a
Durable Object rather than KV for two reasons: KV is eventually consistent with
last-write-wins, so a read-modify-write counter silently loses updates, and the
free plan allows 1,000 KV writes a day — fewer than the questions a day of
neurons buys, so the meter would break before the tank emptied.

When the allocation runs out Workers AI answers `429` with internal code `3036`.
That is authoritative where our own tally is not, so it latches the budget and
stops issuing requests that cannot succeed until 00:00 UTC. `3040` shares the
same HTTP status but means *out of capacity* and is retried instead — branching
on the status alone would get one of the two wrong.

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

Steps 1 and 2 are optional: without them nobody can sign in, and chatting still
works for everyone on the free tier. Everything else is needed for a deployment.

Storage and the Pages project already exist on the account, and their ids are in
`wrangler.toml`.

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

The three `LLM_*` secrets are optional — leaving them unset means everyone,
including allowlisted accounts, uses the free tier. Set `GITHUB_ALLOWED_LOGINS`
in `wrangler.toml` to say who may spend them when they are set.

**3. Storage** — already created; the ids are in `wrangler.toml`. To rebuild it
from scratch:

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
