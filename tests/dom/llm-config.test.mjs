// The settings form for a model of your own, against a real DOM and a stand-in
// for the Worker. What matters: the key goes out once and never comes back, and
// nothing a provider returns is parsed as HTML.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { mountLlmConfig } from "../../web/src/llm-config.js";

const API = "https://api.test";
const KEY = "sk-test-SECRETSECRET1234";

const reply = (status, data) => ({ ok: status < 400, status, json: async () => data });

// routes: { "GET /llm-config": reply(...) | (init) => reply(...) }
function worker(routes) {
  const calls = [];
  const fetchFn = vi.fn(async (url, init) => {
    const path = url.slice(API.length);
    calls.push({ method: init.method, path, body: init.body ? JSON.parse(init.body) : undefined, init });
    const route = routes[`${init.method} ${path}`];
    if (route === undefined) throw new Error(`unexpected ${init.method} ${path}`);
    return typeof route === "function" ? route(init) : route;
  });
  return { fetchFn, calls };
}

const NONE = reply(200, { configured: false });
const SAVED = reply(200, {
  configured: true,
  base_url: "https://api.example.com/v1",
  key_last4: "1234",
  model: "gpt-x",
});

let container;
beforeEach(() => {
  document.body.innerHTML = '<div id="llm-config"></div>';
  container = document.getElementById("llm-config");
});

const mount = async (routes, onChange = () => {}) => {
  const stub = worker(routes);
  await mountLlmConfig(container, { apiOrigin: API, fetchFn: stub.fetchFn, onChange });
  return stub;
};

const $ = (selector) => container.querySelector(selector);
const button = (text) => [...container.querySelectorAll("button")].find((b) => b.textContent === text);
const type = (input, value) => {
  input.value = value;
};
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("loading", () => {
  it("shows an empty form when nothing is saved", async () => {
    await mount({ "GET /llm-config": NONE });
    expect($('[name="base_url"]').value).toBe("");
    expect($('[name="api_key"]').placeholder).toBe("Paste your API key");
    expect($('[name="model"]').options).toHaveLength(0);
    expect(button("Remove").hidden).toBe(true);
  });

  it("shows saved settings with a masked key and never the key itself", async () => {
    await mount({ "GET /llm-config": SAVED });
    expect($('[name="base_url"]').value).toBe("https://api.example.com/v1");
    expect($('[name="api_key"]').value).toBe("");
    expect($('[name="api_key"]').placeholder).toContain("••••1234");
    expect($('[name="model"]').value).toBe("gpt-x");
    expect(button("Remove").hidden).toBe(false);
  });

  it("sends the session token as a bearer, with the csrf header and no cookie", async () => {
    localStorage.setItem("bolster.help/session", "tok-1");
    const { calls } = await mount({ "GET /llm-config": NONE });
    expect(calls[0].init.headers.authorization).toBe("Bearer tok-1");
    expect(calls[0].init.headers["x-bolster-csrf"]).toBe("1");
    expect(calls[0].init.credentials).toBeUndefined();
  });

  it("sends no Authorization header when there is no session", async () => {
    localStorage.removeItem("bolster.help/session");
    const { calls } = await mount({ "GET /llm-config": NONE });
    expect(calls[0].init.headers.authorization).toBeUndefined();
  });

  it("says so when the settings cannot be loaded", async () => {
    await mount({ "GET /llm-config": reply(503, { error: "not configured" }) });
    expect($("[role=status]").textContent).toBe("not configured");
    expect($("[role=status]").dataset.state).toBe("error");
  });

  it("says so when the server is unreachable", async () => {
    const fetchFn = vi.fn(async () => {
      throw new TypeError("network");
    });
    await mountLlmConfig(container, { apiOrigin: API, fetchFn });
    expect($("[role=status]").textContent).toBe("Could not reach the server.");
  });
});

describe("loading models", () => {
  it("sends the typed key and fills the list, keeping the saved model selected", async () => {
    const { calls } = await mount({
      "GET /llm-config": SAVED,
      "POST /llm-config/models": reply(200, { models: ["gpt-w", "gpt-x", "gpt-y"] }),
    });
    type($('[name="api_key"]'), KEY);
    button("Load models").click();
    await settled();
    const models = calls.find((c) => c.path === "/llm-config/models");
    expect(models.body).toEqual({ base_url: "https://api.example.com/v1", api_key: KEY });
    expect([...$('[name="model"]').options].map((o) => o.value)).toEqual(["gpt-w", "gpt-x", "gpt-y"]);
    expect($('[name="model"]').value).toBe("gpt-x");
    expect($("[role=status]").textContent).toBe("3 models found.");
  });

  it("omits the key when none is typed, so the stored one is used", async () => {
    const { calls } = await mount({
      "GET /llm-config": SAVED,
      "POST /llm-config/models": reply(200, { models: ["gpt-x"] }),
    });
    button("Load models").click();
    await settled();
    expect(calls.find((c) => c.path === "/llm-config/models").body).toEqual({ base_url: "https://api.example.com/v1" });
  });

  it("needs a base URL first", async () => {
    const { calls } = await mount({ "GET /llm-config": NONE });
    button("Load models").click();
    await settled();
    expect(calls).toHaveLength(1);
    expect($("[role=status]").textContent).toBe("Enter a base URL first.");
  });

  it("shows the server's reason when it fails", async () => {
    await mount({
      "GET /llm-config": NONE,
      "POST /llm-config/models": reply(400, { error: "base_url must use https" }),
    });
    type($('[name="base_url"]'), "http://x");
    button("Load models").click();
    await settled();
    expect($("[role=status]").textContent).toBe("base_url must use https");
    expect($("[role=status]").dataset.state).toBe("error");
  });

  it("never parses a model id as HTML", async () => {
    await mount({
      "GET /llm-config": NONE,
      "POST /llm-config/models": reply(200, { models: ["<img src=x onerror=alert(1)>"] }),
    });
    type($('[name="base_url"]'), "https://api.example.com/v1");
    button("Load models").click();
    await settled();
    expect(container.querySelector("img")).toBeNull();
    expect($('[name="model"]').options[0].textContent).toBe("<img src=x onerror=alert(1)>");
  });
});

describe("saving", () => {
  it("sends the key once, then clears it and shows only the mask", async () => {
    const onChange = vi.fn();
    const { calls } = await mount(
      {
        "GET /llm-config": NONE,
        "POST /llm-config/models": reply(200, { models: ["gpt-x"] }),
        "PUT /llm-config": reply(200, {
          configured: true,
          base_url: "https://api.example.com/v1",
          key_last4: "1234",
          model: "gpt-x",
        }),
      },
      onChange,
    );
    type($('[name="base_url"]'), "https://api.example.com/v1");
    type($('[name="api_key"]'), KEY);
    button("Load models").click();
    await settled();
    button("Save").click();
    await settled();

    const put = calls.find((c) => c.method === "PUT");
    expect(put.body).toEqual({ base_url: "https://api.example.com/v1", model: "gpt-x", api_key: KEY });
    expect($('[name="api_key"]').value).toBe("");
    expect($('[name="api_key"]').placeholder).toContain("••••1234");
    expect(container.innerHTML).not.toContain(KEY);
    expect($("[role=status]").textContent).toBe("Saved.");
    expect(onChange).toHaveBeenCalledOnce();
  });

  it("leaves the key out when none is typed", async () => {
    const { calls } = await mount({ "GET /llm-config": SAVED, "PUT /llm-config": SAVED });
    button("Save").click();
    await settled();
    expect(calls.find((c) => c.method === "PUT").body).toEqual({
      base_url: "https://api.example.com/v1",
      model: "gpt-x",
    });
  });

  it("will not save without a model", async () => {
    const { calls } = await mount({ "GET /llm-config": NONE });
    type($('[name="base_url"]'), "https://api.example.com/v1");
    button("Save").click();
    await settled();
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(0);
    expect($("[role=status]").dataset.state).toBe("error");
  });

  it("shows the server's reason and does not report a change", async () => {
    const onChange = vi.fn();
    await mount({ "GET /llm-config": SAVED, "PUT /llm-config": reply(400, { error: "api_key required" }) }, onChange);
    button("Save").click();
    await settled();
    expect($("[role=status]").textContent).toBe("api_key required");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("disables the buttons while a request is in flight", async () => {
    let release;
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    await mount({ "GET /llm-config": SAVED, "PUT /llm-config": () => pending });
    button("Save").click();
    await settled();
    expect(button("Save").disabled).toBe(true);
    expect(button("Load models").disabled).toBe(true);
    release(SAVED);
    await settled();
    expect(button("Save").disabled).toBe(false);
  });
});

describe("removing", () => {
  it("deletes, resets the form and reports the change", async () => {
    const onChange = vi.fn();
    const { calls } = await mount({ "GET /llm-config": SAVED, "DELETE /llm-config": reply(204, {}) }, onChange);
    button("Remove").click();
    await settled();
    expect(calls.some((c) => c.method === "DELETE")).toBe(true);
    expect($('[name="base_url"]').value).toBe("");
    expect(button("Remove").hidden).toBe(true);
    expect($("[role=status]").textContent).toBe("Removed.");
    expect(onChange).toHaveBeenCalledOnce();
  });
});
