// How tools are described to the model, and how it gets the rest.
//
// Descriptions are CLI docstrings: prose, then reST sections of examples,
// arguments and notes. Sending them whole costs ~19K tokens; sending only the
// first paragraph loses the part that matters. The prose is the useful middle,
// and full_tool_documentation exists so nothing is unreachable.

import { describe, it, expect } from "vitest";

import {
  DOCUMENTATION_TOOL,
  isDocumentationTool,
  lookupDocumentation,
  summarize,
  toToolSchemas,
} from "../../web/src/catalogue.js";
import { snapshot } from "../helpers.mjs";

const births = snapshot.tools.find((t) => t.name === "bolster_nisra_births");

describe("summarize", () => {
  it("keeps the prose and drops the sections below it", () => {
    const short = summarize(births.description);
    expect(short).toMatch(/Monthly Birth Registrations/);
    // The detail an earlier first-paragraph cut discarded, and whose absence
    // let a total be aggregated together with its own parts.
    expect(short).toMatch(/Breakdown by sex/);
    expect(short).not.toMatch(/Examples:/);
    expect(short).not.toMatch(/bolster nisra births --event-type/);
  });

  it("cuts at whichever section comes first", () => {
    expect(summarize("Does a thing.\n\nMore prose.\n\nArgs:\n    x: y\n")).toBe("Does a thing.\n\nMore prose.");
    expect(summarize("Does a thing.\n\nData Notes:\n    - a\n")).toBe("Does a thing.");
  });

  it("drops the underline left behind when a header is cut", () => {
    expect(summarize("Title.\n\nExamples:\n---------\nfoo")).toBe("Title.");
  });

  it("passes through a description with no sections", () => {
    expect(summarize("Just one line.")).toBe("Just one line.");
    expect(summarize(undefined)).toBe("");
  });

  it("is substantially smaller than the full catalogue but not a stub", () => {
    const full = JSON.stringify(snapshot.tools.map((t) => t.description)).length;
    const cut = JSON.stringify(snapshot.tools.map((t) => summarize(t.description))).length;
    expect(cut).toBeLessThan(full * 0.7);
    // Guards the failure this replaced: a one-line description per tool.
    expect(cut / snapshot.tools.length).toBeGreaterThan(150);
  });
});

describe("the catalogue offered to the model", () => {
  it("covers every tool and carries the documentation tool alongside", () => {
    const schemas = toToolSchemas(snapshot.tools);
    expect(schemas).toHaveLength(snapshot.tools.length);
    expect(schemas.every((s) => s.function.description.length > 0)).toBe(true);
    expect(isDocumentationTool(DOCUMENTATION_TOOL.function.name)).toBe(true);
    expect(isDocumentationTool("bolster_nisra_births")).toBe(false);
  });

  it("keeps input schemas untouched", () => {
    const schema = toToolSchemas(snapshot.tools).find((s) => s.function.name === "bolster_nisra_births");
    expect(schema.function.parameters).toEqual(births.inputSchema);
  });
});

describe("full_tool_documentation", () => {
  it("returns the unabridged docstring", () => {
    const docs = lookupDocumentation(snapshot.tools, "bolster_nisra_births");
    expect(docs).toMatch(/Examples:/);
    expect(docs.length).toBeGreaterThan(summarize(births.description).length);
  });

  it("resolves a name given without its prefix", () => {
    expect(lookupDocumentation(snapshot.tools, "nisra_births")).toMatch(/Monthly Birth Registrations/);
  });

  it("suggests near matches rather than failing blankly", () => {
    expect(lookupDocumentation(snapshot.tools, "births")).toMatch(/Did you mean: bolster_nisra_births/);
    expect(lookupDocumentation(snapshot.tools, "zzz")).toBe('No tool called "zzz".');
  });
});
