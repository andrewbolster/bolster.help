#!/usr/bin/env node
// Retrieval gate: every fixture's expected tool must appear in the top-K candidates.
// A miss here is unrecoverable at runtime — the model never sees the tool.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { buildIndex, search } from "../web/src/retrieval.js";

const here = dirname(fileURLToPath(import.meta.url));
const LIMIT = 8;

const [snapshot, fixtures] = await Promise.all([
  readFile(join(here, "..", "web", "src", "tools.json"), "utf8").then(JSON.parse),
  readFile(join(here, "fixtures.json"), "utf8").then(JSON.parse),
]);

const known = new Set(snapshot.tools.map((t) => t.name));
const unknown = fixtures.filter((f) => !known.has(f.expect));
if (unknown.length) {
  throw new Error(`fixtures reference missing tools: ${unknown.map((f) => f.expect).join(", ")}`);
}

const index = buildIndex(snapshot.tools);

const rows = fixtures.map((fixture) => {
  const hits = search(index, fixture.prompt, LIMIT);
  const rank = hits.findIndex((h) => h.tool.name === fixture.expect);
  return { ...fixture, rank: rank === -1 ? Infinity : rank + 1, hits };
});

const recallAt = (k) => rows.filter((r) => r.rank <= k).length;

for (const row of rows) {
  if (row.rank <= 6) continue;
  const got = row.hits.map((h) => h.tool.name).join(", ") || "(nothing)";
  const label = row.rank === Infinity ? "MISS" : `rank ${row.rank}`;
  console.log(`${label.padEnd(8)} ${row.prompt}\n         want ${row.expect}\n         got  ${got}\n`);
}

const n = rows.length;
console.log(`recall@1 ${recallAt(1)}/${n}`);
console.log(`recall@3 ${recallAt(3)}/${n}`);
console.log(`recall@6 ${recallAt(6)}/${n}`);
console.log(`recall@8 ${recallAt(8)}/${n}`);

if (recallAt(6) < n) {
  console.error(`\n${n - recallAt(6)} fixture(s) outside the top 6`);
  process.exitCode = 1;
}
