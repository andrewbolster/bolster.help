# Cutover to bolster.help

State of the migration from the package docs to this chat interface. Delete this
file once the domain has moved and the cleanup below is done.

## Live now

| What | Where |
| --- | --- |
| Site | `andrewbolster.github.io/bolster.help/` — redirects to `andrewbolster.info/bolster.help/` |
| API | `bolster-help.andrewbolster.workers.dev` |
| Preview | `bolster-help-5le.pages.dev` (Cloudflare Pages, kept as staging) |

The site is served by GitHub Pages from `web/`, the API by a Cloudflare Worker.
They are permanently different origins, which is the trade for leaving DNS at
DigitalOcean instead of moving the zone to Cloudflare.

The redirect to `andrewbolster.info` is not configuration of ours: the user
Pages site `andrewbolster/andrewbolster.github.io` has that custom domain, so
GitHub serves every project site under the account beneath it. It stops
mattering once `bolster.help` attaches.

## Cloudflare resources

| Resource | Id |
| --- | --- |
| KV `bolster-help-SESSIONS` | `7683a8d90ea6451bace7e2458cd8fe17` |
| D1 `bolster-help` | `81abb174-fba4-4181-9e6f-adef56df939f` |
| Workers subdomain | `andrewbolster.workers.dev` |

Deploy with `worker/deploy.sh`, not `wrangler deploy`: wrangler reads
`/accounts/{id}/workers/subdomain` before every deploy and the API token cannot
see that endpoint, which surfaces as a bare `Authentication error [code: 10000]`
that reads like a bad token rather than a missing scope. The script uploads the
script directly instead.

`MIGRATE=1` creates the Durable Object class and may be used once; replaying it
fails with `10074` because existing objects already depend on the class.

## Remaining steps

1. **Blocked — merge [`andrewbolster/bolster#2080`](https://github.com/andrewbolster/bolster/pull/2080)**, which deletes
   `CNAME` and `docs/CNAME` and releases the domain. Its required `build` checks
   fail on upstream data drift unrelated to the diff: the health-ni HSC
   workforce bulletin has dropped tables 7A/7B/7C, breaking six tests in
   `tests/test_health_ni_hsc_workforce_integrity.py`. Two of the three matrix
   jobs additionally hung on the download and were killed at the six-hour
   ceiling. `NISRA Feed Drift Detection` was already failing on `main` before
   this PR opened.
2. Re-run the `pages` workflow so `web/CNAME` claims the domain.
3. Confirm a full chat turn in a browser against `https://bolster.help`. Every
   part has been verified separately; the whole loop has not been driven through
   the DOM on the live domain.

## Cleanup owed

`ALLOWED_ORIGINS` on the Worker currently carries two entries that exist only
for this window and should be dropped once the domain attaches:

- `https://andrewbolster.info` — the redirect target above. Without it the
  browser rejects every API call with a bare `NetworkError`.
- `https://bolster-help-5le.pages.dev` — the Cloudflare preview.

Leaving:

```
https://bolster.help, https://www.bolster.help, http://localhost:5173
```

## Known gaps

**Signing in will not work** until the session cookie is issued as
`SameSite=None; Secure`. A `Lax` cookie does not travel cross-site, and the API
is on a different origin. Chatting is unaffected, since it uses no cookie. This
also needs a GitHub OAuth app and the two `GITHUB_*` secrets.

**Answers about motivation return encyclopedia copy** — "hackerspaces are
incubators for collaboration" — however the prompt is phrased. The model has
strong priors about the category and nothing real about why Bolster does it.
Fixing that needs material from tools, most obviously `get_recent_blog_posts`.

**`send_contact_message` is excluded from the proxy allowlist** as a write
side-effect that delivers mail to a real inbox. For an assistant standing in for
Bolster, "get in touch" is arguably a feature rather than a hazard.

**`display_output` reaches the reader but not the saving.** The model calls it
and the content renders, then it usually repeats the same content in its reply,
so the context it was meant to save is spent anyway. Wording, not plumbing.

**The assistant cannot describe its own tools.** Asked for a table of what it
can do, it reads "data sources" as something to fetch, spends every round on RSS
feeds and gives up. Whether that is the size of the tool list or a question it
will not introspect is untested.
