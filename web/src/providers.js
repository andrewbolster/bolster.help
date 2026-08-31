// One way to reach a model.
//
// agent.js only ever calls engine.chat.completions.create({messages, tools,
// tool_choice}), and /llm supplies the credentials, the endpoint and the model
// from the deployment's own configuration. There is nothing for a visitor to
// bring and nothing to configure.
//
// A bring-your-own-key path existed here once and was removed: it asked people
// to paste a provider key into someone else's website, which nobody sensible
// does, in exchange for three engine code paths and a form on the front page.

// Free-tier replies carry the allowance left after serving them, so `onBudget`
// keeps the bar current without a second round trip. It also fires on refusal:
// a 429 is exactly when the number changed and the page most needs to say so.
export function createProxyEngine(endpoint, onBudget = () => {}) {
  return {
    chat: {
      completions: {
        create: async ({ messages, tools, tool_choice, signal }) => {
          const response = await fetch(endpoint, {
            method: "POST",
            credentials: "include",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ messages, tools, tool_choice }),
            signal,
          });

          if (!response.ok) {
            const detail = await response.json().catch(() => ({}));
            if (detail.usage) onBudget(detail.usage);
            // The reason travels with the error so the page can say something
            // useful rather than relaying a sentence written for a log.
            const failure = new Error(detail.error ?? `HTTP ${response.status}`);
            failure.reason = detail.reason ?? (response.status === 429 ? "exhausted" : "unknown");
            failure.status = response.status;
            throw failure;
          }

          const body = await response.json();
          if (body.usage_budget) onBudget(body.usage_budget);
          return body;
        },
      },
    },
  };
}
