// Somewhere for large tool output to live that is not the conversation.
//
// The MCP tools are CLI reporting commands: asking about births returns a
// header, a summary line and 741 rows of CSV. Clipping that to fit the context
// window is lossy in the worst way — the model sees the head, and a summary
// line like "Total records: 741" reads exactly like an answer to "how many
// births". It once reported the row count as a birth count, having faithfully
// quoted a figure it was given.
//
// So output above a threshold is kept here and the model gets a handle, a
// shape and the first few lines. If it needs more it asks, with tools that
// work the way it expects files to work.
//
// This is deliberately not a sandbox. Two operations — read a window of lines,
// search for a pattern — cover what a reporting table is for, and neither can
// do anything but read a string this process already holds.

// What counts as too large to hand over whole.
//
// The threshold is not about the context window, it is about whether storing
// is a saving at all. A stored result costs a preview — a shape line, eight
// lines of data and a usage note, around 400 characters. So anything under
// roughly 800 characters costs *more* stored than passed through, and the
// handle buys nothing but a round trip.
//
// 1200 leaves a margin above that break-even: at the threshold, storing saves
// about a third, and by the time a real NISRA table arrives (17KB) it saves
// 97%. Raising it wastes context; lowering it below ~800 makes the store
// actively counterproductive.
const INLINE_LIMIT = 1200;
const PREVIEW_LINES = 8;
// Handles are strings in a browser tab, and a tab has gigabytes. Eight was
// sized against a five-round loop; a model working through thirty rounds
// fetches more than eight datasets and would find its earliest handle silently
// evicted just as it went to compare it against the latest.
const MAX_OBJECTS = 64;
const MAX_MATCHES = 40;
const MAX_WINDOW = 200;
// A grouped aggregate over years never needs more than a lifetime's worth;
// this only bites if group_by is pointed at a high-cardinality column by
// mistake, and caps the damage rather than the column choice being wrong.
const MAX_GROUPS = 100;

const shape = (text) => {
  const lines = text.split("\n");
  return { lines: lines.length, bytes: text.length };
};

// Arithmetic without eval. Shunting-yard into RPN, then evaluate: the grammar
// is numbers, + - * /, and brackets, so nothing else can be expressed and no
// caller-supplied string ever reaches an interpreter.
const PRECEDENCE = { "+": 1, "-": 1, "*": 2, "/": 2 };

export function evaluateExpression(expression) {
  const tokens = String(expression).match(/\d+(?:\.\d+)?|[+\-*/()]/g);
  if (!tokens) throw new Error(`Nothing to calculate in "${expression}"`);

  const output = [];
  const operators = [];
  for (const token of tokens) {
    if (/\d/.test(token)) output.push(Number(token));
    else if (token === "(") operators.push(token);
    else if (token === ")") {
      while (operators.length && operators.at(-1) !== "(") output.push(operators.pop());
      if (!operators.length) throw new Error("Unbalanced brackets");
      operators.pop();
    } else {
      while (operators.length && PRECEDENCE[operators.at(-1)] >= PRECEDENCE[token]) output.push(operators.pop());
      operators.push(token);
    }
  }
  while (operators.length) {
    const operator = operators.pop();
    if (operator === "(") throw new Error("Unbalanced brackets");
    output.push(operator);
  }

  const stack = [];
  for (const token of output) {
    if (typeof token === "number") {
      stack.push(token);
      continue;
    }
    const right = stack.pop();
    const left = stack.pop();
    if (left === undefined || right === undefined) throw new Error(`Malformed expression "${expression}"`);
    if (token === "/" && right === 0) throw new Error("Division by zero");
    stack.push(token === "+" ? left + right : token === "-" ? left - right : token === "*" ? left * right : left / right);
  }
  if (stack.length !== 1) throw new Error(`Malformed expression "${expression}"`);
  return stack[0];
}

// Tool output is overwhelmingly CSV, but with a banner and summary lines above
// it. The header is the first line that both splits on commas and is followed
// by a line splitting into the same number of fields.
// Taking the first line that looks like a header is not enough: a preamble
// carrying a thousands-separated number — "2024 NI population: 1,927,855" —
// splits into three fields and can be followed by another line that also
// splits into three. The real header is the one starting the longest run of
// consistently-shaped rows, so every candidate is scored and the best wins.
function findTable(lines) {
  let best = null;
  for (const [index, line] of lines.entries()) {
    const header = line.split(",").map((c) => c.trim());
    if (header.length < 2) continue;

    let run = 0;
    while (lines[index + 1 + run]?.split(",").length === header.length) run += 1;
    if (run && (!best || run > best.run)) best = { header, rows: lines.slice(index + 1, index + 1 + run), run };
  }

  if (!best) throw new Error("No comma-separated table found in this output");
  return { header: best.header, rows: best.rows };
}

// Name or 0-based index, the same lookup aggregate_output offers for both
// `column` and `group_by` — one rule, so a value that resolves one resolves
// the other the same way.
function resolveColumn(header, wanted) {
  const text = String(wanted).trim();
  let index = header.findIndex((h) => h.toLowerCase() === text.toLowerCase());
  if (index === -1 && /^\d+$/.test(text)) index = Number(text);
  if (index === -1 || index >= header.length) return -1;
  return index;
}

// NISRA time series are keyed by their period's start date — a month or a
// week, not a year — so grouping the raw value gives one row per month or
// week rather than the year-over-year view that is almost always what is
// actually wanted. A value shaped like a date buckets by its year; anything
// else (a sex, a district, a year column that is already bare) groups as-is.
const bucketKey = (value) => String(value).trim().match(/^(\d{4})-\d{2}(-\d{2})?/)?.[1] ?? String(value).trim();

// The shape a preview cannot show.
//
// The first few lines of a long table say nothing about how it is grouped. A
// table that repeats each period once per category — and again for the total
// of those categories — looks identical in the head to one that does not, and
// aggregating it whole silently double counts.
//
// Enumerating low-cardinality columns is enough to make the grouping visible
// without knowing anything about what the columns mean.
const MAX_LISTED_VALUES = 12;

function describeColumns(lines) {
  let table;
  try {
    table = findTable(lines);
  } catch {
    return null;
  }

  const described = table.header.map((name, index) => {
    const values = new Set();
    for (const row of table.rows) {
      const cell = row.split(",")[index]?.trim();
      if (cell) values.add(cell);
      if (values.size > MAX_LISTED_VALUES) break;
    }
    return values.size <= MAX_LISTED_VALUES
      ? `${name} (${[...values].join(", ")})`
      : `${name} (many values)`;
  });

  return `Columns: ${described.join("; ")}`;
}

export const STORE_TOOLS = [
  {
    type: "function",
    function: {
      name: "read_output",
      description:
        "Read a window of lines from a stored tool output. Use this to page through a table after seeing its first lines.",
      parameters: {
        type: "object",
        properties: {
          handle: { type: "string", description: "The handle the output was stored under, e.g. births#1" },
          start: { type: "integer", description: "First line to read, 1-based. Defaults to 1." },
          lines: { type: "integer", description: `How many lines to read, at most ${MAX_WINDOW}. Defaults to 40.` },
        },
        required: ["handle"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "aggregate_output",
      description:
        "Compute a total, count, average, minimum or maximum over a numeric column of a stored table, optionally over "
        + "only the rows matching a pattern, and optionally one result per group instead of one overall. Use this "
        + "instead of adding numbers yourself — for example, to total a year of monthly figures, or to get one total "
        + "per year across many years. Cannot compute more than one thing per call: for a table with one row per "
        + "year already broken down by column, call it once per column.",
      parameters: {
        type: "object",
        properties: {
          handle: { type: "string", description: "The handle the output was stored under, e.g. births#1" },
          column: { type: "string", description: "Column to aggregate, by header name or 0-based index." },
          pattern: { type: "string", description: "Optional: only rows matching this, case-insensitive." },
          op: { type: "string", enum: ["sum", "count", "mean", "min", "max"], description: "Defaults to sum." },
          group_by: {
            type: "string",
            description:
              "Optional: also group by this column (name or 0-based index) — one aggregate per distinct value "
              + "instead of one overall, e.g. one sum per year across a monthly table. A date-shaped value "
              + "(YYYY-MM-DD or YYYY-MM) is grouped by its year, so grouping a monthly or weekly column by date "
              + "gives one row per year rather than one per month or week.",
          },
        },
        required: ["handle", "column"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "calculate",
      description:
        "Evaluate an arithmetic expression exactly. Use this rather than doing sums in your head — for example "
        + "\"2002+1834+1901\". Supports + - * / ( ) and decimals.",
      parameters: {
        type: "object",
        properties: { expression: { type: "string", description: "Arithmetic to evaluate, e.g. 1834+1901+2002" } },
        required: ["expression"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "display_output",
      description:
        "Show something to the person you are talking to — a table, a list, a chart in text form — without it taking "
        + "up room in your own working context. Use this for anything long or richly formatted, then say briefly in "
        + "your reply what you showed them.",
      parameters: {
        type: "object",
        properties: {
          content: { type: "string", description: "What to show." },
          format: {
            type: "string",
            enum: ["markdown", "code", "text"],
            description: "How to render it. Defaults to markdown.",
          },
          caption: { type: "string", description: "Optional one-line label shown above it." },
        },
        required: ["content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_output",
      description:
        "Save your own notes or intermediate working under a name you choose, then read them back later with "
        + "read_output or search_output. Use this to keep partial results while working through a long table. "
        + "Cannot overwrite output produced by a tool.",
      parameters: {
        type: "object",
        properties: {
          handle: { type: "string", description: "A name for your note, e.g. totals-so-far" },
          text: { type: "string", description: "What to write." },
          append: { type: "boolean", description: "Add to the end instead of replacing. Defaults to false." },
        },
        required: ["handle", "text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_output",
      description:
        "Find lines matching a pattern in a stored tool output. Use this to pull the rows relevant to a question out of a long table.",
      parameters: {
        type: "object",
        properties: {
          handle: { type: "string", description: "The handle the output was stored under, e.g. births#1" },
          pattern: { type: "string", description: "Text or regular expression to look for, case-insensitive." },
          limit: { type: "integer", description: `Most matches to return, at most ${MAX_MATCHES}. Defaults to 20.` },
        },
        required: ["handle", "pattern"],
      },
    },
  },
];

const STORE_TOOL_NAMES = new Set(STORE_TOOLS.map((t) => t.function.name));

export const isStoreTool = (name) => STORE_TOOL_NAMES.has(name);

export function createStore({
  inlineLimit = INLINE_LIMIT,
  maxObjects = MAX_OBJECTS,
  only = null,
  // Where displayed content goes. Defaults to discarding it, so a caller that
  // has no UI — a test, the bake-off harness — is not obliged to handle it.
  onDisplay = () => {},
} = {}) {
  const objects = new Map();
  let counter = 0;

  // `only` narrows which tools are offered. Every extra tool costs context on
  // every round and gives a small model another way to go wrong, so the set is
  // chosen by measurement rather than by what seemed useful to write.
  const offered = only ? STORE_TOOLS.filter((t) => only.includes(t.function.name)) : STORE_TOOLS;

  // Handles read better than opaque ids in a transcript, and the model has to
  // repeat them back accurately for a follow-up call to land.
  const nextHandle = (name) => {
    counter += 1;
    return `${String(name).replace(/^bolster_/, "").replace(/[^a-z0-9_]/gi, "")}#${counter}`;
  };

  const get = (handle) => {
    const object = objects.get(String(handle).trim());
    if (!object) {
      const known = [...objects.keys()];
      throw new Error(known.length ? `No such output ${handle}. Available: ${known.join(", ")}` : "Nothing is stored");
    }
    return object;
  };

  return {
    /** Number of stored objects; the tools are only worth offering above zero. */
    get size() {
      return objects.size;
    },

    /**
     * The tool schemas.
     *
     * Offered unconditionally, including the readers, before anything is
     * stored. Varying the set would save a little context on the opening turn
     * at the cost of the tool list changing shape mid-conversation, which is
     * its own kind of confusing. A reader called with no handle says so.
     */
    tools() {
      return offered;
    },

    /**
     * Take a tool result and return what the model should see.
     *
     * Small results pass straight through: a handle would be indirection with
     * nothing behind it. Large ones are kept, and the model gets enough to know
     * whether it needs to look further.
     */
    put(name, text) {
      // Normalise line endings once, here. Tool output is LF today, but these
      // are Python-generated CSVs and csv.writer defaults to CRLF, so a change
      // upstream would otherwise leave a stray carriage return on the end of
      // every line — surviving the numeric paths by luck, because they trim,
      // while still reaching the model inside quoted lines.
      const body = String(text ?? "").replace(/\r\n?/g, "\n");
      if (body.length <= inlineLimit) return body;

      const handle = nextHandle(name);
      objects.set(handle, { text: body, lines: body.split("\n"), origin: "tool" });

      // Bounded so a long conversation cannot grow without limit; the oldest
      // handle goes first, and a stale handle fails loudly rather than silently
      // returning the wrong table.
      while (objects.size > maxObjects) objects.delete(objects.keys().next().value);

      const { lines, bytes } = shape(body);
      const columns = describeColumns(body.split("\n"));
      return [
        `Stored as ${handle} — ${lines} lines, ${bytes} characters.`,
        ...(columns ? [columns] : []),
        `First ${PREVIEW_LINES} lines:`,
        body.split("\n").slice(0, PREVIEW_LINES).join("\n"),
        `Use read_output, search_output or aggregate_output on "${handle}". Figures in the preview may come from the tool's own preamble and describe the output rather than the data.`,
      ].join("\n");
    },

    /** Forget every handle. Used when the conversation is reset. */
    clear() {
      objects.clear();
      counter = 0;
    },

    /** Run one of the store's own tools. Throws with a usable message. */
    call(name, args = {}) {
      if (name === "read_output") {
        const object = get(args.handle);
        const start = Math.max(1, Number(args.start) || 1);
        const count = Math.min(Math.max(1, Number(args.lines) || 40), MAX_WINDOW);
        const window = object.lines.slice(start - 1, start - 1 + count);
        if (!window.length) return `${args.handle} has ${object.lines.length} lines; ${start} is past the end.`;
        const last = start + window.length - 1;
        return [`${args.handle} lines ${start}-${last} of ${object.lines.length}:`, ...window].join("\n");
      }

      if (name === "search_output") {
        const object = get(args.handle);
        const limit = Math.min(Math.max(1, Number(args.limit) || 20), MAX_MATCHES);
        let test;
        try {
          const expression = new RegExp(String(args.pattern), "i");
          test = (line) => expression.test(line);
        } catch {
          // An invalid regex is a plain substring search rather than an error:
          // the model asked a reasonable question with unlucky punctuation.
          const needle = String(args.pattern).toLowerCase();
          test = (line) => line.toLowerCase().includes(needle);
        }

        // Count every match before trimming. Returning the first N without
        // saying how many there were lets a partial answer look complete: a
        // year of monthly data is 36 rows, so a default limit of 20 silently
        // hands back seven months and the model reports them as the year.
        const matched = [];
        for (const [index, line] of object.lines.entries()) {
          if (test(line)) matched.push(`${index + 1}: ${line}`);
        }
        if (!matched.length) return `No lines in ${args.handle} match "${args.pattern}".`;

        const shown = matched.slice(0, limit);
        const header =
          matched.length > shown.length
            ? `Showing ${shown.length} of ${matched.length} matches in ${args.handle} — raise limit to see the rest:`
            : `${matched.length} match(es) in ${args.handle}:`;
        return [header, ...shown].join("\n");
      }

      if (name === "display_output") {
        const content = String(args.content ?? "");
        if (!content.trim()) throw new Error("display_output needs content");

        // The point of this tool is that the content does *not* come back into
        // the conversation, so the model is told only that it landed.
        const format = ["markdown", "code", "text"].includes(args.format) ? args.format : "markdown";
        onDisplay({ content, format, caption: args.caption ? String(args.caption) : null });
        const lines = content.split("\n").length;
        return `Displayed ${lines} line(s) as ${format} to the reader. They can see it; you do not need to repeat it.`;
      }

      if (name === "write_output") {
        const handle = String(args.handle ?? "").trim();
        if (!handle) throw new Error("write_output needs a handle");

        // Tool output is evidence. Letting the model overwrite it would mean a
        // later read returns something the model wrote, indistinguishable from
        // what the tool actually said.
        const existing = objects.get(handle);
        if (existing?.origin === "tool") {
          throw new Error(`${handle} holds tool output and cannot be written to. Choose another name.`);
        }

        const incoming = String(args.text ?? "").replace(/\r\n?/g, "\n");
        const body = args.append && existing ? `${existing.text}\n${incoming}` : incoming;
        objects.set(handle, { text: body, lines: body.split("\n"), origin: "model" });
        while (objects.size > maxObjects) objects.delete(objects.keys().next().value);

        const { lines, bytes } = shape(body);
        return `${args.append && existing ? "Appended to" : "Wrote"} ${handle} — now ${lines} lines, ${bytes} characters.`;
      }

      if (name === "calculate") {
        const value = evaluateExpression(args.expression);
        return `${args.expression} = ${Number.isInteger(value) ? value : value.toFixed(4).replace(/\.?0+$/, "")}`;
      }

      if (name === "aggregate_output") {
        const object = get(args.handle);
        const { header, rows } = findTable(object.lines);

        const index = resolveColumn(header, args.column);
        if (index === -1) throw new Error(`No column "${args.column}". Columns are: ${header.join(", ")}`);

        let groupIndex = -1;
        if (args.group_by !== undefined) {
          groupIndex = resolveColumn(header, args.group_by);
          if (groupIndex === -1) throw new Error(`No column "${args.group_by}". Columns are: ${header.join(", ")}`);
        }

        let match = () => true;
        if (args.pattern) {
          try {
            const expression = new RegExp(String(args.pattern), "i");
            match = (line) => expression.test(line);
          } catch {
            const needle = String(args.pattern).toLowerCase();
            match = (line) => line.toLowerCase().includes(needle);
          }
        }

        const op = String(args.op ?? "sum").toLowerCase();
        const apply = (values) => {
          const total = values.reduce((a, b) => a + b, 0);
          const result =
            op === "count"
              ? values.length
              : op === "mean"
                ? total / values.length
                : op === "min"
                  ? Math.min(...values)
                  : op === "max"
                    ? Math.max(...values)
                    : total;
          return Number.isInteger(result) ? result : Number(result.toFixed(2));
        };

        const where = args.pattern ? ` matching "${args.pattern}"` : "";
        const filtered = rows.filter(match);

        if (groupIndex === -1) {
          const values = filtered.map((row) => Number(row.split(",")[index]?.trim())).filter((v) => Number.isFinite(v));
          if (!values.length) return `No numeric values in column "${header[index]}"${where}.`;
          return `${op} of "${header[index]}"${where} over ${values.length} rows = ${apply(values)}`;
        }

        // One group per bucket key, values collected in the order rows arrive
        // so a caller relying on Map's insertion order sees them chronologically
        // for the common case (a date-shaped or already-sorted group column).
        const groups = new Map();
        for (const row of filtered) {
          const cells = row.split(",");
          const value = Number(cells[index]?.trim());
          if (!Number.isFinite(value)) continue;
          const key = bucketKey(cells[groupIndex]);
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(value);
        }

        if (!groups.size) return `No numeric values in column "${header[index]}"${where}.`;

        const keys = [...groups.keys()].sort();
        const truncated = keys.length > MAX_GROUPS;
        const lines = keys
          .slice(0, MAX_GROUPS)
          .map((key) => `${key} = ${apply(groups.get(key))} (${groups.get(key).length} rows)`);
        if (truncated) lines.push(`… ${keys.length - MAX_GROUPS} more groups omitted`);

        return `${op} of "${header[index]}"${where}, grouped by "${header[groupIndex]}":\n${lines.join("\n")}`;
      }

      throw new Error(`Unknown store tool ${name}`);
    },
  };
}
