// Retrieval is a gate, not a metric. The agent sends the top six schemas and
// nothing else, so a tool that ranks seventh is invisible to the model for that
// turn and no amount of prompting recovers it. recall@6 must therefore be total.

import { describe, it } from "vitest";
import assert from "node:assert/strict";

import { buildIndex, search, summarize, tokenize } from "../../web/src/retrieval.js";
import { snapshot, fixtures } from "../helpers.mjs";

const CANDIDATES = 6;
const index = buildIndex(snapshot.tools);

const ranked = fixtures.map((fixture) => {
  const hits = search(index, fixture.prompt, 8);
  const rank = hits.findIndex((h) => h.tool.name === fixture.expect);
  return { ...fixture, rank: rank === -1 ? Infinity : rank + 1, hits };
});

const recallAt = (k) => ranked.filter((r) => r.rank <= k).length;

describe("retrieval", () => {
  it("ranks every fixture's tool inside the candidate window", () => {
    for (const k of [1, 3, 6, 8]) {
      console.info(`recall@${k} ${recallAt(k)}/${ranked.length}`);
    }

    const missed = ranked.filter((r) => r.rank > CANDIDATES);
    const detail = missed
      .map((r) => {
        const got = r.hits.map((h) => h.tool.name).join(", ") || "(nothing)";
        const where = r.rank === Infinity ? "unranked" : `rank ${r.rank}`;
        return `\n  "${r.prompt}"\n    want ${r.expect} (${where})\n    got  ${got}`;
      })
      .join("");

    assert.equal(missed.length, 0, `${missed.length} fixture(s) outside the top ${CANDIDATES}:${detail}`);
  });

  // Single-character tokens are filtered out, so "A&E" indexes as nothing at
  // all — on both sides. The placeholder question the page itself ships with
  // therefore has to reach emergency care through "waiting", and it competes
  // with the cancer waiting-times tool for that word. Worth pinning: this is
  // the one query every first-time visitor is invited to run.
  it("drops single-letter acronyms yet still retrieves the page's own example", () => {
    assert.deepEqual(tokenize("A&E"), [], "single letters carry no signal");

    const placeholder = "How long are people waiting in A&E?";
    const names = search(index, placeholder, CANDIDATES).map((h) => h.tool.name);
    assert.ok(
      names.includes("bolster_nisra_emergency_care"),
      `index.html placeholder must retrieve emergency care; got ${names.join(", ")}`,
    );
  });

  it("returns nothing rather than noise when no term matches", () => {
    assert.deepEqual(search(index, "zzzz qqqq", CANDIDATES), []);
    assert.deepEqual(search(index, "", CANDIDATES), []);
  });

  // toOpenAITools sends only this, so the trimming is a context-budget decision.
  it("summarizes a docstring down to its first paragraph", () => {
    assert.equal(summarize("First line.\n\n    Args:\n      x: y\n"), "First line.");
  });
});
