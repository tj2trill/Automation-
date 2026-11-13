/**
 * Control plane: ledger arithmetic, auth storage, and the metered inference proxy.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  AccountFrozenError,
  HostStore,
  InsufficientFundsError,
  MICRO_PER_CENT,
  MICRO_PER_USD,
  formatUsd,
  microToCents,
  normalizeAddress,
} from "../../host/store.js";
import { costMicro, handleChatCompletion, isFree, ProxyError, resolveModel } from "../../host/inference-proxy.js";
import { modelForRole, validateHostConfig } from "../../host/config.js";
import { billCompute } from "../../host/server.js";
import { scriptedUpstream, testConfig } from "./helpers.js";

const A = "0x" + "a".repeat(40);
const B = "0x" + "b".repeat(40);

describe("ledger", () => {
  let store: HostStore;
  beforeEach(() => {
    store = new HostStore(":memory:");
  });
  afterEach(() => store.close());

  it("starts every account at zero", () => {
    expect(store.getBalanceMicro(A)).toBe(0);
    store.ensureAccount(A, "alpha");
    expect(store.getBalanceMicro(A)).toBe(0);
    expect(store.findAccountByLabel("alpha")).toBe(A);
  });

  it("treats addresses case-insensitively", () => {
    const mixed = "0x" + "AbCd".repeat(10);
    store.topup(mixed, 5 * MICRO_PER_USD);
    expect(store.getBalanceMicro(mixed.toLowerCase())).toBe(5 * MICRO_PER_USD);
    expect(normalizeAddress(mixed)).toBe(mixed.toLowerCase());
  });

  it("top-up adds funds and writes a ledger row", () => {
    const e = store.topup(A, 5 * MICRO_PER_USD, "first");
    expect(e.balanceAfterMicro).toBe(5 * MICRO_PER_USD);
    expect(store.getLedger(A)).toHaveLength(1);
    expect(store.getLedger(A)[0]).toMatchObject({ kind: "topup", deltaMicro: 5 * MICRO_PER_USD, note: "first" });
  });

  it("rejects zero, negative and fractional top-ups", () => {
    expect(() => store.topup(A, 0)).toThrow();
    expect(() => store.topup(A, -5)).toThrow();
    expect(() => store.topup(A, 1.5)).toThrow(/safe integer/);
    expect(store.getBalanceMicro(A)).toBe(0);
  });

  it("charges usage after the fact, even into a negative balance", () => {
    store.topup(A, 100);
    store.charge(A, 250, "inference", "u1");
    expect(store.getBalanceMicro(A)).toBe(-150);
    expect(store.charge(A, 0, "inference")).toBeNull();
  });

  it("canSpend refuses empty and frozen accounts", () => {
    expect(store.canSpend(A)).toMatchObject({ ok: false, reason: "insufficient" });
    store.topup(A, 10);
    expect(store.canSpend(A)).toEqual({ ok: true });
    store.setFrozen(A, true);
    expect(store.canSpend(A)).toMatchObject({ ok: false, reason: "frozen" });
    store.setFrozen(A, false);
    expect(store.canSpend(A)).toEqual({ ok: true });
  });

  it("transfers move the exact amount and record both sides", () => {
    store.topup(A, 10 * MICRO_PER_USD);
    const r = store.transfer(A, B, 3 * MICRO_PER_USD);
    expect(r.balanceAfterMicro).toBe(7 * MICRO_PER_USD);
    expect(store.getBalanceMicro(B)).toBe(3 * MICRO_PER_USD);
    const out = store.getLedger(A).find((e) => e.kind === "transfer_out")!;
    const into = store.getLedger(B).find((e) => e.kind === "transfer_in")!;
    expect(out.ref).toBe(r.transferId);
    expect(into.ref).toBe(r.transferId);
  });

  it("refuses overdraft, self-transfer, bad amounts and frozen senders, changing nothing", () => {
    store.topup(A, 100);
    expect(() => store.transfer(A, B, 101)).toThrow(InsufficientFundsError);
    expect(() => store.transfer(A, A, 10)).toThrow(/self/);
    expect(() => store.transfer(A, B, 0)).toThrow();
    expect(() => store.transfer(A, B, -5)).toThrow();
    expect(() => store.transfer(A, B, 1.5)).toThrow();
    store.setFrozen(A, true);
    expect(() => store.transfer(A, B, 10)).toThrow(AccountFrozenError);
    expect(store.getBalanceMicro(A)).toBe(100);
    expect(store.getBalanceMicro(B)).toBe(0);
  });

  it("a transfer of the whole balance is allowed", () => {
    store.topup(A, 100);
    store.transfer(A, B, 100);
    expect(store.getBalanceMicro(A)).toBe(0);
  });

  it("audit: balances always equal the ledger sum, and tampering is detected", () => {
    store.topup(A, 1000);
    store.charge(A, 37, "inference");
    store.transfer(A, B, 400);
    store.adjust(B, -50, "correction");
    expect(store.verifyLedger()).toEqual([]);
    store.db.prepare("UPDATE accounts SET balance_micro = balance_micro + 1 WHERE address = ?").run(A);
    expect(store.verifyLedger()).toHaveLength(1);
    expect(store.verifyLedger()[0]!.address).toBe(A);
  });

  it("converts to cents without ever rounding a balance up", () => {
    expect(microToCents(0)).toBe(0);
    expect(microToCents(9_999)).toBe(0); // under a cent reads as 0 (critical), not 1
    expect(microToCents(10_000)).toBe(1);
    expect(microToCents(-1)).toBe(-1); // any debt reads as negative (dead)
    expect(formatUsd(1_234_500)).toBe("$1.2345");
    expect(formatUsd(-500_000)).toBe("-$0.5000");
  });

  it("removed accounts release their name but keep their history", () => {
    store.ensureAccount(A, "scout");
    store.topup(A, 500);
    store.setRemoved(A);
    expect(store.findAccountByLabel("scout")).toBeNull();
    expect(store.isFrozen(A)).toBe(true);
    expect(store.getLedger(A)).toHaveLength(1);
    store.ensureAccount(B, "scout");
    expect(store.findAccountByLabel("scout")).toBe(B);
  });
});

describe("auth storage", () => {
  let store: HostStore;
  beforeEach(() => {
    store = new HostStore(":memory:");
  });
  afterEach(() => store.close());

  it("nonces work exactly once and expire", () => {
    const n = store.createNonce();
    expect(store.consumeNonce(n)).toBe(true);
    expect(store.consumeNonce(n)).toBe(false);
    expect(store.consumeNonce("never-issued")).toBe(false);
    const expired = store.createNonce(-1);
    expect(store.consumeNonce(expired)).toBe(false);
  });

  it("sessions resolve until they expire", () => {
    const t = store.createSession(A);
    expect(store.resolveSession(t)).toBe(A);
    expect(store.resolveSession("atm_s_wrong")).toBeNull();
    expect(store.resolveSession(store.createSession(A, -1))).toBeNull();
  });

  it("stores only a hash of each API key and can revoke", () => {
    const { key, keyPrefix } = store.createApiKey(A, "k");
    expect(key.startsWith(keyPrefix)).toBe(true);
    expect(store.resolveApiKey(key)).toBe(A);
    const dump = JSON.stringify(store.db.prepare("SELECT * FROM api_keys").all());
    expect(dump).not.toContain(key);
    expect(store.revokeApiKeys(A)).toBe(1);
    expect(store.resolveApiKey(key)).toBeNull();
  });

  it("relay: poll is cursor based and unread counts what was not yet delivered", () => {
    const m1 = store.insertMessage({ from: A, to: B, content: "one", signedAt: "t" });
    const m2 = store.insertMessage({ from: A, to: B, content: "two", signedAt: "t" });
    expect(store.countUnread(B)).toBe(2);
    const first = store.pollMessages(B, undefined, 1);
    expect(first.map((m) => m.content)).toEqual(["one"]);
    store.markDelivered(B, first[0]!.id);
    expect(store.countUnread(B)).toBe(1);
    expect(store.pollMessages(B, m1).map((m) => m.id)).toEqual([m2]);
    expect(store.pollMessages(A)).toEqual([]);
    // A stale cursor must not move the delivered mark backwards.
    store.markDelivered(B, m2);
    store.markDelivered(B, m1);
    expect(store.countUnread(B)).toBe(0);
  });
});

describe("host config", () => {
  it("rejects configs that would misbill or leave no primary model", () => {
    const base = testConfig();
    expect(() => validateHostConfig(base)).not.toThrow();
    expect(() => validateHostConfig({ ...base, models: [] })).toThrow(/at least one/);
    expect(() => validateHostConfig({ ...base, models: [{ ...base.models[0]!, inputPerMillionUsd: -1 }] })).toThrow(/non-negative/);
    expect(() => validateHostConfig({ ...base, models: [{ ...base.models[1]! }] })).toThrow(/primary/);
    expect(() => validateHostConfig({ ...base, models: [base.models[0]!, { ...base.models[0]! }] })).toThrow(/duplicate/);
    expect(() => validateHostConfig({ ...base, models: [{ ...base.models[0]!, upstream: "nope" as any }] })).toThrow(/unknown upstream/);
  });

  it("falls back toward the primary model when a role is unassigned", () => {
    const single = testConfig({ models: [testConfig().models[0]!] });
    expect(modelForRole(single, "low_compute").id).toBe("big-model");
    expect(modelForRole(single, "critical").id).toBe("big-model");
    expect(modelForRole(testConfig(), "critical").id).toBe("local-model");
  });
});

describe("inference proxy", () => {
  let store: HostStore;
  const config = testConfig();
  beforeEach(() => {
    store = new HostStore(":memory:");
  });
  afterEach(() => store.close());

  const run = (up: ReturnType<typeof scriptedUpstream>, request: any, cfg = config) =>
    handleChatCompletion({ address: A, request, config: cfg, store, upstream: up.chat });
  const messages = [{ role: "user" as const, content: "hi" }];

  it("maps unknown model names onto configured models", () => {
    expect(resolveModel(config, "big-model").id).toBe("big-model");
    expect(resolveModel(config, "gpt-5.2").id).toBe("big-model");
    expect(resolveModel(config, "gpt-5-mini").id).toBe("local-model");
    expect(resolveModel(config, "claude-haiku-4-5").id).toBe("local-model");
    expect(resolveModel(config, undefined).id).toBe("big-model");
  });

  it("prices tokens exactly: tokens x USD per million = micro-dollars", () => {
    const big = config.models[0]!;
    expect(costMicro(big, 1_000_000, 0)).toBe(3 * MICRO_PER_USD);
    expect(costMicro(big, 1000, 200)).toBe(1000 * 3 + 200 * 15);
    expect(isFree(config.models[1]!)).toBe(true);
    expect(isFree(big)).toBe(false);
  });

  it("charges the caller what the upstream reported and returns an OpenAI-shaped body", async () => {
    store.topup(A, 5 * MICRO_PER_USD);
    const up = scriptedUpstream();
    const r = await run(up, { model: "big-model", messages });
    expect(r.costMicro).toBe(6000);
    expect(store.getBalanceMicro(A)).toBe(5 * MICRO_PER_USD - 6000);
    const body: any = r.body;
    expect(body.object).toBe("chat.completion");
    expect(body.model).toBe("big-model");
    expect(body.choices[0].message.content).toBe("hello from big-model");
    expect(body.usage).toEqual({ prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200 });
    expect(store.getLedger(A)[0]).toMatchObject({ kind: "inference", deltaMicro: -6000 });
    expect(store.verifyLedger()).toEqual([]);
  });

  it("rejects an empty request before calling any model", async () => {
    store.topup(A, MICRO_PER_USD);
    const up = scriptedUpstream();
    await expect(run(up, { model: "big-model", messages: [] })).rejects.toMatchObject({ status: 400 });
    expect(up.calls).toHaveLength(0);
  });

  it("gives a frozen account nothing, not even the free model", async () => {
    store.topup(A, MICRO_PER_USD);
    store.setFrozen(A, true);
    const up = scriptedUpstream();
    await expect(run(up, { model: "local-model", messages })).rejects.toMatchObject({ status: 403, code: "account_frozen" });
    expect(up.calls).toHaveLength(0);
  });

  it("moves a broke account to the free local model instead of spending", async () => {
    const up = scriptedUpstream();
    const r = await run(up, { model: "big-model", messages });
    expect(r.servedBy.id).toBe("local-model");
    expect(up.calls.map((c) => c.model)).toEqual(["local-model"]);
    expect(store.getBalanceMicro(A)).toBe(0);
  });

  it("returns 402 to a broke account when no free model exists", async () => {
    const paidOnly = testConfig({ models: [config.models[0]!] });
    const up = scriptedUpstream();
    await expect(run(up, { model: "big-model", messages }, paidOnly)).rejects.toMatchObject({ status: 402, code: "insufficient_credits" });
    expect(up.calls).toHaveLength(0);
  });

  it("falls back to the local model when the paid upstream is down, and bills the model that answered", async () => {
    store.topup(A, MICRO_PER_USD);
    const up = scriptedUpstream();
    up.failing.set("big-model", new Error("Inference error (openai): 503: overloaded"));
    const r = await run(up, { model: "big-model", messages });
    expect(r.fellBack).toBe(true);
    expect(r.servedBy.id).toBe("local-model");
    expect(up.calls.map((c) => c.model)).toEqual(["big-model", "local-model"]);
    expect(store.getBalanceMicro(A)).toBe(MICRO_PER_USD); // local model is free
    expect((r.body as any).x_automaton.fell_back).toBe(true);
  });

  it("does not retry elsewhere when the request itself is invalid", async () => {
    store.topup(A, MICRO_PER_USD);
    const up = scriptedUpstream();
    up.failing.set("big-model", new Error("Inference error (openai): 400: bad tool schema"));
    await expect(run(up, { model: "big-model", messages })).rejects.toMatchObject({ status: 502 });
    expect(up.calls.map((c) => c.model)).toEqual(["big-model"]);
    expect(store.getBalanceMicro(A)).toBe(MICRO_PER_USD);
  });

  it("reports both failures when the fallback is down too, and charges nothing", async () => {
    store.topup(A, MICRO_PER_USD);
    const up = scriptedUpstream();
    up.failing.set("big-model", new Error("connect ECONNREFUSED"));
    up.failing.set("local-model", new Error("ollama not running"));
    await expect(run(up, { model: "big-model", messages })).rejects.toThrow(/ECONNREFUSED.*ollama not running/);
    expect(store.getBalanceMicro(A)).toBe(MICRO_PER_USD);
  });

  it("surfaces a missing upstream key as a configuration error when there is no fallback", async () => {
    store.topup(A, MICRO_PER_USD);
    const paidOnly = testConfig({ models: [config.models[0]!] });
    const up = scriptedUpstream();
    up.failing.set("big-model", new ProxyError(503, "OPENAI_API_KEY is not set on the host", "upstream_not_configured"));
    await expect(run(up, { model: "big-model", messages }, paidOnly)).rejects.toMatchObject({ status: 503, code: "upstream_not_configured" });
  });

  it("caps max tokens at the model's limit and forwards tools", async () => {
    store.topup(A, MICRO_PER_USD);
    const up = scriptedUpstream();
    const tools = [{ type: "function" as const, function: { name: "t", description: "d", parameters: {} } }];
    await run(up, { model: "local-model", messages, max_tokens: 999_999, tools });
    expect(up.calls[0]).toMatchObject({ model: "local-model", maxTokens: 2048, tools: 1 });
    await run(up, { model: "big-model", messages, max_completion_tokens: 100 });
    expect(up.calls[1]).toMatchObject({ maxTokens: 100, tools: 0 });
  });
});

describe("compute billing", () => {
  let store: HostStore;
  const config = testConfig({ computeUsdPerGbHour: 0.01 });
  const hour = 3_600_000;
  const t0 = Date.parse("2026-01-01T00:00:00Z");
  const sandbox = (owner: string, memoryMb = 1024, status = "running"): string => {
    const id = `SB${Math.random().toString(36).slice(2, 10)}`;
    store.insertSandbox({
      id, owner, occupant: null, name: "s", containerName: "c",
      status, vcpu: 1, memoryMb, diskGb: 5, createdAt: new Date(t0).toISOString(), lastBilledAt: new Date(t0).toISOString(),
    });
    return id;
  };
  beforeEach(() => {
    store = new HostStore(":memory:");
  });
  afterEach(() => store.close());

  it("bills memory-hours to the sandbox owner", () => {
    store.topup(A, MICRO_PER_USD);
    sandbox(A, 1024);
    sandbox(A, 512);
    expect(billCompute(store, config, t0 + hour)).toBe(10_000 + 5_000);
    expect(store.getBalanceMicro(A)).toBe(MICRO_PER_USD - 15_000);
    expect(billCompute(store, config, t0 + hour)).toBe(0); // same instant: nothing new
  });

  it("does not lose time to rounding when billed in short intervals", () => {
    store.topup(A, MICRO_PER_USD);
    sandbox(A, 1024);
    let total = 0;
    for (let i = 1; i <= 3600; i++) total += billCompute(store, config, t0 + i * 1000, { minPeriodMs: 0 });
    expect(total).toBeGreaterThan(9_900);
    expect(total).toBeLessThanOrEqual(10_000);
  });

  it("writes at most one ledger row per minute however often it is called", () => {
    store.topup(A, MICRO_PER_USD);
    const sb = sandbox(A, 1024);
    let total = 0;
    // A dashboard refreshing every second for an hour.
    for (let i = 1; i <= 3600; i++) total += billCompute(store, config, t0 + i * 1000);
    const rows = store.getLedger(A, 10_000).filter((e) => e.kind === "compute");
    expect(rows.length).toBeLessThanOrEqual(60);
    expect(rows.length).toBeGreaterThanOrEqual(58);
    expect(rows.every((e) => Math.abs(e.deltaMicro) >= 160)).toBe(true);
    expect(total).toBeGreaterThan(9_800);
    expect(total).toBeLessThanOrEqual(10_000);

    // 30 more seconds: too short for a routine row, collected by the final bill.
    expect(billCompute(store, config, t0 + 3_630_000)).toBe(0);
    const final = billCompute(store, config, t0 + 3_630_000, { minPeriodMs: 0, sandboxId: sb });
    expect(final).toBeGreaterThan(0);
    expect(total + final).toBeGreaterThan(10_070);
    expect(total + final).toBeLessThanOrEqual(10_084);
    expect(store.verifyLedger()).toEqual([]);
  });

  it("bills only the named sandbox when asked", () => {
    store.topup(A, MICRO_PER_USD);
    store.topup(B, MICRO_PER_USD);
    const mine = sandbox(A, 1024);
    sandbox(B, 1024);
    billCompute(store, config, t0 + hour, { minPeriodMs: 0, sandboxId: mine });
    expect(store.getBalanceMicro(A)).toBe(MICRO_PER_USD - 10_000);
    expect(store.getBalanceMicro(B)).toBe(MICRO_PER_USD);
  });

  it("never pushes a balance below zero and skips stopped or unowned sandboxes", () => {
    store.topup(A, 3_000);
    sandbox(A, 1024);
    sandbox(B, 1024, "stopped");
    sandbox("pending", 1024);
    billCompute(store, config, t0 + hour);
    expect(store.getBalanceMicro(A)).toBe(0);
    expect(store.getBalanceMicro(B)).toBe(0);
    billCompute(store, config, t0 + 5 * hour);
    expect(store.getBalanceMicro(A)).toBe(0);
    expect(store.verifyLedger()).toEqual([]);
  });
});

it("cents and micro-dollars agree", () => {
  expect(MICRO_PER_CENT * 100).toBe(MICRO_PER_USD);
});
