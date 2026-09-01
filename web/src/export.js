// Turning a conversation into something you can keep.
//
// Tool calls are optional because the two audiences want different things: a
// transcript to send someone wants the conversation, and a transcript to work
// out why an answer was wrong wants every call and everything it returned.

const stamp = (ms) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");

/**
 * Render a conversation as Markdown.
 *
 * @param conversation - as stored: title, timestamps and messages.
 * @param includeToolCalls - whether to include each call, its arguments and
 *   the output the model was given. Off by default: it is usually far longer
 *   than the conversation it explains.
 */
export function toMarkdown(conversation, { includeToolCalls = false } = {}) {
  const lines = [`# ${conversation.title}`, "", `_${stamp(conversation.createdAt)} — bolster.help_`, ""];

  for (const turn of conversation.messages ?? []) {
    if (turn.display) {
      // Shown to the reader rather than said, so it is reproduced as-is.
      lines.push(turn.display.caption ? `**${turn.display.caption}**` : "", turn.display.content, "");
      continue;
    }
    if (!turn.content) continue;

    lines.push(turn.role === "user" ? "### You" : "### bolster.help", "", turn.content, "");

    if (includeToolCalls && turn.calls?.length) {
      lines.push(
        "<details>",
        `<summary>${turn.calls.length} tool call${turn.calls.length === 1 ? "" : "s"}</summary>`,
        "",
      );
      for (const call of turn.calls) {
        lines.push(`**\`${call.name}\`**`, "", "```json", JSON.stringify(call.args ?? {}, null, 2), "```", "");
        if (call.result !== undefined) {
          lines.push("```", String(call.result), "```", "");
        }
      }
      lines.push("</details>", "");
    }
  }

  return `${lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()}\n`;
}

/** Render a conversation as JSON, which keeps everything Markdown flattens. */
export function toJSON(conversation, { includeToolCalls = false } = {}) {
  const messages = (conversation.messages ?? []).map((turn) => {
    const { calls, ...rest } = turn;
    return includeToolCalls && calls?.length ? { ...rest, calls } : rest;
  });

  return `${JSON.stringify({ ...conversation, messages }, null, 2)}\n`;
}

/** A filename that sorts by date and survives a filesystem. */
export function exportFilename(conversation, extension) {
  const slug =
    String(conversation.title ?? "conversation")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "conversation";
  return `${new Date(conversation.createdAt).toISOString().slice(0, 10)}-${slug}.${extension}`;
}

/**
 * Hand a file to the browser.
 *
 * Object URLs are revoked on the next frame rather than immediately: Safari
 * has historically cancelled the download if the URL goes before the click is
 * processed.
 */
export function download(text, filename, type, doc = document) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = doc.createElement("a");
  link.href = url;
  link.download = filename;
  doc.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
