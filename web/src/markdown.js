// Just enough Markdown for what a model writes.
//
// Parsing and rendering are separate on purpose: `parseMarkdown` is pure and
// testable without a DOM, and `renderMarkdown` only builds nodes. Nothing here
// touches innerHTML, so a model that emits markup — or is steered into it by a
// tool result — produces text rather than elements.
//
// Deliberately partial. Headings, emphasis, code, lists and tables are what
// appears in practice; images, footnotes and raw HTML do not, and each would be
// a way for something other than text to reach the page.

const HEADING = /^(#{1,6})\s+(.*)$/;
const FENCE = /^\s*```(\w*)\s*$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
const DIVIDER = /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/;
const RULE = /^\s*([-*_])\s*(\1\s*){2,}$/;
const QUOTE = /^\s*>\s?(.*)$/;

const cells = (line) =>
  line
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map((cell) => cell.trim());

/** Split text into block tokens. */
export function parseMarkdown(text) {
  const lines = String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n");
  const blocks = [];
  let index = 0;

  const flush = (buffer) => {
    if (buffer.length) blocks.push({ type: "paragraph", text: buffer.join("\n").trim() });
    return [];
  };

  let paragraph = [];
  while (index < lines.length) {
    const line = lines[index];

    const fence = line.match(FENCE);
    if (fence) {
      paragraph = flush(paragraph);
      const body = [];
      index += 1;
      while (index < lines.length && !FENCE.test(lines[index])) body.push(lines[index++]);
      index += 1;
      blocks.push({
        type: "code",
        language: fence[1] || null,
        text: body.join("\n"),
      });
      continue;
    }

    if (!line.trim()) {
      paragraph = flush(paragraph);
      index += 1;
      continue;
    }

    if (RULE.test(line)) {
      paragraph = flush(paragraph);
      blocks.push({ type: "rule" });
      index += 1;
      continue;
    }

    const heading = line.match(HEADING);
    if (heading) {
      paragraph = flush(paragraph);
      blocks.push({
        type: "heading",
        level: heading[1].length,
        text: heading[2].trim(),
      });
      index += 1;
      continue;
    }

    // A table is a header row followed by a divider; without the divider it is
    // just a line that happens to contain pipes.
    if (line.includes("|") && DIVIDER.test(lines[index + 1] ?? "")) {
      paragraph = flush(paragraph);
      const header = cells(line);
      const rows = [];
      index += 2;
      while (index < lines.length && lines[index].includes("|") && lines[index].trim())
        rows.push(cells(lines[index++]));
      blocks.push({ type: "table", header, rows });
      continue;
    }

    if (BULLET.test(line) || NUMBERED.test(line)) {
      paragraph = flush(paragraph);
      const ordered = NUMBERED.test(line);
      const items = [];
      while (index < lines.length) {
        const item = lines[index].match(ordered ? NUMBERED : BULLET);
        if (!item) break;
        items.push(item[1].trim());
        index += 1;
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }

    if (QUOTE.test(line)) {
      paragraph = flush(paragraph);
      const quoted = [];
      while (index < lines.length && QUOTE.test(lines[index])) quoted.push(lines[index++].match(QUOTE)[1]);
      blocks.push({ type: "quote", text: quoted.join("\n").trim() });
      continue;
    }

    paragraph.push(line);
    index += 1;
  }
  flush(paragraph);
  return blocks;
}

/**
 * Split a line into inline spans.
 *
 * Code is taken first so emphasis inside a span stays literal, which is what
 * someone writing `**not bold**` in backticks means.
 */
export function parseInline(text) {
  const spans = [];
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*\n]+\*)|(_[^_\n]+_)|(\[[^\]]+\]\([^)\s]+\))/g;
  let last = 0;

  for (const match of String(text ?? "").matchAll(pattern)) {
    if (match.index > last) spans.push({ type: "text", text: text.slice(last, match.index) });
    const token = match[0];

    if (token.startsWith("`")) spans.push({ type: "code", text: token.slice(1, -1) });
    else if (token.startsWith("**") || token.startsWith("__")) spans.push({ type: "strong", text: token.slice(2, -2) });
    else if (token.startsWith("[")) {
      const [, label, href] = token.match(/\[([^\]]+)\]\(([^)\s]+)\)/);
      // Only schemes that cannot execute. javascript: and data: URLs in a link
      // the model wrote are a script-injection path.
      const safe = /^(https?:|mailto:)/i.test(href);
      spans.push(safe ? { type: "link", text: label, href } : { type: "text", text: label });
    } else spans.push({ type: "emphasis", text: token.slice(1, -1) });

    last = match.index + token.length;
  }
  if (last < String(text ?? "").length) spans.push({ type: "text", text: text.slice(last) });
  return spans;
}

function inlineInto(parent, text, doc) {
  for (const span of parseInline(text)) {
    if (span.type === "text") {
      parent.append(doc.createTextNode(span.text));
      continue;
    }
    const tag = { code: "code", strong: "strong", emphasis: "em", link: "a" }[span.type];
    const node = doc.createElement(tag);
    node.textContent = span.text;
    if (span.type === "link") {
      node.href = span.href;
      node.target = "_blank";
      node.rel = "noopener noreferrer";
    }
    parent.append(node);
  }
}

/** Build a DocumentFragment. Never returns markup, only nodes. */
export function renderMarkdown(text, doc = document) {
  const fragment = doc.createDocumentFragment();

  for (const block of parseMarkdown(text)) {
    if (block.type === "code") {
      const pre = doc.createElement("pre");
      const code = doc.createElement("code");
      code.textContent = block.text;
      pre.append(code);
      fragment.append(pre);
    } else if (block.type === "heading") {
      const heading = doc.createElement(`h${Math.min(block.level + 2, 6)}`);
      inlineInto(heading, block.text, doc);
      fragment.append(heading);
    } else if (block.type === "rule") {
      fragment.append(doc.createElement("hr"));
    } else if (block.type === "list") {
      const list = doc.createElement(block.ordered ? "ol" : "ul");
      for (const item of block.items) {
        const li = doc.createElement("li");
        inlineInto(li, item, doc);
        list.append(li);
      }
      fragment.append(list);
    } else if (block.type === "table") {
      const table = doc.createElement("table");
      const head = doc.createElement("thead");
      const headRow = doc.createElement("tr");
      for (const cell of block.header) {
        const th = doc.createElement("th");
        inlineInto(th, cell, doc);
        headRow.append(th);
      }
      head.append(headRow);
      table.append(head);

      const body = doc.createElement("tbody");
      for (const row of block.rows) {
        const tr = doc.createElement("tr");
        for (const cell of row) {
          const td = doc.createElement("td");
          inlineInto(td, cell, doc);
          tr.append(td);
        }
        body.append(tr);
      }
      table.append(body);
      fragment.append(table);
    } else if (block.type === "quote") {
      const quote = doc.createElement("blockquote");
      inlineInto(quote, block.text, doc);
      fragment.append(quote);
    } else {
      const paragraph = doc.createElement("p");
      inlineInto(paragraph, block.text, doc);
      fragment.append(paragraph);
    }
  }
  return fragment;
}
