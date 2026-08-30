// The tool catalogue as the model sees it.
//
// Descriptions are docstrings written for CLI users: a paragraph or two of
// prose, then reST sections of usage examples, argument lists and notes. In
// full they measure ~19K tokens across 36 tools; the prose alone is a fraction
// of that and carries what the model needs to choose.
//
// So the prose is sent by default and the rest is available on request. An
// earlier version cut to the first paragraph and offered no way back, which
// reduced "NISRA Monthly Birth Registrations Statistics." to exactly that —
// losing that the data breaks down by sex, comes in registration and
// occurrence flavours, and is keyed on the mother's residence.

// A section header is a capitalised word or two, alone on its line, ending in
// a colon: "Examples:", "Data Notes:", "Args:". Everything above the first one
// is the description proper.
const SECTION_HEADER = /^[ \t]*[A-Z][A-Za-z ]{2,24}:[ \t]*$/m;

export function summarize(description) {
  const text = String(description ?? "");
  const match = text.match(SECTION_HEADER);
  const prose = match ? text.slice(0, match.index) : text;

  // Underline rows beneath a header ("---------") survive the cut when the
  // header itself does not, so drop any trailing rule and blank lines.
  return prose
    .replace(/^[ \t]*[-=~]{3,}[ \t]*$/gm, "")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export const DOCUMENTATION_TOOL = {
  type: "function",
  function: {
    name: "full_tool_documentation",
    description:
      "Read the complete documentation for a tool — its arguments, worked examples and notes about the data. "
      + "The descriptions you were given are abridged; use this when you need to know exactly what a tool accepts "
      + "or how its output is structured.",
    parameters: {
      type: "object",
      properties: { tool: { type: "string", description: "Name of the tool, e.g. bolster_nisra_births" } },
      required: ["tool"],
    },
  },
};

export const isDocumentationTool = (name) => name === DOCUMENTATION_TOOL.function.name;

/** Schemas for every tool, with descriptions cut back to their prose. */
export function toToolSchemas(tools) {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: summarize(tool.description),
      parameters: tool.inputSchema ?? { type: "object", properties: {} },
    },
  }));
}

/** The unabridged docstring, or a message naming what does exist. */
export function lookupDocumentation(tools, wanted) {
  const name = String(wanted ?? "").trim();
  const tool = tools.find((t) => t.name === name) ?? tools.find((t) => t.name === `bolster_${name}`);

  if (!tool) {
    const near = tools.map((t) => t.name).filter((n) => n.includes(name) || name.includes(n));
    return near.length ? `No tool called "${name}". Did you mean: ${near.join(", ")}?` : `No tool called "${name}".`;
  }
  return `${tool.name}\n\n${tool.description}`;
}
