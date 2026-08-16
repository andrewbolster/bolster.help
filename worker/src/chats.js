// Conversation storage for signed-in users. Anonymous sessions never reach
// here, which is what keeps ordinary traffic off the free-tier D1 write budget.

const MAX_CHAT_BYTES = 256 * 1024;

const json = (body, status, headers) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, "content-type": "application/json" },
  });

export async function chats(request, env, headers, user, id) {
  if (request.method === "GET" && !id) {
    const { results } = await env.DB.prepare(
      "SELECT id, title, updated_at FROM chats WHERE user_id = ? ORDER BY updated_at DESC LIMIT 50",
    )
      .bind(user.github_id)
      .all();
    return json(results, 200, headers);
  }

  if (request.method === "GET") {
    const row = await env.DB.prepare("SELECT id, title, messages, updated_at FROM chats WHERE id = ? AND user_id = ?")
      .bind(id, user.github_id)
      .first();
    if (!row) return json({ error: "not found" }, 404, headers);
    return json({ ...row, messages: JSON.parse(row.messages) }, 200, headers);
  }

  if (request.method === "POST") {
    const raw = await request.text();
    if (raw.length > MAX_CHAT_BYTES) return json({ error: "conversation too large" }, 413, headers);

    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return json({ error: "invalid JSON" }, 400, headers);
    }
    if (!Array.isArray(body.messages)) return json({ error: "messages must be an array" }, 400, headers);

    const chatId = body.id ?? crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO chats (id, user_id, title, messages, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET title = excluded.title, messages = excluded.messages, updated_at = excluded.updated_at
       WHERE chats.user_id = excluded.user_id`,
    )
      .bind(chatId, user.github_id, String(body.title ?? "Untitled").slice(0, 200), JSON.stringify(body.messages))
      .run();
    return json({ id: chatId }, 200, headers);
  }

  if (request.method === "DELETE") {
    if (!id) return json({ error: "id required" }, 400, headers);
    await env.DB.prepare("DELETE FROM chats WHERE id = ? AND user_id = ?").bind(id, user.github_id).run();
    return new Response(null, { status: 204, headers });
  }

  return json({ error: "method not allowed" }, 405, headers);
}
