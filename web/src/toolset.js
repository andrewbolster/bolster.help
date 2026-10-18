// The tools the agent is offered: the public ones, plus everything each
// connected server lists.
//
// Tools from other servers are prefixed with the server's id so two servers can
// never collide. The exception is the public MCP server's own authenticated
// endpoint, which re-exports every public tool: connected, it replaces the
// public catalogue and keeps the names, instead of sending the same tools twice.

const MAX_NAME = 64;

const safe = (name) => String(name).replace(/[^A-Za-z0-9_-]/g, "_");

function prefixed(id, name, taken) {
  let candidate = `${id}__${safe(name)}`.slice(0, MAX_NAME);
  for (let n = 2; taken.has(candidate); n += 1) {
    candidate = `${id}__${safe(name)}`.slice(0, MAX_NAME - String(n).length - 1) + `_${n}`;
  }
  return candidate;
}

export async function assembleToolset({ publicTools, publicClient, connections, makeClient, publicOrigin }) {
  const connected = connections.list().filter((c) => c.status === "connected");

  const settled = await Promise.allSettled(
    connected.map(async (connection) => {
      const client = makeClient(connection);
      await client.connect();
      return { connection, client, tools: await client.listTools() };
    }),
  );

  const problems = [];
  const live = [];
  settled.forEach((outcome, index) => {
    if (outcome.status === "fulfilled") live.push(outcome.value);
    else problems.push({ id: connected[index].id, origin: connected[index].origin, message: outcome.reason.message });
  });

  const replacing = live.find(({ connection }) => connection.origin === publicOrigin);
  const tools = replacing ? [] : [...publicTools];
  const taken = new Set(tools.map((t) => t.name));
  const routes = new Map();
  const counts = {};

  for (const { connection, client, tools: listed } of live) {
    counts[connection.id] = listed.length;
    const keepNames = connection === replacing?.connection;
    for (const tool of listed) {
      const name = keepNames ? tool.name : prefixed(connection.id, tool.name, taken);
      taken.add(name);
      routes.set(name, { client, original: tool.name });
      tools.push({
        name,
        description: keepNames ? tool.description : `[${connection.origin}] ${tool.description ?? ""}`.trim(),
        inputSchema: tool.inputSchema,
      });
    }
  }

  return {
    tools,
    counts,
    problems,
    mcp: {
      callTool(name, args, options) {
        const route = routes.get(name);
        return route
          ? route.client.callTool(route.original, args, options)
          : publicClient.callTool(name, args, options);
      },
    },
  };
}
