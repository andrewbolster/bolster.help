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
      "Read the complete documentation for a tool — its arguments, worked examples and notes about the data. " +
      "The descriptions you were given are abridged; use this when you need to know exactly what a tool accepts " +
      "or how its output is structured.",
    parameters: {
      type: "object",
      properties: {
        tool: {
          type: "string",
          description: "Name of the tool, e.g. bolster_nisra_births",
        },
      },
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

// Observed live: asked to describe itself, the model sometimes invents a
// tool call rather than trusting its own system prompt —
// full_tool_documentation({tool: "assistant"}). Six varied self-identity
// questions against the live model (2026-09-14) showed this is unreliable
// overall (3/6 didn't call this tool at all; the ones that did also guessed
// "bolster_boe_base_rate", "bolster_companies_house" and bare "bolster" —
// none repeated "assistant"), so this is a backstop for the one name
// actually worth special-casing, not the primary channel — see withModel()
// in persona.js for that.
//
// "bolster" itself is deliberately NOT aliased here despite being observed
// once: it's already Andrew's own name, the Python package this MCP server
// wraps, and the server's own tool-name prefix (bolster_*) — special-casing
// it as "the assistant" would make an already-overloaded word worse, not
// better, for exactly one anecdotal hit.
const ASSISTANT_ALIASES = new Set(["assistant"]);

function describeAssistant(model) {
  return [
    "assistant",
    "",
    "Not an MCP tool. This is bolster.help itself — an avatar of Andrew Bolster answering as him.",
    model ? `Currently running as ${model}.` : "Model not resolved for this session.",
  ].join("\n");
}

/** The unabridged docstring, or a message naming what does exist. */
export function lookupDocumentation(tools, wanted, { model } = {}) {
  const name = String(wanted ?? "").trim();
  if (ASSISTANT_ALIASES.has(name.toLowerCase())) return describeAssistant(model);

  const tool = tools.find((t) => t.name === name) ?? tools.find((t) => t.name === `bolster_${name}`);

  if (!tool) {
    const near = tools.map((t) => t.name).filter((n) => n.includes(name) || name.includes(n));
    return near.length ? `No tool called "${name}". Did you mean: ${near.join(", ")}?` : `No tool called "${name}".`;
  }
  return `${tool.name}\n\n${tool.description}`;
}
