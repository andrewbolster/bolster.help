// Neuron accounting for the free tier.
//
// Workers AI reports the neurons a request actually cost in its usage block, so
// this counts measurements rather than estimates.
//
// It lives in a Durable Object because KV cannot hold a counter safely. KV is
// eventually consistent with last-write-wins, so two concurrent requests both
// read N and both write N+1 — and across regions a write takes up to a minute
// to be visible, which is exactly backwards from what a budget needs. The free
// plan also allows 1,000 KV writes a day, fewer than the questions a day of
// neurons buys, so a per-request KV counter would stop working before the
// allocation it guards ran out. A Durable Object is single-threaded, strongly
// consistent, and allows 100,000 row writes a day on the same plan.

import { DurableObject } from "cloudflare:workers";

// Cloudflare's free allocation, shared across every Workers AI model.
export const DAILY_NEURONS = 10_000;

// Workers AI resets at 00:00 UTC, so the bucket is a UTC date and nothing here
// needs to reason about the visitor's timezone.
export const utcDay = (now = new Date()) => now.toISOString().slice(0, 10);

export function resetsAt(now = new Date()) {
  const next = new Date(now);
  next.setUTCHours(24, 0, 0, 0);
  return next.toISOString();
}

const snapshot = (day, neurons, requests) => ({
  day,
  used: Math.round(neurons * 100) / 100,
  requests,
  limit: DAILY_NEURONS,
  remaining: Math.max(0, Math.round((DAILY_NEURONS - neurons) * 100) / 100),
  exhausted: neurons >= DAILY_NEURONS,
  resetsAt: resetsAt(),
});

export class NeuronBudget extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS spend (day TEXT PRIMARY KEY, neurons REAL NOT NULL, requests INTEGER NOT NULL)",
    );
  }

  #read(day) {
    const [row] = this.sql.exec("SELECT neurons, requests FROM spend WHERE day = ?", day).toArray();
    return { neurons: row?.neurons ?? 0, requests: row?.requests ?? 0 };
  }

  // Yesterday's row is dropped rather than kept: this is a gate, not an
  // analytics store, and every retained row costs against the daily write quota.
  #write(day, neurons, requests) {
    this.sql.exec("INSERT OR REPLACE INTO spend (day, neurons, requests) VALUES (?, ?, ?)", day, neurons, requests);
    this.sql.exec("DELETE FROM spend WHERE day <> ?", day);
  }

  peek() {
    const day = utcDay();
    const { neurons, requests } = this.#read(day);
    return snapshot(day, neurons, requests);
  }

  // The Durable Object is single-threaded, so this read-modify-write cannot
  // interleave with another — the property KV could not give us.
  spend(neurons) {
    const day = utcDay();
    const current = this.#read(day);
    const total = current.neurons + Math.max(0, Number(neurons) || 0);
    const requests = current.requests + 1;
    this.#write(day, total, requests);
    return snapshot(day, total, requests);
  }

  // Latched when Workers AI itself answers 3036. Cloudflare's count is
  // authoritative and ours is not: a request that dies after the model ran
  // spends neurons we never recorded, so our tally reads low. Trusting only our
  // own number would keep issuing requests that cannot succeed.
  exhaust() {
    const day = utcDay();
    const current = this.#read(day);
    this.#write(day, Math.max(current.neurons, DAILY_NEURONS), current.requests);
    return this.peek();
  }

  // TEMPORARY — clears today's bad latch from the classify() bug this fixes.
  // Remove this method and its route in index.js in the next commit.
  clearToday() {
    this.#write(utcDay(), 0, 0);
    return this.peek();
  }
}

// One instance for the whole deployment: the allocation is per-account, so
// sharding the counter would only let the shards disagree about one number.
export const budgetOf = (env) => env.NEURON_BUDGET.get(env.NEURON_BUDGET.idFromName("free-tier"));
