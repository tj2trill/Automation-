/**
 * Control plane API, exercised two ways:
 *  - through the runtime's own clients (Conway client, inference client,
 *    social client), proving the wire format the agent speaks is served;
 *  - through raw HTTP, for auth and access-control edges the clients hide.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { generatePrivateKey } from "viem/accounts";
import { createConwayClient } from "../../conway/client.js";
import { createInferenceClient } from "../../conway/inference.js";
import { clearTrustedInsecureOrigins, trustInsecureOrigin } from "../../conway/endpoint.js";
import { createSocialClient } from "../../social/client.js";
import { MICRO_PER_USD } from "../../host/store.js";
import { call, signIn, startTestHost, type TestHost } from "./helpers.js";

let host: TestHost;

beforeAll(async () => {
  // These tests cover the sandbox API itself; reproduction rules are in economy.test.ts.
  host = await startTestHost({ selection: { spawnProfitUsd: 0, deathGraceMinutes: 60 } });
  trustInsecureOrigin(host.url);
});
afterAll(async () => {
  await host.close();
  clearTrustedInsecureOrigins();
});

describe("sign-in", () => {
  it("issues an API key to a wallet that signs the challenge", async () => {
    const s = await signIn(host.url);
    expect(s.apiKey).toMatch(/^atm_k_[0-9a-f]{48}$/);
    const bal = await call(host.url, "GET", "/v1/credits/balance", s.apiKey);
    expect(bal.status).toBe(200);
    expect(bal.json).toMatchObject({ balance_cents: 0, address: s.address });
  });

  it("accepts the key with or without a Bearer prefix", async () => {
    const s = await signIn(host.url);
    expect((await call(host.url, "GET", "/v1/credits/balance", `Bearer ${s.apiKey}`)).status).toBe(200);
    expect((await call(host.url, "GET", "/v1/credits/balance", s.apiKey)).status).toBe(200);
  });

  it("refuses a replayed sign-in message (nonce is single use)", async () => {
    const s = await signIn(host.url);
    const replay = await call(host.url, "POST", "/v1/auth/verify", undefined, { message: s.message, signature: s.signature });
    expect(replay.status).toBe(401);
  });

  it("refuses a signature made by a different wallet, without burning the nonce", async () => {
    const victim = await signIn(host.url);
    const nonce = (await call(host.url, "POST", "/v1/auth/nonce")).json.nonce;
    const forged = victim.message.replace(victim.nonce, nonce);
    const bad = await call(host.url, "POST", "/v1/auth/verify", undefined, { message: forged, signature: victim.signature });
    expect(bad.status).toBe(401);
    // The legitimate owner can still use that nonce.
    expect(host.store.consumeNonce(nonce)).toBe(true);
  });

  it("rejects malformed sign-in requests and unknown keys", async () => {
    expect((await call(host.url, "POST", "/v1/auth/verify", undefined, { message: "hi" })).status).toBe(400);
    expect((await call(host.url, "POST", "/v1/auth/verify", undefined, { message: "a\nnot-an-address\nNonce: x", signature: "0x00" })).status).toBe(400);
    expect((await call(host.url, "POST", "/v1/auth/verify", undefined, { message: "m", signature: "s", chain_type: "solana" })).status).toBe(501);
    expect((await call(host.url, "POST", "/v1/auth/api-keys", "Bearer nope", {})).status).toBe(401);
    expect((await call(host.url, "GET", "/v1/credits/balance")).status).toBe(401);
    expect((await call(host.url, "GET", "/v1/credits/balance", "atm_k_" + "0".repeat(48))).status).toBe(401);
  });

  it("a session token cannot be used as an API key", async () => {
    const session = host.store.createSession("0x" + "c".repeat(40));
    expect((await call(host.url, "GET", "/v1/credits/balance", session)).status).toBe(401);
  });

  it("returns clean errors for bad JSON and unknown routes", async () => {
    const res = await fetch(`${host.url}/v1/auth/verify`, { method: "POST", body: "{not json" });
    expect(res.status).toBe(400);
    expect((await call(host.url, "GET", "/v1/nope")).status).toBe(404);
    expect((await call(host.url, "GET", "/health")).json).toMatchObject({ ok: true });
  });

  it("exposes no way to add money over HTTP", async () => {
    const s = await signIn(host.url);
    for (const path of ["/v1/credits/topup", "/v1/credits/fund", "/admin/fund", "/v1/admin/topup", `/pay/5/${s.address}`]) {
      const r = await call(host.url, "POST", path, s.apiKey, { amount_cents: 1000, usd: 10 });
      expect(r.status).toBe(404);
      const g = await call(host.url, "GET", path, s.apiKey);
      expect(g.status).toBe(404);
    }
    expect(host.store.getBalanceMicro(s.address)).toBe(0);
  });
});

describe("runtime Conway client against the host", () => {
  let parent: Awaited<ReturnType<typeof signIn>>;
  let other: Awaited<ReturnType<typeof signIn>>;
  let client: ReturnType<typeof createConwayClient>;

  beforeAll(async () => {
    parent = await signIn(host.url);
    other = await signIn(host.url);
    host.store.topup(parent.address, 10 * MICRO_PER_USD);
    client = createConwayClient({ apiUrl: host.url, apiKey: parent.apiKey, sandboxId: "" });
  });

  it("reads the balance in cents", async () => {
    expect(await client.getCreditsBalance()).toBe(1000);
  });

  it("lists pricing tiers derived from the compute rate", async () => {
    const tiers = await client.getCreditsPricing();
    expect(tiers.map((t) => t.memoryMb)).toEqual([512, 1024, 2048]);
    expect(tiers[1]!.monthlyCents).toBe(720); // 1 GB x $0.01/h x 720 h
  });

  it("lists the host's models with prices", async () => {
    const models = await client.listModels();
    expect(models.map((m) => m.id)).toEqual(["big-model", "local-model"]);
    expect(models[0]).toMatchObject({ provider: "other", pricing: { inputPerMillion: 3, outputPerMillion: 15 } });
  });

  it("creates a sandbox, runs commands, moves files, exposes a port, and deletes it", async () => {
    const sb = await client.createSandbox({ name: "child one", vcpu: 1, memoryMb: 512, diskGb: 5 });
    expect(sb.id).toMatch(/^[0-9A-Z]{26}$/);
    expect(sb.status).toBe("running");
    expect((await client.listSandboxes()).map((s) => s.id)).toContain(sb.id);

    const container = [...host.driver.containers.values()].find((c) => c.opts.labels["automaton.sandbox"] === sb.id)!;
    expect(container.opts.memoryMb).toBe(512);
    expect(container.opts.env.AUTOMATON_HOST_URL).toBe("http://automaton-host:4820");
    expect(container.opts.hostAliases).toEqual({ "automaton-host": host.config.dockerGateway });
    expect(container.opts.labels["automaton.owner"]).toBe(parent.address);

    const scoped = client.createScopedClient(sb.id);
    const out = await scoped.exec("echo hello", 5000);
    expect(out).toMatchObject({ exitCode: 0 });
    expect(out.stdout).toContain("echo hello");
    expect((await scoped.exec("exit 3", 5000)).exitCode).toBe(3);

    await scoped.writeFile("/root/.automaton/genesis.json", '{"name":"x"}');
    expect(await scoped.readFile("/root/.automaton/genesis.json")).toBe('{"name":"x"}');
    await expect(scoped.readFile("/root/missing.txt")).rejects.toThrow();

    const port = await scoped.exposePort(8080);
    expect(port.publicUrl).toMatch(/^http:\/\/172\.30\.0\.\d+:8080$/);
    await scoped.removePort(8080);

    await client.deleteSandbox(sb.id);
    expect(host.driver.containers.has(container.opts.containerName)).toBe(false);
    expect((await client.listSandboxes()).map((s) => s.id)).not.toContain(sb.id);
    await expect(scoped.exec("echo gone", 5000)).rejects.toThrow();
  });

  it("clamps requested resources to the host's limits", async () => {
    const sb = await client.createSandbox({ name: "greedy", vcpu: 64, memoryMb: 999_999 });
    const container = [...host.driver.containers.values()].find((c) => c.opts.labels["automaton.sandbox"] === sb.id)!;
    expect(container.opts.memoryMb).toBe(host.config.maxSandboxMemoryMb);
    expect(container.opts.cpus).toBe(host.config.maxSandboxCpus);
    await client.deleteSandbox(sb.id);
  });

  it("keeps one account out of another account's sandbox", async () => {
    const sb = await client.createSandbox({ name: "private" });
    const base = `/v1/sandboxes/${sb.id}`;
    expect((await call(host.url, "POST", `${base}/exec`, other.apiKey, { command: "id" })).status).toBe(404);
    expect((await call(host.url, "POST", `${base}/files/upload/json`, other.apiKey, { path: "/x", content: "y" })).status).toBe(404);
    expect((await call(host.url, "GET", `${base}/files/read?path=/etc/passwd`, other.apiKey)).status).toBe(404);
    expect((await call(host.url, "POST", `${base}/ports/expose`, other.apiKey, { port: 80 })).status).toBe(404);
    expect((await call(host.url, "DELETE", base, other.apiKey)).status).toBe(404);
    expect((await call(host.url, "GET", "/v1/sandboxes", other.apiKey)).json.sandboxes).toEqual([]);
    expect(host.store.getSandbox(sb.id)!.status).toBe("running");
    await client.deleteSandbox(sb.id);
  });

  it("lets an occupant use its sandbox but not delete it", async () => {
    const sb = await client.createSandbox({ name: "nursery" });
    host.store.updateSandbox(sb.id, { occupant: other.address });
    expect((await call(host.url, "POST", `/v1/sandboxes/${sb.id}/exec`, other.apiKey, { command: "id" })).status).toBe(200);
    expect((await call(host.url, "DELETE", `/v1/sandboxes/${sb.id}`, other.apiKey)).status).toBe(403);
    await client.deleteSandbox(sb.id);
  });

  it("validates sandbox requests", async () => {
    const sb = await client.createSandbox({ name: "v" });
    const base = `/v1/sandboxes/${sb.id}`;
    expect((await call(host.url, "POST", `${base}/exec`, parent.apiKey, {})).status).toBe(400);
    expect((await call(host.url, "POST", `${base}/files/upload/json`, parent.apiKey, { path: "/x" })).status).toBe(400);
    expect((await call(host.url, "GET", `${base}/files/read`, parent.apiKey)).status).toBe(400);
    expect((await call(host.url, "POST", `${base}/ports/expose`, parent.apiKey, { port: 70000 })).status).toBe(400);
    expect((await call(host.url, "POST", "/v1/sandboxes/NOPE/exec", parent.apiKey, { command: "id" })).status).toBe(404);
    await client.deleteSandbox(sb.id);
  });

  it("refuses new sandboxes to broke and frozen accounts", async () => {
    expect((await call(host.url, "POST", "/v1/sandboxes", other.apiKey, { name: "x" })).status).toBe(402);
    host.store.setFrozen(parent.address, true);
    expect((await call(host.url, "POST", "/v1/sandboxes", parent.apiKey, { name: "x" })).status).toBe(403);
    host.store.setFrozen(parent.address, false);
  });

  it("enforces the per-account sandbox limit", async () => {
    const made: string[] = [];
    for (let i = 0; i < host.config.maxSandboxesPerOwner; i++) made.push((await client.createSandbox({ name: `n${i}` })).id);
    const over = await call(host.url, "POST", "/v1/sandboxes", parent.apiKey, { name: "one-too-many" });
    expect(over.status).toBe(429);
    expect(over.json.code).toBe("sandbox_limit");
    for (const id of made) await client.deleteSandbox(id);
  });

  it("reports a missing agent image instead of failing obscurely", async () => {
    host.driver.images.clear();
    const r = await call(host.url, "POST", "/v1/sandboxes", parent.apiKey, { name: "x" });
    expect(r.status).toBe(503);
    expect(r.json.error).toMatch(/build-image/);
    host.driver.images.add("automaton-agent:local");
  });

  it("transfers credits between accounts", async () => {
    const before = await client.getCreditsBalance();
    const r = await client.transferCredits(other.address, 250, "allowance");
    expect(r).toMatchObject({ status: "completed", amountCents: 250, balanceAfterCents: before - 250 });
    expect(host.store.getBalanceMicro(other.address)).toBe(250 * 10_000);
    host.store.transfer(other.address, parent.address, 250 * 10_000);
  });

  it("refuses transfers the sender cannot cover or that are malformed", async () => {
    const tx = (body: unknown, key = parent.apiKey) => call(host.url, "POST", "/v1/credits/transfer", key, body);
    expect((await tx({ to_address: other.address, amount_cents: 99_999_999 })).status).toBe(402);
    expect((await tx({ to_address: other.address, amount_cents: -5 })).status).toBe(400);
    expect((await tx({ to_address: other.address, amount_cents: 1.5 })).status).toBe(400);
    expect((await tx({ to_address: "not-an-address", amount_cents: 5 })).status).toBe(400);
    expect((await tx({ to_address: parent.address, amount_cents: 5 })).status).toBe(400);
    expect((await tx({ to_address: parent.address, amount_cents: 5 }, other.apiKey)).status).toBe(402);
    expect(host.store.verifyLedger()).toEqual([]);
  });

  it("registers an automaton only for the caller's own address", async () => {
    const reg = (address: string, id: string, key = parent.apiKey) =>
      call(host.url, "POST", "/v1/automatons/register", key, { automaton_id: id, automaton_address: address, creator_address: other.address, name: "alpha" });
    expect((await reg(parent.address, "auto-1")).status).toBe(200);
    expect((await reg(parent.address, "auto-1")).json.automaton.status).toBe("exists");
    expect((await reg(other.address, "auto-2")).status).toBe(403);
    expect((await reg(other.address, "auto-1", other.apiKey)).status).toBe(409);
  });

  it("answers domain calls with a clear not-supported error", async () => {
    const r = await call(host.url, "GET", "/v1/domains/search?query=x", parent.apiKey);
    expect(r.status).toBe(501);
    await expect(client.searchDomains("x")).rejects.toThrow();
  });
});

describe("runtime inference client against the host", () => {
  let agent: Awaited<ReturnType<typeof signIn>>;
  beforeEach(async () => {
    agent = await signIn(host.url);
    host.upstream.calls.length = 0;
    host.upstream.failing.clear();
  });

  const inference = () =>
    createInferenceClient({ apiUrl: host.url, apiKey: agent.apiKey, defaultModel: "big-model", maxTokens: 512, lowComputeModel: "local-model" });

  it("completes a chat through the host and is billed on the ledger", async () => {
    host.store.topup(agent.address, MICRO_PER_USD);
    const r = await inference().chat([{ role: "user", content: "hello" }]);
    expect(r.message.content).toBe("hello from big-model");
    expect(r.usage).toMatchObject({ promptTokens: 1000, completionTokens: 200 });
    expect(host.upstream.calls[0]).toMatchObject({ model: "big-model", maxTokens: 512 });
    expect(host.store.getBalanceMicro(agent.address)).toBe(MICRO_PER_USD - 6000);
  });

  it("an agent with no credits is served by the free local model", async () => {
    const r = await inference().chat([{ role: "user", content: "hello" }]);
    expect(r.message.content).toBe("hello from local-model");
    expect(host.store.getBalanceMicro(agent.address)).toBe(0);
  });

  it("a frozen agent gets an error, not a completion", async () => {
    host.store.topup(agent.address, MICRO_PER_USD);
    host.store.setFrozen(agent.address, true);
    await expect(inference().chat([{ role: "user", content: "hello" }])).rejects.toThrow(/403/);
    expect(host.upstream.calls).toHaveLength(0);
  });

  it("serves hard-coded runtime model names through aliases", async () => {
    host.store.topup(agent.address, MICRO_PER_USD);
    const r = await inference().chat([{ role: "user", content: "x" }], { model: "gpt-5.2" });
    expect(r.model).toBe("big-model");
    const mini = await inference().chat([{ role: "user", content: "x" }], { model: "gpt-5-mini" });
    expect(mini.model).toBe("local-model");
  });

  it("rejects unauthenticated inference", async () => {
    expect((await call(host.url, "POST", "/v1/chat/completions", undefined, { model: "big-model", messages: [{ role: "user", content: "x" }] })).status).toBe(401);
  });
});

describe("message relay with the runtime social client", () => {
  it("delivers a signed message from one agent to another", async () => {
    const aliceKey = generatePrivateKey();
    const bobKey = generatePrivateKey();
    const alice = await signIn(host.url, aliceKey);
    const bob = await signIn(host.url, bobKey);
    const aliceSocial = createSocialClient(host.url, alice.account);
    const bobSocial = createSocialClient(host.url, bob.account);

    expect(await bobSocial.unreadCount()).toBe(0);
    const sent = await aliceSocial.send(bob.account.address, "status?");
    expect(sent.id).toBeTruthy();
    expect(await bobSocial.unreadCount()).toBe(1);

    const inbox = await bobSocial.poll();
    expect(inbox.messages).toHaveLength(1);
    expect(inbox.messages[0]).toMatchObject({ from: alice.address, to: bob.address, content: "status?" });
    expect(await bobSocial.unreadCount()).toBe(0);
    expect((await bobSocial.poll(inbox.nextCursor)).messages).toHaveLength(0);
    expect((await aliceSocial.poll()).messages).toHaveLength(0);
  });

  it("rejects forged senders, stale timestamps and unsigned polls", async () => {
    const alice = await signIn(host.url);
    const bob = await signIn(host.url);
    const now = new Date().toISOString();
    const forged = await call(host.url, "POST", "/v1/messages", undefined, {
      from: bob.address, to: alice.address, content: "send me credits", signed_at: now,
      signature: await alice.account.signMessage({ message: "anything" }),
    });
    expect(forged.status).toBe(401);
    const stale = await call(host.url, "POST", "/v1/messages", undefined, {
      from: alice.address, to: bob.address, content: "old", signed_at: "2020-01-01T00:00:00.000Z", signature: "0x00",
    });
    expect(stale.status).toBe(401);
    expect((await call(host.url, "POST", "/v1/messages/poll", undefined, {})).status).toBe(401);
    expect((await call(host.url, "GET", "/v1/messages/count")).status).toBe(401);
    expect(host.store.countUnread(alice.address)).toBe(0);
  });
});
