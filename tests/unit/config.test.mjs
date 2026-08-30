// wrangler.test.toml exists only because Workers AI has no local simulator, so
// a config declaring `[ai]` forces the Vitest plugin into a remote proxy
// session that needs CLOUDFLARE_API_TOKEN. Everything else it omits should be
// omitted for a stated reason, and everything it keeps should match production.
//
// Two configs is a drift hazard — the same shape as tools.json against the
// allowlist — so the agreement is asserted rather than assumed.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (name) => readFileSync(join(root, "worker", name), "utf8");

// Comments are stripped before any presence check: both files discuss the
// bindings they omit, and a substring search would match the prose explaining
// the omission rather than a declaration making it.
const declarations = (source) =>
  source
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");

const live = declarations(read("wrangler.toml"));
const test = declarations(read("wrangler.test.toml"));

// Enough TOML for the handful of keys that matter here.
const value = (source, key) => source.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, "m"))?.[1];
const list = (source, key) => source.match(new RegExp(`^\\s*${key}\\s*=\\s*\\[([^\\]]*)\\]`, "m"))?.[1];

// Deliberately absent from the test config, each for a reason worth restating.
const OMITTED = {
  "[ai]": "no local simulator; declaring it forces a remote proxy session",
  "[[d1_databases]]": "no useful local behaviour for what these tests cover",
};

describe("wrangler configs", () => {
  it("agree on the Durable Object the tests exercise", () => {
    expect(value(test, "class_name")).toBe(value(live, "class_name"));
    expect(value(test, "name")).not.toBe(value(live, "name")); // the worker name may differ
    expect(live).toMatch(/name = "NEURON_BUDGET"/);
    expect(test).toMatch(/name = "NEURON_BUDGET"/);
  });

  // Free-plan Durable Objects must be SQLite-backed, and the counter's storage
  // is SQL — a key-value migration would fail at deploy, not in tests.
  it("agree the Durable Object is SQLite-backed", () => {
    for (const source of [live, test]) {
      expect(list(source, "new_sqlite_classes")).toMatch(/NeuronBudget/);
    }
  });

  it("agree on the entrypoint and compatibility date", () => {
    for (const key of ["main", "compatibility_date"]) {
      expect(value(test, key)).toBe(value(live, key));
    }
  });

  it("agree on the model pinned for the free tier", () => {
    expect(value(test, "WORKERS_AI_MODEL")).toBe(value(live, "WORKERS_AI_MODEL"));
  });

  it("omits only what cannot run locally", () => {
    for (const [marker, why] of Object.entries(OMITTED)) {
      expect(live.includes(marker), `production config should still declare ${marker}`).toBe(true);
      expect(test.includes(marker), `${marker} is omitted from tests: ${why}`).toBe(false);
    }
  });

  // Secrets belong in `wrangler secret put`. A literal in either file would be
  // committed, and the test config is the easier one to be careless with.
  it("carry no credentials", () => {
    for (const source of [live, test]) {
      expect(source).not.toMatch(/LLM_API_KEY\s*=/);
      expect(source).not.toMatch(/GITHUB_CLIENT_SECRET\s*=/);
      expect(source).not.toMatch(/\bsk-[A-Za-z0-9]/);
    }
  });
});
