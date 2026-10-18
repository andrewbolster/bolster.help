# Changelog

## [0.1.14] - 2026-10-18

- Sign in with a bearer token instead of a cookie (#40)


## [0.1.13] - 2026-10-18

- Let signed-in visitors connect to other MCP servers over OAuth (#38)


## [0.1.12] - 2026-10-18

- Let allowlisted logins use a model of their own; add Sign out (#37)


## [0.1.11] - 2026-10-18

- Upload the OAuth secrets after the deploy, not before (#35)


## [0.1.10] - 2026-10-18

- Deploy the GitHub OAuth secrets with the Worker; fix the callback docs (#34)


## [0.1.9] - 2026-09-29

- docs: add AGENTS.md with load-bearing invariants; CLAUDE.md as signpost (#33)


## [0.1.8] - 2026-09-14

- feat: model self-awareness, assistant self-documentation, Mermaid diagrams (#32)


## [0.1.7] - 2026-09-12

- fix: session cookie needs SameSite=None for cross-site auth (#30)


## [0.1.6] - 2026-09-09

- fix: repair upstream-drift check and make the allowlist auto-derived (#29)


## [0.1.5] - 2026-09-04

- fix: notification-shadowing, one-shot tool-calling, and persona/UI polish (#28)


## [0.1.4] - 2026-09-03

- fix: MCP_ORIGIN needs a trailing slash after the /auth/mcp Mount refactor (#26)


## [0.1.3] - 2026-09-01

- ci: add Biome + pre-commit + gitleaks — first lint tooling in this repo


## [0.1.2] - 2026-09-01

- feat: multi-line composer input + cancel an in-flight turn (#24)


## [0.1.1] - 2026-08-31

- feat: auto-bump patch version and changelog on every push to main (#23)


## [0.1.0] - 2026-08-31

Version tracking begins here. Every push to `main` from this point bumps the
patch version and adds an entry below — see `.github/workflows/release.yml`.
