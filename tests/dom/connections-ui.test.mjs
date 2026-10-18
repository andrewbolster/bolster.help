// The Connections panel: what it shows, and the confirmation before anyone is
// sent off to log in somewhere.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { mountConnections } from "../../web/src/connections-ui.js";

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));
const flush = async () => {
  for (let i = 0; i < 5; i += 1) await settled();
};

const PREPARED = {
  server: "https://mcp.example.com/mcp",
  origin: "https://mcp.example.com",
  authorizationOrigin: "https://auth.example.com",
};

function fakeConnections(initial = []) {
  const state = { list: initial };
  return {
    list: () => state.list,
    prepare: vi.fn(async () => PREPARED),
    authorize: vi.fn(async () => {}),
    disconnect: vi.fn((id) => {
      state.list = state.list.filter((c) => c.id !== id);
    }),
  };
}

function mount(options = {}) {
  document.body.innerHTML = '<div id="panel"></div>';
  const connections = options.connections ?? fakeConnections();
  const onChange = vi.fn();
  const panel = mountConnections(document.getElementById("panel"), {
    connections,
    suggested: "https://mcp.bolster.online/auth/mcp",
    getCounts: () => options.counts ?? {},
    onChange,
  });
  return { connections, onChange, panel, root: document.getElementById("panel") };
}

const input = (root) => root.querySelector("input[name=server]");
const click = (root, text) => [...root.querySelectorAll("button")].find((b) => b.textContent === text).click();

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("the list", () => {
  it("prefills the suggested server and lists nothing yet", () => {
    const { root } = mount();
    expect(input(root).value).toBe("https://mcp.bolster.online/auth/mcp");
    expect(root.querySelectorAll("ul.connections li")).toHaveLength(0);
  });

  it("shows each connection's origin, status and tool count", () => {
    const connections = fakeConnections([
      { id: "a-1", origin: "https://a.example.com", url: "https://a.example.com/mcp", status: "connected" },
      { id: "b-1", origin: "https://b.example.com", url: "https://b.example.com/mcp", status: "needs-reconnect" },
    ]);
    const { root } = mount({ connections, counts: { "a-1": 12 } });
    const [first, second] = root.querySelectorAll("ul.connections li");
    expect(first.textContent).toContain("https://a.example.com");
    expect(first.textContent).toContain("connected");
    expect(first.textContent).toContain("12 tools");
    expect(second.textContent).toContain("needs you to sign in again");
    expect(first.textContent).not.toContain("Reconnect");
    expect(second.textContent).toContain("Reconnect");
  });

  it("says that every tool is sent every turn", () => {
    expect(mount().root.textContent).toMatch(/sent to the model on every turn/);
  });

  it("disconnects a server and tells the page to rebuild", () => {
    const connections = fakeConnections([
      { id: "a-1", origin: "https://a.example.com", url: "https://a.example.com/mcp", status: "connected" },
    ]);
    const { root, onChange } = mount({ connections });
    click(root, "Disconnect");
    expect(connections.disconnect).toHaveBeenCalledWith("a-1");
    expect(onChange).toHaveBeenCalled();
  });

  it("refresh() re-reads the connections", () => {
    const connections = fakeConnections();
    const { root, panel } = mount({ connections });
    connections.list = () => [{ id: "a-1", origin: "https://a.example.com", url: "u", status: "connected" }];
    panel.refresh();
    expect(root.querySelectorAll("ul.connections li")).toHaveLength(1);
  });
});

describe("adding a server", () => {
  it("looks the server up, then asks before sending you anywhere", async () => {
    const { root, connections } = mount();
    root.querySelector("form").dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();

    expect(connections.prepare).toHaveBeenCalledWith("https://mcp.bolster.online/auth/mcp");
    const alert = root.querySelector("[role=alertdialog]");
    expect(alert.hidden).toBe(false);
    expect(alert.textContent).toContain("https://mcp.example.com");
    expect(alert.textContent).toContain("https://auth.example.com");
    expect(connections.authorize).not.toHaveBeenCalled();
  });

  it("goes ahead only when you continue", async () => {
    const { root, connections } = mount();
    root.querySelector("form").dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    click(root, "Continue");
    await flush();
    expect(connections.authorize).toHaveBeenCalledWith(PREPARED);
  });

  it("does nothing more if you cancel", async () => {
    const { root, connections } = mount();
    root.querySelector("form").dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    click(root, "Cancel");
    expect(root.querySelector("[role=alertdialog]").hidden).toBe(true);
    expect(root.querySelector("form").hidden).toBe(false);
    expect(connections.authorize).not.toHaveBeenCalled();
  });

  it("shows why a server could not be looked up", async () => {
    const connections = fakeConnections();
    connections.prepare = vi.fn(async () => {
      throw new Error("that server did not ask for a login (HTTP 200)");
    });
    const { root } = mount({ connections });
    root.querySelector("form").dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    const status = root.querySelector("[role=status]");
    expect(status.textContent).toContain("did not ask for a login");
    expect(status.dataset.state).toBe("error");
    expect(root.querySelector("[role=alertdialog]").hidden).toBe(true);
  });

  it("needs a URL", async () => {
    const { root, connections } = mount();
    input(root).value = "";
    root.querySelector("form").dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    expect(connections.prepare).not.toHaveBeenCalled();
    expect(root.querySelector("[role=status]").textContent).toMatch(/Enter a server URL/);
  });

  it("reconnects an existing server through the same confirmation", async () => {
    const connections = fakeConnections([
      { id: "b-1", origin: "https://b.example.com", url: "https://b.example.com/mcp", status: "needs-reconnect" },
    ]);
    const { root } = mount({ connections });
    click(root, "Reconnect");
    await flush();
    expect(connections.prepare).toHaveBeenCalledWith("https://b.example.com/mcp");
    expect(root.querySelector("[role=alertdialog]").hidden).toBe(false);
  });
});
