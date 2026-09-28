# bolster.help

A chat UI for asking questions about Northern Ireland open data. The agent loop runs **in the browser**; a Cloudflare Worker proxies the MCP server ([mcp.bolster.online](https://github.com/andrewbolster/mcp.bolster.online)), brokers inference, handles sign-in and persists chats. README.md explains the *why* (inference tiers, limits, the proxy, tool cost); this file is the short list of things to know before changing code.

## Layout

```
web/                 static frontend, served as-is by GitHub Pages (no build step)
  index.html, styles.css
  src/app.js         page wiring, sidebar, send loop, /usage
  src/agent.js       the agent loop (tool-call rounds)
  src/mcp.js         MCP client through the Worker proxy
  src/catalogue.js   tool catalogue + full_tool_documentation (incl. the `assistant` alias)
  src/persona.js     system prompt
  src/markdown.js    renderMarkdown (hand-rolled; see invariants)
  src/mermaid.js     diagram upgrade (the one exception; see invariants)
  src/config.js      API_ORIGIN / PROXY_ENDPOINT
  src/tools.json     manual snapshot of the server's tools/list
  src/fixtures.json  one fixture per allowlisted tool
worker/              Cloudflare Worker: index.js (routes), auth.js, chats.js, llm.js,
                     workers-ai.js, budget.js (NeuronBudget Durable Object), allowlist.js
scripts/             refresh-tools.mjs
tests/               vitest: unit (Node), dom (happy-dom), worker (workerd)
```

## Commands

```bash
npm test                # unit + dom + worker projects; needs no credentials
npm run test:network    # adds checks that reach mcp.bolster.online (weekly in CI)
npm run lint            # biome
npm run refresh-tools   # re-snapshot tools/list into web/src/tools.json
cd worker && npx wrangler dev --port 8788 --local
```

Skipped tests state why they were skipped. A green run says which assumptions went unchecked; don't replace a skip with a fake.

## Invariants (each was learned the hard way)

- **No build step for `web/`.** Plain ES modules served directly. Don't add a bundler or a transpile-only syntax; a runtime dependency must come from a pinned CDN ESM import.
- **Model output never reaches `innerHTML`.** `renderMarkdown` builds DOM nodes. The single, deliberate exception is `mermaid.js`: Mermaid's `render()` output is parsed with `DOMParser` into a detached document and imported (still never `innerHTML` on the live page), with `securityLevel: "strict"`, and the library is pinned to a major (`mermaid@11`). Input is public, anonymous and unmoderated, so keep it that way.
- **Cross-origin fetches need `credentials: "include"`.** The page (`bolster.help`) and the API (a `workers.dev` Worker) are always different origins. Anything that should see the session (`/usage`, chats, auth) must set it, and the session cookie is issued `SameSite=None; Secure`. Chatting itself uses no cookie. Locally, cookies won't flow between ports 5173 and 8788, so auth is only testable behind one origin.
- **`/usage` returns the resolved model.** The UI and the assistant's self-description read the model from it; don't hard-code a model name in the page.
- **`full_tool_documentation` has an `assistant` alias, and deliberately not `bolster`.** The model asks for docs about itself under that name; `bolster` is ambiguous (package vs. server vs. site).
- **Every tool is sent every turn.** Adding or renaming a tool raises the cost of every request; check README's "Every tool is sent every turn" before growing the catalogue.
- **`tools.json` and the allowlist are hand-maintained and can drift silently.** Change a server tool, run `npm run refresh-tools`, then update the allowlist and its fixture. Every allowlisted tool needs a fixture. `bolster_get_precipitation` (metered third-party key) and `send_contact_message` (delivers real mail) stay excluded by name; a test enforces it.
- **`MCP_ORIGIN` is used verbatim as the upstream URL.** Keep the form in `wrangler.toml` (with its trailing slash).
- **Durable Object is declared with `exports`, not `[[migrations]]`.** See README "Deploying" for the failure that led to this; don't "tidy" it.
- **`worker/wrangler.test.toml` is production config minus bindings with no local simulator** (Workers AI would demand an API token). `tests/unit/config.test.mjs` keeps the two in step.
- **Module-level caches outlive a test.** DOM tests that touch modules with module-level state (e.g. the Mermaid promise) must use sources/fixtures that don't depend on prior tests.

## Git and releases

Never commit to `main`; use a branch and a PR. Use `gh pr update-branch` to bring a PR up to date rather than rebasing or force-pushing. Stage specific files. Pushes to `main` that touch `worker/` deploy the Worker after the test suite passes (`.github/workflows/worker.yml`); the frontend deploys through `pages.yml`.
