// The Connections panel: servers this browser is signed in to, and a field to
// add another. Signing in is discovery, then a confirmation naming where you
// are about to be sent, then a redirect.

const STATUS_TEXT = {
  connected: "connected",
  "needs-reconnect": "needs you to sign in again",
  pending: "sign-in not finished",
};

export function mountConnections(container, { connections, suggested, getCounts = () => ({}), onChange = () => {} }) {
  const doc = container.ownerDocument;
  const make = (tag, props = {}, ...children) => {
    const node = Object.assign(doc.createElement(tag), props);
    node.append(...children);
    return node;
  };

  const list = make("ul", { className: "connections" });
  const url = make("input", { type: "url", name: "server", value: suggested ?? "", placeholder: "https://…/mcp" });
  const connect = make("button", { type: "submit", textContent: "Connect" });
  const status = make("p", { className: "muted" });
  status.setAttribute("role", "status");
  const confirmText = make("p", {});
  const proceed = make("button", { type: "button", textContent: "Continue" });
  const cancel = make("button", { type: "button", className: "secondary", textContent: "Cancel" });
  const confirm = make(
    "div",
    { hidden: true },
    confirmText,
    make("div", { className: "dialog-actions" }, cancel, proceed),
  );
  confirm.setAttribute("role", "alertdialog");

  const form = make(
    "form",
    {},
    make("label", {}, "Server URL", url),
    make("div", { className: "dialog-actions" }, connect),
  );
  container.replaceChildren(
    list,
    form,
    confirm,
    status,
    make("p", {
      className: "muted",
      textContent:
        "Every tool a connected server lists is sent to the model on every turn, so more tools means slower, costlier replies.",
    }),
  );

  const say = (text, failed = false) => {
    status.textContent = text;
    status.dataset.state = failed ? "error" : "ok";
  };

  function renderList() {
    const counts = getCounts();
    list.replaceChildren(
      ...connections.list().map((connection) => {
        const tools = counts[connection.id];
        const detail = [STATUS_TEXT[connection.status] ?? connection.status];
        if (tools !== undefined) detail.push(`${tools} tools`);
        const actions = make("span", {});
        if (connection.status !== "connected") {
          actions.append(
            make("button", {
              type: "button",
              className: "link",
              textContent: "Reconnect",
              onclick: () => begin(connection.url),
            }),
          );
        }
        actions.append(
          make("button", {
            type: "button",
            className: "link",
            textContent: "Disconnect",
            onclick: () => {
              connections.disconnect(connection.id);
              onChange();
            },
          }),
        );
        return make("li", {}, make("strong", { textContent: connection.origin }), ` — ${detail.join(", ")} `, actions);
      }),
    );
  }

  let pending = null;
  const choose = (open) => {
    confirm.hidden = !open;
    form.hidden = open;
  };

  async function begin(serverUrl) {
    if (!serverUrl) return say("Enter a server URL first.", true);
    say("Looking up how to sign in…");
    connect.disabled = true;
    try {
      pending = await connections.prepare(serverUrl);
      confirmText.textContent = `Sign in to ${pending.origin}? You will be sent to ${pending.authorizationOrigin} to log in. Only continue if you trust this server: it will be able to answer as a tool.`;
      choose(true);
      say("");
    } catch (err) {
      pending = null;
      say(err.message, true);
    } finally {
      connect.disabled = false;
    }
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    begin(url.value.trim());
  });

  cancel.addEventListener("click", () => {
    pending = null;
    choose(false);
  });

  proceed.addEventListener("click", async () => {
    if (!pending) return;
    proceed.disabled = true;
    try {
      await connections.authorize(pending);
    } catch (err) {
      say(err.message, true);
      choose(false);
    } finally {
      proceed.disabled = false;
    }
  });

  renderList();
  return { refresh: renderList };
}
