// Two projects, because the suite tests two different things.
//
// `unit` is plain JavaScript — retrieval scoring, the agent loop, catalogue
// integrity — plus the network checks. None of it touches a binding, and it
// runs fastest in Node.
//
// `worker` runs inside workerd via Cloudflare's own plugin, so the Durable
// Object, KV and rate-limit bindings are real rather than stood in for. That
// matters most for NeuronBudget: its whole reason to exist is a consistency
// guarantee, and a hand-written fake would assert the guarantee we wanted
// instead of the one we get.

import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// WS_NO_BUFFER_UTIL is set by the npm scripts rather than here: the pool runs
// in its own process and does not inherit a mutation made while this config is
// evaluated. See the README for why it is set at all.

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          environment: "node",
          include: ["tests/unit/**/*.test.mjs"],
        },
      },
      {
        plugins: [
          cloudflareTest({
            // Not wrangler.toml: that file declares the AI binding, which has
            // no local simulator, so the plugin would open a remote proxy
            // session and require CLOUDFLARE_API_TOKEN to run any test at all.
            wrangler: { configPath: "./worker/wrangler.test.toml" },
          }),
        ],
        test: {
          name: "worker",
          include: ["tests/worker/**/*.test.mjs"],
        },
      },
    ],
  },
});
