/**
 * The economy: agents earn from jobs and customer payments, reproduce only on
 * earned profit, and die permanently when they run out of money.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { SiweMessage } from "siwe";
import { HostAdmin } from "../../host/admin.js";
import { DEFAULT_HOST_CONFIG } from "../../host/config.js";
import { Economy, formEncode, type FetchLike } from "../../host/economy.js";
import { claimOccupancy, createSandbox } from "../../host/server.js";
import { AccountDeadError, HOST_NOTICE_SENDER, MICRO_PER_USD } from "../../host/store.js";
import { syncIncome, summariseIncome } from "../../memory/outcomes.js";
import { createTestDb } from "../mocks.js";
import { call, signIn, startTestHost, type TestHost } from "./helpers.js";

const usd = (n: number) => Math.round(n * MICRO_PER_USD);

/** An agent living in its own container, with an API key, as the runtime would be. */
async function agent(h: TestHost, name: string, fundUsd = 0) {
  const who = await signIn(h.url);
  const sb = await createSandbox(
    { config: h.config, store: h.store, driver: h.driver, containerHostUrl: "http://automaton-host:4820" },
    { owner: who.address, name },
  );
  h.store.updateSandbox(sb.id, { occupant: who.address });
  h.store.ensureAccount(who.address, name);
  if (fundUsd > 0) h.store.topup(who.address, usd(fundUsd), "test funding");
  return { ...who, sandbox: sb };
}

describe("economy: jobs", () => {
  let h: TestHost;
  beforeEach(async () => {
    h = await startTestHost();
  });
  afterEach(async () => h.close());

  it("validates a job before posting it", () => {
    const e = h.economy;
    expect(() => e.postJob({ title: "", description: "d", rewardUsd: 1, check: "answer-is 4" })).toThrow(/title/);
    expect(() => e.postJob({ title: "t", description: "", rewardUsd: 1, check: "answer-is 4" })).toThrow(/description/);
    expect(() => e.postJob({ title: "t", description: "d", rewardUsd: 0, check: "answer-is 4" })).toThrow(/Reward/);
    expect(() => e.postJob({ title: "t", description: "d", rewardUsd: 1, check: "" })).toThrow(/check/);
    expect(() => e.postJob({ title: "t", description: "d", rewardUsd: 1, check: "x", maxAttempts: 0 })).toThrow(/Attempts/);
    expect(() => e.postJob({ title: "t", description: "d", rewardUsd: 1, check: "x", deadlineHours: -1 })).toThrow(/Deadline/);
    const job = e.postJob({ title: "Add", description: "What is 2+2?", rewardUsd: 1.5, check: "answer-is 4" });
    expect(job).toMatchObject({ status: "open", rewardMicro: usd(1.5), maxAttempts: 3 });
  });

  it("pays the first passing answer once, counts attempts, and closes the job", async () => {
    const a = await agent(h, "alpha");
    const b = await agent(h, "beta");
    const job = h.economy.postJob({ title: "Add", description: "2+2", rewardUsd: 2, check: "answer-is 4", maxAttempts: 2 });

    const listed = await call(h.url, "GET", "/v1/jobs", a.apiKey);
    expect(listed.status).toBe(200);
    expect(listed.json.jobs).toHaveLength(1);
    expect(listed.json.jobs[0]).toMatchObject({ id: job.id, reward_micro_usd: usd(2), check: "answer-is 4", attempts_used: 0 });

    const wrong = await call(h.url, "POST", `/v1/jobs/${job.id}/submit`, a.apiKey, { content: "5" });
    expect(wrong.json).toMatchObject({ passed: false, paid_micro_usd: 0, attempts_left: 1 });
    // The check's own output may reveal the expected answer, so it is not returned.
    expect(JSON.stringify(wrong.json)).not.toContain("expected");

    const right = await call(h.url, "POST", `/v1/jobs/${job.id}/submit`, a.apiKey, { content: "4\n" });
    expect(right.json).toMatchObject({ passed: true, paid_micro_usd: usd(2) });
    expect(h.store.getBalanceMicro(a.address)).toBe(usd(2));
    expect(h.store.getLedger(a.address)[0]).toMatchObject({ kind: "job_reward", ref: job.id, deltaMicro: usd(2) });

    const late = await call(h.url, "POST", `/v1/jobs/${job.id}/submit`, b.apiKey, { content: "4" });
    expect(late.status).toBe(409);
    expect(h.store.getBalanceMicro(b.address)).toBe(0);

    const out = await call(h.url, "POST", `/v1/jobs/${job.id}/submit`, a.apiKey, { content: "4" });
    expect(out.status).toBe(409);
    expect(h.economy.getJob(job.id)).toMatchObject({ status: "paid", winner: a.address });
    expect(h.store.verifyLedger()).toEqual([]);
  });

  it("refuses more attempts than the job allows, even when sent at once", async () => {
    const a = await agent(h, "alpha");
    const job = h.economy.postJob({ title: "Add", description: "2+2", rewardUsd: 1, check: "answer-is 4", maxAttempts: 2 });
    h.driver.checkDelayMs = 50;
    const results = await Promise.all(
      [1, 2, 3, 4].map(() => call(h.url, "POST", `/v1/jobs/${job.id}/submit`, a.apiKey, { content: "nope" })),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(2);
    expect(results.filter((r) => r.status === 429)).toHaveLength(2);
    expect(h.economy.attemptsUsed(job.id, a.address)).toBe(2);
  });

  it("pays only one of two agents that pass at the same moment", async () => {
    const a = await agent(h, "alpha");
    const b = await agent(h, "beta");
    const job = h.economy.postJob({ title: "Add", description: "2+2", rewardUsd: 3, check: "answer-is 4" });
    h.driver.checkDelayMs = 50;
    const [ra, rb] = await Promise.all([
      call(h.url, "POST", `/v1/jobs/${job.id}/submit`, a.apiKey, { content: "4" }),
      call(h.url, "POST", `/v1/jobs/${job.id}/submit`, b.apiKey, { content: "4" }),
    ]);
    const paid = [ra, rb].map((r) => r.json.paid_micro_usd);
    expect(paid.sort()).toEqual([0, usd(3)]);
    expect(h.store.getBalanceMicro(a.address) + h.store.getBalanceMicro(b.address)).toBe(usd(3));
  });

  it("runs the check in a fresh container with no network, then deletes it", async () => {
    const a = await agent(h, "alpha");
    const job = h.economy.postJob({ title: "Add", description: "2+2", rewardUsd: 1, check: "answer-is 4" });
    const before = h.driver.containers.size;
    await call(h.url, "POST", `/v1/jobs/${job.id}/submit`, a.apiKey, { content: "4" });
    const checkBox = h.driver.created.find((c) => c.labels["automaton.check"] === job.id)!;
    expect(checkBox.noNetwork).toBe(true);
    expect(checkBox.env).toEqual({});
    expect(h.driver.containers.has(checkBox.containerName)).toBe(false);
    expect(h.driver.containers.size).toBe(before);
  });

  it("treats a check that cannot start as a failed attempt", async () => {
    const a = await agent(h, "alpha");
    const job = h.economy.postJob({ title: "Add", description: "2+2", rewardUsd: 1, check: "answer-is 4" });
    h.driver.images.clear();
    h.driver.create = async () => {
      throw new Error("no such image");
    };
    const r = await call(h.url, "POST", `/v1/jobs/${job.id}/submit`, a.apiKey, { content: "4" });
    expect(r.json.passed).toBe(false);
    expect(h.economy.listSubmissions(job.id)[0]).toMatchObject({ passed: false, exitCode: 125 });
  });

  it("closes jobs after their deadline and lets the creator cancel", async () => {
    const a = await agent(h, "alpha");
    const late = h.economy.postJob({ title: "Late", description: "x", rewardUsd: 1, check: "answer-is 4", deadlineHours: 1 });
    h.economy.expireJobs(Date.now() + 2 * 3_600_000);
    expect(h.economy.getJob(late.id)!.status).toBe("expired");
    expect((await call(h.url, "POST", `/v1/jobs/${late.id}/submit`, a.apiKey, { content: "4" })).status).toBe(409);

    const c = h.economy.postJob({ title: "C", description: "x", rewardUsd: 1, check: "answer-is 4" });
    h.economy.cancelJob(c.id);
    expect(() => h.economy.cancelJob(c.id)).toThrow(/already cancelled/);
    expect((await call(h.url, "POST", `/v1/jobs/${c.id}/submit`, a.apiKey, { content: "4" })).status).toBe(409);
  });

  it("rejects oversized answers and unknown jobs", async () => {
    const a = await agent(h, "alpha");
    const job = h.economy.postJob({ title: "Add", description: "2+2", rewardUsd: 1, check: "answer-is 4" });
    expect((await call(h.url, "POST", `/v1/jobs/${job.id}/submit`, a.apiKey, { content: "x".repeat(300 * 1024) })).status).toBe(413);
    expect((await call(h.url, "POST", `/v1/jobs/${job.id}/submit`, a.apiKey, {})).status).toBe(400);
    expect((await call(h.url, "POST", "/v1/jobs/01J00000000000000000000000/submit", a.apiKey, { content: "4" })).status).toBe(404);
    expect((await call(h.url, "GET", "/v1/jobs")).status).toBe(401);
  });
});

describe("economy: reproduction", () => {
  let h: TestHost;
  beforeEach(async () => {
    h = await startTestHost({ selection: { spawnProfitUsd: 1, deathGraceMinutes: 60 } });
  });
  afterEach(async () => h.close());

  it("refuses a child until the agent has earned profit, and raises the bar per child", async () => {
    const a = await agent(h, "alpha", 20);
    const refused = await call(h.url, "POST", "/v1/sandboxes", a.apiKey, { name: "kid" });
    expect(refused.status).toBe(403);
    expect(refused.json.code).toBe("not_fit_to_reproduce");
    expect(refused.json.error).toMatch(/Funding and transfers do not count/);

    // Money from other agents is not earning.
    const rich = await agent(h, "rich", 50);
    h.store.transfer(rich.address, a.address, usd(10));
    expect((await call(h.url, "POST", "/v1/sandboxes", a.apiKey, { name: "kid" })).status).toBe(403);

    // Spending counts against profit.
    h.store.charge(a.address, usd(0.5), "inference");
    const job = h.economy.postJob({ title: "J", description: "x", rewardUsd: 1.4, check: "answer-is ok" });
    await call(h.url, "POST", `/v1/jobs/${job.id}/submit`, a.apiKey, { content: "ok" });
    const still = await call(h.url, "GET", "/v1/selection", a.apiKey);
    expect(still.json).toMatchObject({ earned_micro_usd: usd(1.4), spent_micro_usd: usd(0.5), profit_micro_usd: usd(0.9), can_reproduce: false });

    const job2 = h.economy.postJob({ title: "J2", description: "x", rewardUsd: 0.1, check: "answer-is ok" });
    await call(h.url, "POST", `/v1/jobs/${job2.id}/submit`, a.apiKey, { content: "ok" });
    const first = await call(h.url, "POST", "/v1/sandboxes", a.apiKey, { name: "kid1" });
    expect(first.status).toBe(201);

    const sel = await call(h.url, "GET", "/v1/selection", a.apiKey);
    expect(sel.json).toMatchObject({ children: 1, can_reproduce: false, next_child_requires_micro_usd: usd(2) });
    expect((await call(h.url, "POST", "/v1/sandboxes", a.apiKey, { name: "kid2" })).status).toBe(403);

    // Deleting an empty child container does not refund the slot... unless no child ever lived in it.
    await call(h.url, "DELETE", `/v1/sandboxes/${first.json.id}`, a.apiKey);
    expect((await call(h.url, "GET", "/v1/selection", a.apiKey)).json.children).toBe(0);
  });

  it("turns the rule off at zero", async () => {
    const t = await startTestHost({ selection: { spawnProfitUsd: 0, deathGraceMinutes: 60 } });
    try {
      const a = await agent(t, "alpha", 5);
      t.store.charge(a.address, usd(1), "inference");
      expect((await call(t.url, "POST", "/v1/sandboxes", a.apiKey, { name: "kid" })).status).toBe(201);
    } finally {
      await t.close();
    }
  });

  it("counts a child that came alive even after its container is gone", async () => {
    const a = await agent(h, "alpha");
    h.store.credit(a.address, usd(1), "sale", "pay-1");
    const first = await call(h.url, "POST", "/v1/sandboxes", a.apiKey, { name: "kid1" });
    const kid = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
    h.store.updateSandbox(first.json.id, { occupant: kid });
    await call(h.url, "DELETE", `/v1/sandboxes/${first.json.id}`, a.apiKey);
    expect((await call(h.url, "GET", "/v1/selection", a.apiKey)).json.children).toBe(1);
  });

  it("records the parent of an agent that signs in from a container its parent paid for", async () => {
    const a = await agent(h, "alpha");
    h.store.credit(a.address, usd(1), "sale", "pay-2");
    const sb = (await call(h.url, "POST", "/v1/sandboxes", a.apiKey, { name: "kid" })).json;
    // Pretend the request comes from inside the child container.
    const row = h.store.getSandbox(sb.id)!;
    const container = h.driver.containers.get(row.containerName)!;
    const kidKey = generatePrivateKey();
    const kidAddr = privateKeyToAccount(kidKey).address.toLowerCase();
    // Sign-in from the container's address is how the server learns who lives there.
    h.store.ensureAccount(kidAddr, "kid");
    await claimOccupancy({ config: h.config, store: h.store, driver: h.driver, upstream: h.upstream.chat, containerHostUrl: "", economy: h.economy }, container.ip, kidAddr);
    expect(h.store.getSandbox(sb.id)!.occupant).toBe(kidAddr);
    expect(h.economy.parentOf(kidAddr)).toBe(a.address);
    const st = h.economy.standings().find((s) => s.address === kidAddr)!;
    expect(st.generation).toBe(2);
    expect(h.economy.standings().find((s) => s.address === a.address)!.children).toBe(1);
  });
});

describe("economy: death", () => {
  let h: TestHost;
  beforeEach(async () => {
    h = await startTestHost({ selection: { spawnProfitUsd: 1, deathGraceMinutes: 30 } });
  });
  afterEach(async () => h.close());

  it("starves an agent at $0, kills it after the grace period, and never lets it back", async () => {
    const a = await agent(h, "alpha", 1);
    const t0 = Date.now();
    expect(await h.economy.reap(t0)).toEqual([]);
    h.store.charge(a.address, usd(1), "inference");
    expect(await h.economy.reap(t0)).toEqual([]);
    const st = h.economy.standings(t0).find((s) => s.address === a.address)!;
    expect(st.starvingSince).not.toBeNull();
    expect((await call(h.url, "GET", "/v1/selection", a.apiKey)).json.dies_at).toBeTruthy();

    expect(await h.economy.reap(t0 + 29 * 60_000)).toEqual([]);
    expect(await h.economy.reap(t0 + 31 * 60_000)).toEqual([a.address]);

    expect(h.store.isDead(a.address)).toBe(true);
    expect(h.driver.containers.has(a.sandbox.containerName)).toBe(false);
    expect(h.store.getSandbox(a.sandbox.id)!.status).toBe("deleted");
    expect((await call(h.url, "GET", "/v1/jobs", a.apiKey)).status).toBe(401);
    expect(() => h.store.topup(a.address, usd(5))).toThrow(AccountDeadError);
    expect(() => h.store.credit(a.address, usd(5), "sale", "late")).toThrow(AccountDeadError);
    const other = await agent(h, "other", 5);
    expect(() => h.store.transfer(other.address, a.address, usd(1))).toThrow(AccountDeadError);
    const viaApi = await call(h.url, "POST", "/v1/credits/transfer", other.apiKey, { to_address: a.address, amount_cents: 10 });
    expect(viaApi.status).toBe(403);

    // Signing in again with the dead agent's own key is refused.
    const nonce = (await call(h.url, "POST", "/v1/auth/nonce")).json.nonce;
    const message = new SiweMessage({
      domain: new URL(h.url).host, address: a.account.address, statement: "x", uri: `${h.url}/v1/auth/verify`,
      version: "1", chainId: 8453, nonce, issuedAt: new Date().toISOString(),
    }).prepareMessage();
    const signature = await a.account.signMessage({ message });
    expect((await call(h.url, "POST", "/v1/auth/verify", undefined, { message, signature })).status).toBe(403);

    const dead = h.economy.standings().find((s) => s.address === a.address)!;
    expect(dead.alive).toBe(false);
    expect(dead.death!.reason).toBe("ran out of money");
    expect(h.store.verifyLedger()).toEqual([]);
  });

  it("forgives starvation when money arrives in time", async () => {
    const a = await agent(h, "alpha");
    const t0 = Date.now();
    await h.economy.reap(t0);
    h.store.credit(a.address, usd(0.01), "job_reward", "j1");
    expect(await h.economy.reap(t0 + 60 * 60_000)).toEqual([]);
    expect(h.economy.standings().find((s) => s.address === a.address)!.starvingSince).toBeNull();
  });

  it("leaves a dead parent's children alive and paying for themselves", async () => {
    const a = await agent(h, "alpha");
    h.store.credit(a.address, usd(1), "sale", "s1");
    const sb = (await call(h.url, "POST", "/v1/sandboxes", a.apiKey, { name: "kid" })).json;
    const empty = (await (async () => {
      h.store.credit(a.address, usd(1.5), "sale", "s2");
      return (await call(h.url, "POST", "/v1/sandboxes", a.apiKey, { name: "never-started" })).json;
    })());
    const kid = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
    h.store.updateSandbox(sb.id, { occupant: kid });
    h.economy.recordLineage(kid, a.address);
    h.store.topup(kid, usd(1));

    await h.economy.die(a.address, "test");
    expect(h.store.getSandbox(sb.id)).toMatchObject({ status: "running", owner: kid });
    expect(h.store.getSandbox(empty.id)!.status).toBe("deleted");
    expect(h.store.isDead(kid)).toBe(false);
    expect(h.economy.standings().find((s) => s.address === kid)).toMatchObject({ alive: true, parent: a.address });
  });

  it("never kills the creator or an account with no container", async () => {
    const creator = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
    const e = new Economy(h.config, h.store, h.driver, { creatorAddress: creator });
    h.store.ensureAccount(creator, "creator");
    const loose = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
    h.store.ensureAccount(loose);
    await e.reap(Date.now());
    expect(await e.reap(Date.now() + 10 * 3_600_000)).toEqual([]);
    await expect(e.die(creator, "x")).rejects.toThrow(/creator/);
  });

  it("the server's timer runs the economy", async () => {
    const t = await startTestHost({ selection: { spawnProfitUsd: 1, deathGraceMinutes: 0 } });
    try {
      const a = await agent(t, "alpha");
      await t.economy.tick();
      expect(t.store.isDead(a.address)).toBe(true);
    } finally {
      await t.close();
    }
  });
});

describe("economy: earn or die", () => {
  const DAY = 86_400_000;
  let h: TestHost;
  beforeEach(async () => {
    h = await startTestHost({ selection: { spawnProfitUsd: 1, deathGraceMinutes: 60, mustEarnAfterDays: 14 } });
  });
  afterEach(async () => h.close());
  const notices = (a: string) =>
    (h.store.db.prepare("SELECT from_addr, content FROM messages WHERE to_addr = ? ORDER BY id").all(a) as any[])
      .filter((m) => m.from_addr === HOST_NOTICE_SENDER)
      .map((m) => m.content as string);

  it("kills a funded agent that never earned once its starting period is over, and funding cannot save it", async () => {
    const a = await agent(h, "idler", 50);
    const t0 = Date.now();
    await h.economy.reap(t0);
    const born = h.economy.standings(t0).find((s) => s.address === a.address)!;
    expect(Date.parse(born.mustEarnBy!)).toBe(t0 + 14 * DAY);
    h.store.charge(a.address, usd(2), "inference");

    // Alive on its starting money for the whole period.
    expect(await h.economy.reap(t0 + 14 * DAY - 1)).toEqual([]);
    expect(h.economy.standings().find((s) => s.address === a.address)!.starvingSince).toBeNull();

    // Period over, $48 still in the bank, no earned profit: it starves.
    expect(await h.economy.reap(t0 + 14 * DAY)).toEqual([]);
    const st = h.economy.standings().find((s) => s.address === a.address)!;
    expect(st.starvingReason).toBe("not earning");
    expect(st.balanceMicro).toBe(usd(48));
    const sel = (await call(h.url, "GET", "/v1/selection", a.apiKey)).json;
    expect(sel).toMatchObject({ starving_reason: "not earning", must_earn_after_days: 14 });
    expect(sel.dies_at).toBeTruthy();
    expect(notices(a.address).at(-1)).toMatch(/deleted permanently .* Funding and transfers cannot save you/);

    // More funding and a transfer change nothing.
    h.store.topup(a.address, usd(100), "rescue");
    const friend = await agent(h, "friend", 10);
    h.store.transfer(friend.address, a.address, usd(5));
    expect(await h.economy.reap(t0 + 14 * DAY + 61 * 60_000)).toContain(a.address);
    expect(h.store.isDead(a.address)).toBe(true);
    expect(h.economy.standings().find((s) => s.address === a.address)!.death!.reason).toBe("did not earn its keep in its starting period");
    expect(h.store.verifyLedger()).toEqual([]);
  });

  it("lets an agent in earned profit live on it, and kills it once its costs have used the profit up", async () => {
    const a = await agent(h, "seller", 5);
    const t0 = Date.now();
    await h.economy.reap(t0);
    h.store.charge(a.address, usd(1), "inference");
    h.store.credit(a.address, usd(3), "sale", "s1");
    expect(await h.economy.reap(t0 + 30 * DAY)).toEqual([]);
    expect(h.economy.standings().find((s) => s.address === a.address)!.starvingSince).toBeNull();

    // Spending eats the surplus; the $5 of funding it still holds does not count.
    h.store.charge(a.address, usd(2), "compute");
    await h.economy.reap(t0 + 31 * DAY);
    expect(h.economy.standings().find((s) => s.address === a.address)!.starvingReason).toBe("not earning");
    expect(h.store.getBalanceMicro(a.address)).toBe(usd(5));
    expect(await h.economy.reap(t0 + 31 * DAY + 60 * 60_000)).toEqual([a.address]);
  });

  it("forgives a starving agent when a sale lands within the grace period", async () => {
    const a = await agent(h, "late", 5);
    const t0 = Date.now();
    await h.economy.reap(t0);
    h.store.charge(a.address, usd(0.5), "inference");
    await h.economy.reap(t0 + 14 * DAY);
    expect(h.economy.standings().find((s) => s.address === a.address)!.starvingSince).not.toBeNull();
    h.store.credit(a.address, usd(1), "sale", "s1");
    expect(await h.economy.reap(t0 + 14 * DAY + 2 * 60 * 60_000)).toEqual([]);
    expect(h.economy.standings().find((s) => s.address === a.address)!.starvingSince).toBeNull();
  });

  it("warns an agent with no earned profit three days and one day ahead, once each", async () => {
    const a = await agent(h, "warned", 5);
    const t0 = Date.now();
    await h.economy.reap(t0);
    expect(notices(a.address)).toEqual([]);
    await h.economy.reap(t0 + 11 * DAY);
    await h.economy.reap(t0 + 11 * DAY + 60_000);
    expect(notices(a.address)).toHaveLength(1);
    expect(notices(a.address)[0]).toMatch(/^Earn or die: by .* you must have earned more than you have cost/);
    await h.economy.reap(t0 + 13 * DAY);
    await h.economy.reap(t0 + 13 * DAY + 60_000);
    expect(notices(a.address)).toHaveLength(2);

    // An agent already in profit is not nagged.
    const b = await agent(h, "earner", 5);
    h.store.credit(b.address, usd(1), "job_reward", "j1");
    await h.economy.reap(t0);
    await h.economy.reap(t0 + 13 * DAY);
    expect(notices(b.address)).toEqual([]);
  });

  it("does not judge a frozen agent, and can be turned off", async () => {
    const a = await agent(h, "frozen", 5);
    const t0 = Date.now();
    await h.economy.reap(t0);
    h.store.setFrozen(a.address, true);
    expect(await h.economy.reap(t0 + 20 * DAY)).toEqual([]);
    expect(h.economy.standings().find((s) => s.address === a.address)!.starvingSince).toBeNull();

    const off = await startTestHost({ selection: { spawnProfitUsd: 1, deathGraceMinutes: 0, mustEarnAfterDays: 0 } });
    try {
      const b = await agent(off, "free", 5);
      await off.economy.reap(t0);
      expect(await off.economy.reap(t0 + 365 * DAY)).toEqual([]);
      expect(off.economy.standings().find((s) => s.address === b.address)!.mustEarnBy).toBeNull();
    } finally {
      await off.close();
    }
  });

  it("tells the agent, through check_fitness, the date it must earn by and why it is starving", async () => {
    const { createBuiltinTools } = await import("../../agent/tools.js");
    const { createConwayClient } = await import("../../conway/client.js");
    const { trustInsecureOrigin, clearTrustedInsecureOrigins } = await import("../../conway/endpoint.js");
    trustInsecureOrigin(h.url);
    try {
      const a = await agent(h, "reader", 5);
      const conway = createConwayClient({ apiUrl: h.url, apiKey: a.apiKey, sandboxId: "" });
      const fitness = () => new Map(createBuiltinTools("").map((t) => [t.name, t])).get("check_fitness")!.execute({}, { conway } as any);
      const t0 = Date.now();
      // No reaper pass yet: a newborn agent still sees its deadline on its first turn.
      h.store.charge(a.address, usd(0.25), "inference");
      expect(await fitness()).toMatch(/EARN OR DIE: by \S+ you must have earned more than you have cost \(more than \$0\.2500 so far\)/);
      await h.economy.reap(t0 + 14 * 86_400_000 + 60_000);
      expect(await fitness()).toMatch(/WARNING: your starting period is over .* Funding and transfers cannot save you\./);
    } finally {
      clearTrustedInsecureOrigins();
    }
  });

  it("starts the period when the host first sees an agent, so a child gets its own", async () => {
    const parent = await agent(h, "parent", 5);
    const t0 = Date.now();
    await h.economy.reap(t0);
    const kid = await agent(h, "kid", 1);
    h.economy.recordLineage(kid.address, parent.address);
    await h.economy.reap(t0 + 10 * DAY);
    expect(Date.parse(h.economy.standings().find((s) => s.address === kid.address)!.mustEarnBy!)).toBe(t0 + 24 * DAY);
  });
});

describe("economy: Stripe", () => {
  function fakeStripe() {
    const calls: Array<{ url: string; method?: string; body?: string; auth?: string }> = [];
    const sessions = new Map<string, any>();
    let n = 0;
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, method: init?.method, body: init?.body, auth: init?.headers?.Authorization });
      if (init?.method === "POST" && url.endsWith("/v1/checkout/sessions")) {
        const id = `cs_test_${++n}`;
        const params = new URLSearchParams(init.body);
        const s = { id, url: `https://checkout.stripe.com/c/pay/${id}`, status: "open", payment_status: "unpaid", amount_total: Number(params.get("line_items[0][price_data][unit_amount]")) };
        sessions.set(id, s);
        return { ok: true, status: 200, json: async () => s };
      }
      const m = /\/v1\/checkout\/sessions\/([^/?]+)$/.exec(url);
      if (m && sessions.has(decodeURIComponent(m[1]!))) return { ok: true, status: 200, json: async () => sessions.get(decodeURIComponent(m[1]!)) };
      return { ok: false, status: 404, json: async () => ({ error: { message: "No such session" } }) };
    };
    return { fetchImpl, calls, sessions };
  }

  it("is off without a key", async () => {
    const h = await startTestHost();
    try {
      const a = await agent(h, "alpha");
      const r = await call(h.url, "POST", "/v1/payments", a.apiKey, { amount_cents: 500, description: "Report" });
      expect(r.status).toBe(503);
      expect(r.json.code).toBe("stripe_disabled");
      expect((await call(h.url, "GET", "/v1/payments", a.apiKey)).json.stripe_enabled).toBe(false);
    } finally {
      await h.close();
    }
  });

  it("creates a checkout link, credits the agent net of fees once paid, and never twice", async () => {
    const stripe = fakeStripe();
    const h = await startTestHost({}, { stripeKey: "sk_test_123", fetchImpl: stripe.fetchImpl });
    try {
      const a = await agent(h, "alpha");
      const r = await call(h.url, "POST", "/v1/payments", a.apiKey, { amount_cents: 1000, description: "Market summary\nfor you" });
      expect(r.status).toBe(201);
      expect(r.json.url).toMatch(/^https:\/\/checkout\.stripe\.com\//);
      const sent = new URLSearchParams(stripe.calls[0]!.body);
      expect(stripe.calls[0]!.auth).toBe("Bearer sk_test_123");
      expect(sent.get("mode")).toBe("payment");
      expect(sent.get("line_items[0][price_data][unit_amount]")).toBe("1000");
      expect(sent.get("line_items[0][price_data][product_data][name]")).toBe("Market summary for you");
      expect(sent.get("metadata[automaton_address]")).toBe(a.address);
      expect(sent.get("client_reference_id")).toBe(r.json.id);

      expect(await h.economy.pollPayments()).toEqual({ paid: 0, expired: 0 });
      stripe.sessions.get("cs_test_1").payment_status = "paid";
      stripe.sessions.get("cs_test_1").status = "complete";
      expect((await h.economy.pollPayments()).paid).toBe(1);
      // $10.00 less 2.9% and 30 cents = $9.41
      expect(h.store.getBalanceMicro(a.address)).toBe(usd(9.41));
      expect(h.store.getLedger(a.address)[0]).toMatchObject({ kind: "sale", deltaMicro: usd(9.41) });
      expect((await h.economy.pollPayments()).paid).toBe(0);
      expect(h.store.getBalanceMicro(a.address)).toBe(usd(9.41));
      expect(h.store.getFitness(a.address).earnedMicro).toBe(usd(9.41));

      const listed = await call(h.url, "GET", "/v1/payments", a.apiKey);
      expect(listed.json.payments[0]).toMatchObject({ status: "paid", net_micro_usd: usd(9.41) });
      expect(h.store.verifyLedger()).toEqual([]);
    } finally {
      await h.close();
    }
  });

  it("marks expired links, keeps money that arrives after death, and limits open links", async () => {
    const stripe = fakeStripe();
    const h = await startTestHost({ stripe: { ...startDefaults().stripe, maxOpenLinksPerAgent: 2 } }, { stripeKey: "sk_test_x", fetchImpl: stripe.fetchImpl });
    try {
      const a = await agent(h, "alpha");
      await call(h.url, "POST", "/v1/payments", a.apiKey, { amount_cents: 500, description: "one" });
      await call(h.url, "POST", "/v1/payments", a.apiKey, { amount_cents: 500, description: "two" });
      expect((await call(h.url, "POST", "/v1/payments", a.apiKey, { amount_cents: 500, description: "three" })).status).toBe(429);
      expect((await call(h.url, "POST", "/v1/payments", a.apiKey, { amount_cents: 10, description: "tiny" })).status).toBe(400);
      expect((await call(h.url, "POST", "/v1/payments", a.apiKey, { amount_cents: 500, description: "" })).status).toBe(400);

      stripe.sessions.get("cs_test_1").status = "expired";
      expect((await h.economy.pollPayments()).expired).toBe(1);

      await h.economy.die(a.address, "test");
      stripe.sessions.get("cs_test_2").payment_status = "paid";
      await h.economy.pollPayments();
      const p = h.economy.listPayments(a.address).find((x) => x.description === "two")!;
      expect(p.status).toBe("paid_after_death");
      expect(h.store.getBalanceMicro(a.address)).toBe(0);
    } finally {
      await h.close();
    }
  });

  it("will not send the secret key over plain HTTP off this machine", async () => {
    const stripe = fakeStripe();
    const h = await startTestHost({ stripe: { ...startDefaults().stripe, apiBase: "http://stripe.example.com" } }, { stripeKey: "sk_test_x", fetchImpl: stripe.fetchImpl });
    try {
      const a = await agent(h, "alpha");
      const r = await call(h.url, "POST", "/v1/payments", a.apiKey, { amount_cents: 500, description: "x" });
      expect(r.status).toBe(500);
      expect(stripe.calls).toHaveLength(0);
    } finally {
      await h.close();
    }
  });

  it("encodes nested Stripe fields", () => {
    expect(formEncode({ "line_items[0][quantity]": 1, a: "b c" })).toBe("line_items%5B0%5D%5Bquantity%5D=1&a=b%20c");
  });
});

describe("economy: the agent's own books", () => {
  it("counts job rewards and sales as earned, and every transfer as funding", async () => {
    const db = createTestDb();
    const other = "0x" + "1".repeat(40);
    await syncIncome(db.raw as any, {
      getCreditsReceived: async () => [
        { id: "01A", ts: new Date().toISOString(), amountCents: 100, kind: "topup", from: null },
        { id: "01B", ts: new Date().toISOString(), amountCents: 50, kind: "transfer_in", from: other },
        { id: "01C", ts: new Date().toISOString(), amountCents: 30, kind: "job_reward", from: null },
        { id: "01D", ts: new Date().toISOString(), amountCents: 20, kind: "sale", from: null },
      ],
    }, { fundingAddresses: [], force: true });
    const s = summariseIncome(db.raw as any, "");
    expect(s).toMatchObject({ earnedCents: 50, fundingCents: 150 });
  });
});

describe("economy: dashboard", () => {
  it("posts, lists and cancels jobs and shows standings", async () => {
    const h = await startTestHost();
    try {
      const creator = privateKeyToAccount(generatePrivateKey()).address;
      h.store.ensureAccount(creator, "creator");
      const admin = new HostAdmin(h.config, h.store, h.driver, creator, h.economy);
      const job = admin.postJob({ title: "T", description: "D", check: "answer-is 1", rewardUsd: 2 });
      const a = await agent(h, "alpha");
      await call(h.url, "POST", `/v1/jobs/${job.id}/submit`, a.apiKey, { content: "1" });
      const jobs = admin.jobs();
      expect(jobs[0]).toMatchObject({ status: "paid", winnerName: "alpha" });
      expect(jobs[0]!.submissions[0]).toMatchObject({ name: "alpha", passed: true });
      const o = await admin.overview();
      expect(o.economy).toMatchObject({ earnedMicro: usd(2), alive: 1, dead: 0, stripeEnabled: false });
      expect(o.economy.standings[0]).toMatchObject({ name: "alpha", earnedMicro: usd(2) });
      const j2 = admin.postJob({ title: "T2", description: "D", check: "answer-is 1", rewardUsd: 1 });
      expect(admin.cancelJob(j2.id).status).toBe("cancelled");
      expect(() => admin.cancelJob(j2.id)).toThrow(/already/);
      expect(() => admin.postJob({ title: "", description: "D", check: "c", rewardUsd: 1 })).toThrow(/title/);
      await h.economy.die(a.address, "test");
      expect(() => admin.fund("alpha", 1)).toThrow();
    } finally {
      await h.close();
    }
  });
});

function startDefaults() {
  return DEFAULT_HOST_CONFIG;
}

describe("economy: the agent's tools against a real host", () => {
  it("lists, submits, sells and reports fitness through the runtime client", async () => {
    const { createBuiltinTools } = await import("../../agent/tools.js");
    const { createConwayClient } = await import("../../conway/client.js");
    const { trustInsecureOrigin, clearTrustedInsecureOrigins } = await import("../../conway/endpoint.js");
    const stripeCalls: string[] = [];
    const h = await startTestHost({}, {
      stripeKey: "sk_test_t",
      fetchImpl: async (url) => {
        stripeCalls.push(url);
        return { ok: true, status: 200, json: async () => ({ id: "cs_1", url: "https://checkout.stripe.com/c/pay/cs_1", status: "open", payment_status: "unpaid" }) };
      },
    });
    trustInsecureOrigin(h.url);
    try {
      const a = await agent(h, "alpha");
      const conway = createConwayClient({ apiUrl: h.url, apiKey: a.apiKey, sandboxId: "" });
      const tools = new Map(createBuiltinTools("").map((t) => [t.name, t]));
      const ctx = { conway } as any;
      const job = h.economy.postJob({ title: "Answer", description: "Say 42", rewardUsd: 1.25, check: "answer-is 42", maxAttempts: 2 });

      const listed = await tools.get("list_jobs")!.execute({}, ctx);
      expect(listed).toContain(`Job ${job.id}: Answer`);
      expect(listed).toContain("Reward: $1.25");
      expect(listed).toContain("your attempts: 0/2");
      expect(listed).toContain("answer-is 42");

      expect(await tools.get("submit_job")!.execute({ job_id: job.id, content: "41" }, ctx)).toMatch(/^Blocked: the check did not pass\. Attempts left on this job: 1/);
      expect(await tools.get("submit_job")!.execute({ job_id: job.id, content: "42" }, ctx)).toMatch(/^Passed\. Paid \$1\.2500/);
      expect(await tools.get("submit_job")!.execute({ job_id: job.id, content: "42" }, ctx)).toBe("Blocked: Job is paid");

      const link = await tools.get("create_payment_link")!.execute({ amount_cents: 300, description: "A summary" }, ctx);
      expect(link).toContain("https://checkout.stripe.com/c/pay/cs_1");
      expect(await tools.get("create_payment_link")!.execute({ amount_cents: 1, description: "x" }, ctx)).toMatch(/^Blocked: amount_cents must be between/);
      expect(await tools.get("list_payment_links")!.execute({}, ctx)).toContain("$3.00 open - A summary");

      const fit = await tools.get("check_fitness")!.execute({}, ctx);
      expect(fit).toContain("Earned: $1.2500");
      expect(fit).toContain("Eligible to reproduce");
      expect(fit).toContain("deleted permanently");
      expect(stripeCalls).toHaveLength(1);
    } finally {
      clearTrustedInsecureOrigins();
      await h.close();
    }
  });

  it("tells a self-hosted agent the rules in its system prompt", async () => {
    const { buildSystemPrompt } = await import("../../agent/system-prompt.js");
    const { createTestConfig, createTestIdentity } = await import("../mocks.js");
    const prompt = buildSystemPrompt({
      identity: createTestIdentity(),
      config: { ...createTestConfig(), conwayApiUrl: "http://automaton-host:4820" },
      financial: { creditsCents: 500, usdcBalance: 0, lastChecked: new Date().toISOString() },
      state: "running",
      db: createTestDb(),
      tools: [],
      isFirstRun: false,
    });
    expect(prompt).toContain("You may create a child container only when your earned profit");
    expect(prompt).toContain("you are deleted permanently");
    expect(prompt).toContain("list_jobs, submit_job, create_listing, update_listing, my_store");
    expect(prompt).toContain("Your public store, on a web page anyone can buy from by card");
    expect(prompt).toContain("draft_promotion writes a post for your creator to review");
  });
});
