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

The model was picked by measuring tool selection against the question fixtures,
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

## Conversations

Conversations are kept in `localStorage` and go nowhere else. That is what an
unauthenticated visitor gets by default, and it means the sidebar works before
anyone signs in rather than being a reward for it. They can be renamed, deleted
and exported as Markdown or JSON, with the tool calls and their output either
included or left out — the same fold the transcript uses, because a transcript
to send someone and a transcript to debug an answer want different things.

A conversation is titled by its opening question from the first turn. After
three turns the model is asked for a summary of at most 30 characters, and if it
obliges, that replaces it. A title someone typed is never replaced by either.
The model call is best-effort: no capacity, a refusal, or a reply that is
plainly not a title all leave the opening question in place, and nothing
surfaces to the visitor, because nothing they care about has failed.

## Limits, and which of them are real

Numbers that bound a request are easy to add and hard to notice once they are
wrong, so the ones that remain each say what they protect:

| Limit | What it is for |
| --- | --- |
| `MAX_BODY_BYTES` (1MB) | Rejects before `JSON.parse`, which is the cheapest way to spend a Worker's CPU budget. Sized above a full context window so the model's limit binds first. |
| `MAX_CONTENT_CHARS` (400K) | Granite's context is 131K tokens. Rejecting here means the page can say "this conversation got too long" instead of reporting it as an unexplained failure. |
| `MAX_SHARED_OUTPUT_TOKENS` | Arbitrary, and stays arbitrary: it is the only thing between a long answer and a real credit card. Matched to the free tier so an allowlisted account is not given shorter answers than a visitor. |
| `MAX_ROUNDS` (32) | Not a budget — a stop. A model that wants to work through a dozen tools should be left to. |
| `MAX_OBJECTS` (64) | How many tool outputs the store keeps. Handles are strings in a browser tab. |

There is deliberately no cap on message *count*. A message is not a unit of
cost: a tool-calling turn produces one assistant message and one result message
per call, so an agent working through a problem legitimately sends dozens. An
earlier cap of 24 silently held the loop to eleven rounds regardless of
`MAX_ROUNDS`, which from the browser looked like the model giving up.

## Layout

```
web/       static frontend (Cloudflare Pages)
worker/    Cloudflare Worker: MCP proxy, auth, chat persistence
scripts/   maintenance and verification scripts
```

## Why the proxy is mandatory

`mcp.bolster.online` sends no CORS headers — `OPTIONS /mcp` answers 405 — so a
browser cannot reach it directly. The Worker is also where the tool allowlist
lives; the origin itself stays open and unauthenticated, so anything bypassing
the proxy reaches it unfiltered.

A Cloudflare Rate Limiting binding sat here once, on both `/mcp-proxy` and
`/llm`. It was removed after testing the deployed Worker directly showed it
never refused a request — bursts well past its configured threshold all came
back 200. A guardrail that fails open and silent is worse than none: it reads
as protection in the code without providing any, and it was more misleading
to leave wired up than to cut. The MCP origin is responsible for its own rate
limiting; nothing in this repo currently limits by IP.

## Every tool is sent every turn

All 36 schemas with their full descriptions measure ~19K tokens against a
131K-token context, so there is nothing to save by trimming them.

An earlier design scored the message against the catalogue and sent only the
top six, with descriptions cut to their first paragraph. That was necessary
when the plan was a quantised 7-8B model running in the browser. Against the
current model it bought a little context and cost two things worth more: the
assistant could not say what it was able to do, having never seen thirty of its
own tools, and a tool ranked seventh was unreachable for that turn however well
it fitted.

`web/src/fixtures.json` remains as a corpus of worked question/tool pairs.

## Tests

```sh
npm test                  # everything that runs without configuration
npm run test:network      # adds the checks that reach mcp.bolster.online
npm run refresh-tools     # re-snapshot tools/list into web/src/tools.json
```

Vitest, in three projects. `unit` is plain Node — the agent loop, the output
store, conversation storage, catalogue integrity. `dom` runs the page against
happy-dom, because the sidebar is DOM code and testing the store underneath it
proves nothing about whether clicking Delete deletes the right row. `worker`
runs inside workerd through Cloudflare's own plugin, so KV and the
`NeuronBudget` Durable Object are real rather than stood in for. That matters
most for the budget: it exists because KV cannot hold a counter safely, and a
hand-written fake would assert the consistency we wanted instead of the one
workerd gives us.

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
| `CHECK_DEPLOYED=<url>` | same-origin cookies |
| `LLM_BASE_URL` + `LLM_API_KEY` | a real completion through the shared key |

A skipped test reports why, so a green run says which assumptions went
unchecked instead of implying they passed. Two cases are marked `todo` rather
than skipped: no environment variable makes them run, because driving them
needs a human at a browser to mint a session.

Three assertions are load-bearing rather than incidental:

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

Session cookies will not flow between the static server on 5173 and wrangler on
8788 under `SameSite=Lax`, so auth is only testable once both sit behind one
origin — which they do in production.

## Deploying

`.github/workflows/worker.yml` deploys `worker/` on every push to `main` that
touches it, gated on the same test suite this README describes above. Nothing
else is needed for a routine code change to go live.

For an emergency or out-of-band deploy:

```sh
cd worker
CLOUDFLARE_API_TOKEN=... npx wrangler deploy
```

`wrangler deploy` reads `wrangler.toml` directly — there is no separate
binding list to keep in step with it, and no migration flag to remember:
Cloudflare tracks which Durable Object migration tags a script has already
applied, so the `[[migrations]]` block in `wrangler.toml` is safe to leave in
place and redeploy against indefinitely.

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
