// Two ways to reach a model, one shape.
//
// agent.js only ever calls engine.chat.completions.create({messages, tools,
// tool_choice}), so both paths present that and the loop stays unaware of which
// is in use.
//
// A key the visitor typed goes from this browser straight to their provider.
// Relaying it would make the Worker the custodian of someone else's key and an
// open forwarder to any URL they name — a worse trade than depending on the
// provider sending CORS headers, which OpenAI, OpenRouter, Groq and LiteLLM do.
//
// The deployment's own key is the opposite case: it lives in a Worker secret
// and cannot be handed to the browser, so those calls are relayed through /llm,
// which decides both the credentials and the model.

export function createRemoteEngine({ baseUrl, apiKey, model }) {
  const endpoint = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;

  return {
    chat: {
      completions: {
        create: async ({ messages, tools, tool_choice }) => {
          const response = await fetch(endpoint, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({ model, messages, tools, tool_choice }),
          });

          if (!response.ok) {
            const detail = await response.text().catch(() => "");
            throw new Error(`${response.status} ${detail.slice(0, 200)}`.trim());
          }
          return response.json();
        },
      },
    },
  };
}

// No key, no base URL, no model name: /llm supplies all three and decides which
// tier the caller gets — the deployment's own credentials for an allowlisted
// account, Cloudflare's free allocation for everyone else.
//
// Free-tier replies carry the allowance left after serving them, so `onBudget`
// keeps the bar current without a second round trip. It also fires on refusal:
// a 429 is exactly when the number changed and the page most needs to say so.
export function createProxyEngine(endpoint, onBudget = () => {}) {
  return {
    chat: {
      completions: {
        create: async ({ messages, tools, tool_choice }) => {
          const response = await fetch(endpoint, {
            method: "POST",
            credentials: "include",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ messages, tools, tool_choice }),
          });

          if (!response.ok) {
            const detail = await response.json().catch(() => ({}));
            if (detail.usage) onBudget(detail.usage);
            throw new Error(detail.error ?? `HTTP ${response.status}`);
          }

          const body = await response.json();
          if (body.usage_budget) onBudget(body.usage_budget);
          return body;
        },
      },
    },
  };
}

// Providers vary in what they return here, so treat a failure as "can't list"
// rather than "can't connect" — the model name is a free-text field either way.
export async function listModels({ baseUrl, apiKey }) {
  const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await response.json();
  return (body.data ?? []).map((m) => m.id).filter(Boolean).sort();
}
