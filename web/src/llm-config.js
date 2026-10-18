// The settings form for a model of your own (any OpenAI-compatible provider).
//
// The key is typed here and sent to the Worker; it is never read back. All the
// page ever learns is the last four characters, shown as "saved ••••1234".

export function mountLlmConfig(container, { apiOrigin, fetchFn = fetch, onChange = () => {} }) {
  const doc = container.ownerDocument;
  const make = (tag, props = {}, ...children) => {
    const node = Object.assign(doc.createElement(tag), props);
    node.append(...children);
    return node;
  };
  const field = (label, input) => make("label", {}, label, input);

  const baseUrl = make("input", { type: "url", name: "base_url", placeholder: "https://api.openai.com/v1" });
  const apiKey = make("input", { type: "password", name: "api_key", autocomplete: "off" });
  const model = make("select", { name: "model" });
  const load = make("button", { type: "button", className: "secondary", textContent: "Load models" });
  const save = make("button", { type: "submit", textContent: "Save" });
  const remove = make("button", { type: "button", className: "secondary", textContent: "Remove", hidden: true });
  const status = make("p", { className: "muted" });
  status.setAttribute("role", "status");

  const form = make(
    "form",
    {},
    field("Base URL", baseUrl),
    field("API key", apiKey),
    make("p", {}, load),
    field("Model", model),
    status,
    make("div", { className: "dialog-actions" }, remove, save),
  );
  container.replaceChildren(form);

  let saved = null;

  const say = (text, failed = false) => {
    status.textContent = text;
    status.dataset.state = failed ? "error" : "ok";
  };

  async function request(method, path, body) {
    const response = await fetchFn(`${apiOrigin}${path}`, {
      method,
      credentials: "include",
      headers: { "content-type": "application/json", "x-bolster-csrf": "1" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = response.status === 204 ? {} : await response.json().catch(() => ({}));
    return { ok: response.ok, data };
  }

  const busy = async (work) => {
    for (const button of [load, save, remove]) button.disabled = true;
    try {
      await work();
    } catch {
      say("Could not reach the server.", true);
    } finally {
      for (const button of [load, save, remove]) button.disabled = false;
    }
  };

  function setModels(ids, selected) {
    model.replaceChildren(...ids.map((id) => make("option", { value: id, textContent: id })));
    if (selected && ids.includes(selected)) model.value = selected;
  }

  function show(config) {
    saved = config?.configured ? config : null;
    baseUrl.value = saved?.base_url ?? "";
    apiKey.value = "";
    apiKey.placeholder = saved ? `Saved ••••${saved.key_last4}, leave blank to keep` : "Paste your API key";
    setModels(saved ? [saved.model] : [], saved?.model);
    remove.hidden = !saved;
  }

  const typedKey = () => (apiKey.value ? { api_key: apiKey.value } : {});

  load.addEventListener("click", () =>
    busy(async () => {
      if (!baseUrl.value) return say("Enter a base URL first.", true);
      const { ok, data } = await request("POST", "/llm-config/models", { base_url: baseUrl.value, ...typedKey() });
      if (!ok) return say(data.error ?? "Could not load models.", true);
      setModels(data.models, saved?.model);
      say(data.models.length ? `${data.models.length} models found.` : "The provider listed no models.");
    }),
  );

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    busy(async () => {
      if (!baseUrl.value || !model.value) return say("Enter a base URL, load models and choose one.", true);
      const { ok, data } = await request("PUT", "/llm-config", {
        base_url: baseUrl.value,
        model: model.value,
        ...typedKey(),
      });
      if (!ok) return say(data.error ?? "Could not save.", true);
      show(data);
      say("Saved.");
      onChange();
    });
  });

  remove.addEventListener("click", () =>
    busy(async () => {
      const { ok, data } = await request("DELETE", "/llm-config");
      if (!ok) return say(data.error ?? "Could not remove.", true);
      show(null);
      say("Removed.");
      onChange();
    }),
  );

  // Resolves once the saved settings, if any, are on screen.
  return busy(async () => {
    const { ok, data } = await request("GET", "/llm-config");
    if (ok) show(data);
    else say(data.error ?? "Could not load your settings.", true);
  });
}
