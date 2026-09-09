// Agreement between the three lists that have to stay in step: the tool
// snapshot, the proxy allowlist, and the question fixtures.
//
// The allowlist is now derived from the snapshot (see worker/src/allowlist.js)
// rather than hand-written, so it can't drift from `upstream` by construction.
// What's still manual is EXCLUDED_TOOLS and the fixtures, so those are what
// these assertions watch.

import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { ALLOWED_METHODS, ALLOWED_TOOLS, EXCLUDED_TOOLS } from "../../worker/src/allowlist.js";
import { fixtures, snapshot } from "../helpers.mjs";

const upstream = new Set(snapshot.tools.map((t) => t.name));

describe("tool snapshot", () => {
  it("records where it came from and when", () => {
    assert.ok(snapshot.source, "snapshot must name its origin");
    assert.ok(Number.isFinite(Date.parse(snapshot.fetchedAt)), "fetchedAt must be a date");
  });

  it("gives every tool a name, a description and a schema", () => {
    for (const tool of snapshot.tools) {
      assert.ok(tool.name, "tool is missing a name");
      assert.ok(tool.description?.trim(), `${tool.name} has no description to index`);
      assert.equal(typeof tool.inputSchema, "object", `${tool.name} has no input schema`);
    }
  });
});

describe("proxy allowlist", () => {
  it("names only tools that exist upstream", () => {
    const phantom = [...ALLOWED_TOOLS].filter((name) => !upstream.has(name));
    assert.deepEqual(phantom, [], "allowlisted tools missing from tools.json — stale snapshot or a typo");
  });

  it("keeps the deliberate exclusions out", () => {
    for (const [name, why] of Object.entries(EXCLUDED_TOOLS)) {
      assert.ok(upstream.has(name), `${name} is no longer upstream; the exclusion may be moot`);
      assert.ok(!ALLOWED_TOOLS.has(name), `${name} must stay unreachable — ${why}`);
    }
  });

  // Every upstream tool not explicitly excluded is now allowlisted
  // automatically — this is the flip side of the derivation, asserted so a
  // bug in the filter (e.g. a typo'd EXCLUDED_TOOLS key) shows up as a
  // failing test rather than a silent extra exposure or omission.
  it("allowlists everything upstream except the deliberate exclusions", () => {
    const expected = [...upstream].filter((name) => !(name in EXCLUDED_TOOLS)).sort();
    assert.deepEqual([...ALLOWED_TOOLS].sort(), expected);
  });

  it("permits exactly the JSON-RPC methods the client uses", () => {
    assert.deepEqual(
      [...ALLOWED_METHODS].sort(),
      ["initialize", "notifications/initialized", "ping", "tools/call", "tools/list"],
      "widening this set widens what an anonymous caller can reach",
    );
  });
});

describe("question fixtures", () => {
  it("expect only tools that exist upstream", () => {
    const phantom = fixtures.filter((f) => !upstream.has(f.expect)).map((f) => f.expect);
    assert.deepEqual(phantom, [], "fixtures reference tools missing from tools.json");
  });

  it("expect only tools the proxy will actually call", () => {
    const unreachable = fixtures.filter((f) => !ALLOWED_TOOLS.has(f.expect)).map((f) => f.expect);
    assert.deepEqual(unreachable, [], "a fixture cannot expect a tool the proxy refuses");
  });

  // Fixtures are now a spot-check, not full coverage: with the allowlist
  // auto-derived, a newly-exposed tool has no fixture until someone writes
  // one. Reported so the gap stays visible without blocking every upstream
  // addition on content authoring.
  it("reports allowlisted tools with no fixture yet", () => {
    const covered = new Set(fixtures.map((f) => f.expect));
    const uncovered = [...ALLOWED_TOOLS].filter((name) => !covered.has(name)).sort();
    for (const name of uncovered) console.info(`allowlisted but no fixture yet: ${name}`);
  });

  it("give every fixture a prompt", () => {
    for (const fixture of fixtures) {
      assert.ok(fixture.prompt?.trim(), `fixture for ${fixture.expect} has no prompt`);
    }
  });
});
