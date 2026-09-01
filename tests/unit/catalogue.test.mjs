// Agreement between the three lists that have to stay in step: the tool
// snapshot, the proxy allowlist, and the question fixtures.
//
// Nothing keeps them aligned automatically. `refresh-tools` is manual, the
// allowlist is hand-written on purpose, and fixtures are added by whoever adds
// a tool. These assertions are where that drift surfaces.

import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { ALLOWED_METHODS, ALLOWED_TOOLS } from "../../worker/src/allowlist.js";
import { fixtures, snapshot } from "../helpers.mjs";

const upstream = new Set(snapshot.tools.map((t) => t.name));

// Named here rather than derived: the allowlist comment explains why each is
// out, and this test fails loudly if one is ever quietly added back.
const EXCLUDED = {
  bolster_get_precipitation: "every call spends the Met Office API key quota",
  send_contact_message: "write side-effect, delivers mail to a real inbox",
};

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

  it("keeps the two deliberate exclusions out", () => {
    for (const [name, why] of Object.entries(EXCLUDED)) {
      assert.ok(upstream.has(name), `${name} is no longer upstream; the exclusion may be moot`);
      assert.ok(!ALLOWED_TOOLS.has(name), `${name} must stay unreachable — ${why}`);
    }
  });

  // A new upstream tool stays unreachable until someone decides it is safe to
  // expose anonymously. This test does not fail on that gap — it reports it, so
  // the decision is visible rather than silent.
  it("reports upstream tools awaiting a decision", () => {
    const undecided = [...upstream].filter((name) => !ALLOWED_TOOLS.has(name) && !(name in EXCLUDED));
    for (const name of undecided) console.info(`upstream but not allowlisted: ${name}`);
    assert.equal(
      ALLOWED_TOOLS.size + Object.keys(EXCLUDED).length + undecided.length,
      upstream.size,
      "every upstream tool should be allowlisted, excluded, or listed above",
    );
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

  // A fixture is a worked example of a question that tool should answer. An
  // allowlisted tool without one is a tool nobody has checked is reachable.
  it("cover every allowlisted tool at least once", () => {
    const covered = new Set(fixtures.map((f) => f.expect));
    const uncovered = [...ALLOWED_TOOLS].filter((name) => !covered.has(name)).sort();
    assert.deepEqual(uncovered, [], "allowlisted tools with no fixture");
  });

  it("give every fixture a prompt", () => {
    for (const fixture of fixtures) {
      assert.ok(fixture.prompt?.trim(), `fixture for ${fixture.expect} has no prompt`);
    }
  });
});
