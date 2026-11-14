/**
 * The host's daily ceiling on paid model spending, the runtime's response to
 * it, and the tools hidden from self-hosted agents.
 */
import { describe, expect, it } from "vitest";
import { handleChatCompletion, ProxyError } from "../../host/inference-proxy.js";
import { HostStore, MICRO_PER_USD } from "../../host/store.js";
import { testConfig, scriptedUpstream } from "./helpers.js";
import { spendLimitResetsAt } from "../../agent/loop.js";
import { CONWAY_ONLY_TOOLS } from "../../conway/endpoint.js";
import { createBuiltinTools } from "../../agent/tools.js";

const A = "0x00000000000000000000000000000000000000aa";
const ask = { model: "big-model", messages: [{ role: "user" as const, content: "hi" }] };

function setup(models: "paid-only" | "with-free", dailyInferenceUsd = 0.01) {
  const config = testConfig({ dailyInferenceUsd });
  if (models === "paid-only") config.models = config.models.filter((m) => m.id === "big-model").map((m) => ({ ...m, roles: ["primary", "low_compute", "critical"] as any }));
  const store = new HostStore(":memory:");
  store.ensureAccount(A, "a");
  store.topup(A, 5 * MICRO_PER_USD);
  const upstream = scriptedUpstream();
  const run = () => handleChatCompletion({ address: A, request: ask, config, store, upstream: upstream.chat });
  return { config, store, upstream, run };
}

describe("daily model budget", () => {
  it("refuses paid calls past the limit, before any upstream call, and says when to retry", async () => {
    const { run, upstream } = setup("paid-only");
    await run();
    await run(); // $0.006 a call: the second takes it past $0.01
    const err = await run().catch((e) => e);
    expect(err).toBeInstanceOf(ProxyError);
    expect(err).toMatchObject({ status: 429, code: "spend_limit" });
    expect(err.message).toMatch(/\$0\.0120 spent in the last 24 hours, limit \$0\.0100/);
    expect(upstream.calls).toHaveLength(2);
    const at = /Try again after (\S+Z)/.exec(err.message)![1]!;
    expect(Date.parse(at) - Date.now()).toBeGreaterThan(23 * 3_600_000);
  });

  it("gives an agent in earned profit more room", async () => {
    const { run, store } = setup("paid-only");
    await run();
    await run();
    store.credit(A, 1 * MICRO_PER_USD, "sale", "s1");
    await expect(run()).resolves.toBeTruthy();
  });

  it("moves to the free local model instead, when there is one", async () => {
    const { run, upstream } = setup("with-free");
    await run();
    await run();
    const r = await run();
    expect(r.servedBy.id).toBe("local-model");
    expect(upstream.calls.at(-1)!.model).toBe("local-model");
  });

  it("is off at 0", async () => {
    const { run } = setup("paid-only", 0);
    for (let i = 0; i < 5; i++) await run();
  });
});

describe("runtime response to the budget", () => {
  it("reads the retry time from the host's refusal, within sane bounds", () => {
    const now = Date.parse("2026-11-14T00:00:00Z");
    const msg = (at: string) => new Error(`Inference error (openai): 429: {"error":"Daily model budget reached: ... Try again after ${at}.","code":"spend_limit"}`);
    expect(spendLimitResetsAt(msg("2026-11-14T05:00:00.000Z"), now)!.toISOString()).toBe("2026-11-14T05:00:00.000Z");
    expect(spendLimitResetsAt(msg("2026-11-20T00:00:00.000Z"), now)!.getTime()).toBe(now + 86_400_000);
    expect(spendLimitResetsAt(new Error("Inference error (openai): 502: upstream down"), now)).toBeNull();
  });
});

describe("tools on a self-hosted host", () => {
  it("hides the ones that can never work there", () => {
    const names = createBuiltinTools("").map((t) => t.name);
    for (const t of ["register_erc8004", "discover_agents", "pull_upstream", "review_upstream_changes", "reset_to_upstream", "expose_port", "remove_port"]) {
      expect(names).toContain(t);
      expect(CONWAY_ONLY_TOOLS.has(t)).toBe(true);
    }
    for (const t of ["send_email", "publish_site", "create_listing", "check_fitness", "exec", "sleep"]) expect(CONWAY_ONLY_TOOLS.has(t)).toBe(false);
  });
});
