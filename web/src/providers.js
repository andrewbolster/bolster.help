// An OpenAI-compatible endpoint, shaped like a WebLLM engine.
//
// agent.js only ever calls engine.chat.completions.create({messages, tools,
// tool_choice}), which is the shape WebLLM already mimics. Matching it here is
// what lets a hosted provider drop in with no changes to the agent loop.
//
// The browser talks to the provider directly. Relaying through the Worker would
// make it the custodian of the user's key and an open forwarder to any URL they
// name, which is a worse trade than depending on the provider sending CORS
// headers — OpenAI, OpenRouter and Groq all do, as does LiteLLM's proxy.

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
