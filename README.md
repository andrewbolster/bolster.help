# bolster.help

A chat interface for the Northern Ireland open-data tools exposed by
[mcp.bolster.online](https://mcp.bolster.online). Inference runs in the visitor's
browser via WebGPU; the only server-side component is a proxy.

Package documentation lives at [bolster.readthedocs.io](https://bolster.readthedocs.io) —
this site does not duplicate it.

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

The 36 tool schemas are ~21K tokens, which does not fit alongside a conversation
in a quantised 7–8B model. `web/src/retrieval.js` scores the user's message
against the catalogue and passes only the top few schemas per turn.

## Scripts

```sh
npm run refresh-tools     # re-snapshot tools/list into web/src/tools.json
npm run check-retrieval   # assert every fixture's tool ranks in the top 6
```

`check-retrieval` is a gate, not a metric: a tool that misses retrieval is never
shown to the model, so the failure is unrecoverable at runtime.

## Local development

```sh
cd worker && npx wrangler dev --port 8788 --local
```

The rate-limit binding is inert under `--local`; exercise it against a deployed
preview instead.
