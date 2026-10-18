// The tools the agent is offered: public ones, plus what connected servers list.

import { describe, expect, it, vi } from "vitest";

import { assembleToolset } from "../../web/src/toolset.js";

const PUBLIC_ORIGIN = "https://mcp.bolster.online";
const publicTools = [
  { name: "bolster_births", description: "Births." },
  { name: "bolster_deaths", description: "Deaths." },
];

const fakeClient = (tools, label = "remote") => ({
  connect: vi.fn(async () => {}),
  listTools: vi.fn(async () => tools),
  callTool: vi.fn(async (name) => `${label}:${name}`),
});

function setup(connectionList, clients) {
  const publicClient = { callTool: vi.fn(async (name) => `public:${name}`) };
  const connections = { list: () => connectionList };
  const makeClient = (connection) => clients[connection.id];
  return {
    publicClient,
    run: () => assembleToolset({ publicTools, publicClient, connections, makeClient, publicOrigin: PUBLIC_ORIGIN }),
  };
}

const conn = (id, origin, status = "connected") => ({ id, origin, url: `${origin}/mcp`, status });

describe("with nothing connected", () => {
  it("is exactly the public catalogue", async () => {
    const { run, publicClient } = setup([], {});
    const set = await run();
    expect(set.tools).toEqual(publicTools);
    expect(await set.mcp.callTool("bolster_births", {})).toBe("public:bolster_births");
    expect(publicClient.callTool).toHaveBeenCalledOnce();
  });
});

describe("with another server connected", () => {
  const clients = {
    "ex-1": fakeClient([{ name: "search", description: "Search things.", inputSchema: { type: "object" } }]),
  };

  it("adds its tools, prefixed with the server id and described with its origin", async () => {
    const { run } = setup([conn("ex-1", "https://mcp.example.com")], clients);
    const set = await run();
    expect(set.tools.map((t) => t.name)).toEqual(["bolster_births", "bolster_deaths", "ex-1__search"]);
    expect(set.tools.at(-1).description).toBe("[https://mcp.example.com] Search things.");
    expect(set.counts).toEqual({ "ex-1": 1 });
  });

  it("routes a prefixed call to its server, with the original name", async () => {
    const { run } = setup([conn("ex-1", "https://mcp.example.com")], clients);
    const set = await run();
    expect(await set.mcp.callTool("ex-1__search", { q: "x" })).toBe("remote:search");
    expect(clients["ex-1"].callTool).toHaveBeenCalledWith("search", { q: "x" }, undefined);
  });

  it("keeps two servers' tools apart even when they share a name", async () => {
    const two = { "a-1": fakeClient([{ name: "search" }], "A"), "b-1": fakeClient([{ name: "search" }], "B") };
    const { run } = setup([conn("a-1", "https://a.example.com"), conn("b-1", "https://b.example.com")], two);
    const set = await run();
    expect(await set.mcp.callTool("a-1__search", {})).toBe("A:search");
    expect(await set.mcp.callTool("b-1__search", {})).toBe("B:search");
  });

  it("makes names the model can call: safe characters, at most 64", async () => {
    const odd = { "ex-1": fakeClient([{ name: "do.the thing" }, { name: "x".repeat(100) }]) };
    const { run } = setup([conn("ex-1", "https://mcp.example.com")], odd);
    const names = (await run()).tools.map((t) => t.name).slice(2);
    for (const name of names) expect(name).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("the public server's own authenticated endpoint", () => {
  const authed = fakeClient(
    [
      { name: "bolster_births", description: "Births (authed)." },
      { name: "whoami", description: "Who." },
    ],
    "authed",
  );

  it("replaces the public catalogue instead of adding to it, keeping the names", async () => {
    const { run, publicClient } = setup([conn("bolster-1", PUBLIC_ORIGIN)], { "bolster-1": authed });
    const set = await run();
    expect(set.tools.map((t) => t.name)).toEqual(["bolster_births", "whoami"]);
    expect(set.tools[0].description).toBe("Births (authed).");
    expect(await set.mcp.callTool("bolster_births", {})).toBe("authed:bolster_births");
    expect(publicClient.callTool).not.toHaveBeenCalled();
  });

  it("falls back to the public catalogue when that server cannot be used", async () => {
    const broken = {
      connect: async () => {},
      listTools: async () => {
        throw new Error("boom");
      },
      callTool: vi.fn(),
    };
    const { run } = setup([conn("bolster-1", PUBLIC_ORIGIN)], { "bolster-1": broken });
    const set = await run();
    expect(set.tools).toEqual(publicTools);
    expect(set.problems).toEqual([{ id: "bolster-1", origin: PUBLIC_ORIGIN, message: "boom" }]);
  });
});

describe("a server that is not usable", () => {
  it("is reported, and the others still work", async () => {
    const ok = fakeClient([{ name: "t" }]);
    const bad = {
      connect: async () => {
        throw new Error("needs you to sign in again");
      },
      listTools: vi.fn(),
      callTool: vi.fn(),
    };
    const { run } = setup([conn("ok-1", "https://ok.example.com"), conn("bad-1", "https://bad.example.com")], {
      "ok-1": ok,
      "bad-1": bad,
    });
    const set = await run();
    expect(set.tools.map((t) => t.name)).toContain("ok-1__t");
    expect(set.problems).toHaveLength(1);
    expect(set.problems[0].origin).toBe("https://bad.example.com");
  });

  it("is skipped when it is not connected", async () => {
    const client = fakeClient([{ name: "t" }]);
    const { run } = setup([conn("ex-1", "https://mcp.example.com", "needs-reconnect")], { "ex-1": client });
    const set = await run();
    expect(set.tools).toEqual(publicTools);
    expect(client.connect).not.toHaveBeenCalled();
  });
});
