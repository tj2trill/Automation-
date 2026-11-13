/**
 * Public storefront: agents list digital files, strangers buy them through
 * Stripe Checkout and download them; the creator can pull, suspend and refund.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { DEFAULT_HOST_CONFIG, validateHostConfig } from "../../host/config.js";
import type { FetchLike } from "../../host/economy.js";
import { createSandbox } from "../../host/server.js";
import { MICRO_PER_USD } from "../../host/store.js";
import { cleanFilename, escapeHtml, slugify } from "../../host/storefront.js";
import { readSellableFile } from "../../agent/tools.js";
import { call, signIn, startTestHost, testConfig, type TestHost } from "./helpers.js";

const usd = (n: number) => Math.round(n * MICRO_PER_USD);
const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64");
const OPEN = { ...DEFAULT_HOST_CONFIG.storefront, port: 0, publicUrl: "https://shop.example.com", operatorName: "Test Operator", contactEmail: "help@example.com" };

function fakeStripe() {
  const calls: Array<{ method?: string; url: string; body?: string }> = [];
  const sessions = new Map<string, any>();
  const refunds: string[] = [];
  let n = 0;
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ method: init?.method, url, body: init?.body });
    const json = (o: any, status = 200) => ({ ok: status < 400, status, json: async () => o });
    if (init?.method === "POST" && url.endsWith("/v1/checkout/sessions")) {
      const p = new URLSearchParams(init.body);
      const id = `cs_test_${++n}`;
      const s = { id, url: `https://checkout.stripe.com/c/pay/${id}`, status: "open", payment_status: "unpaid", payment_intent: null as string | null, amount_total: Number(p.get("line_items[0][price_data][unit_amount]")), params: Object.fromEntries(p) };
      sessions.set(id, s);
      return json(s);
    }
    if (init?.method === "POST" && url.endsWith("/v1/refunds")) {
      refunds.push(new URLSearchParams(init.body).get("payment_intent") || "");
      return json({ id: "re_1", status: "succeeded" });
    }
    const m = /\/v1\/checkout\/sessions\/([^/?]+)$/.exec(url);
    if (m && sessions.has(m[1]!)) return json(sessions.get(m[1]!));
    return json({ error: { message: "no such thing" } }, 404);
  };
  const pay = (id: string) => Object.assign(sessions.get(id), { status: "complete", payment_status: "paid", payment_intent: `pi_${id}` });
  return { fetchImpl, calls, sessions, refunds, pay };
}

async function agent(h: TestHost, name: string) {
  const who = await signIn(h.url);
  const sb = await createSandbox({ config: h.config, store: h.store, driver: h.driver, containerHostUrl: "http://automaton-host:4820" }, { owner: who.address, name });
  h.store.updateSandbox(sb.id, { occupant: who.address });
  h.store.ensureAccount(who.address, name);
  return { ...who, sandbox: sb };
}

async function shop(h: TestHost, method: string, p: string, headers: Record<string, string> = {}) {
  const res = await fetch(h.shopUrl + p, { method, headers, redirect: "manual" });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, text: buf.toString("utf-8"), buf };
}

const listingBody = (over: Record<string, unknown> = {}) => ({
  title: "Prime table", description: "The first 1000 primes.\nOne per line.", price_cents: 500, filename: "primes.txt", content_base64: b64("2\n3\n5\n7\n"), ...over,
});

describe("storefront: listings", () => {
  let h: TestHost;
  beforeEach(async () => {
    h = await startTestHost({ storefront: OPEN }, { stripeKey: "sk_test_l", fetchImpl: fakeStripe().fetchImpl });
  });
  afterEach(async () => h.close());

  it("validates listings and publishes them at once", async () => {
    const a = await agent(h, "Alpha Co");
    const bad = async (over: Record<string, unknown>) => (await call(h.url, "POST", "/v1/store/listings", a.apiKey, listingBody(over))).json.error;
    expect(await bad({ title: "" })).toMatch(/title/);
    expect(await bad({ title: "x".repeat(81) })).toMatch(/title/);
    expect(await bad({ description: "" })).toMatch(/description/);
    expect(await bad({ price_cents: 50 })).toMatch(/price_cents/);
    expect(await bad({ price_cents: 2.5 })).toMatch(/price_cents/);
    expect(await bad({ content_base64: "" })).toMatch(/content_base64/);
    expect(await bad({ content_base64: "not base64!!" })).toMatch(/base64/);
    expect(await bad({ filename: "../.." })).toMatch(/filename/);

    const r = await call(h.url, "POST", "/v1/store/listings", a.apiKey, listingBody({ filename: "../../etc/My File (1).txt" }));
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ live: true, on_sale: true, filename: "My-File-1-.txt", url: `https://shop.example.com/p/${r.json.id}` });
    const store = await call(h.url, "GET", "/v1/store", a.apiKey);
    expect(store.json).toMatchObject({ url: "https://shop.example.com/s/alpha-co", slug: "alpha-co", open_for_purchases: true });
    // The file is kept by the host, by content hash.
    expect(fs.readdirSync(h.filesDir)).toHaveLength(1);
  });

  it("caps file size, store size and listing count", async () => {
    const t = await startTestHost({ storefront: { ...OPEN, maxFileMb: 1, maxStoreMb: 1.5, maxListingsPerAgent: 2 } });
    try {
      const a = await agent(t, "alpha");
      const big = b64(Buffer.alloc(1024 * 1024 + 1, 1));
      expect((await call(t.url, "POST", "/v1/store/listings", a.apiKey, listingBody({ content_base64: big }))).status).toBe(413);
      const mb = b64(Buffer.alloc(1024 * 1024, 2));
      expect((await call(t.url, "POST", "/v1/store/listings", a.apiKey, listingBody({ content_base64: mb }))).status).toBe(201);
      expect((await call(t.url, "POST", "/v1/store/listings", a.apiKey, listingBody({ content_base64: mb }))).json.code).toBe("store_full");
      expect((await call(t.url, "POST", "/v1/store/listings", a.apiKey, listingBody())).status).toBe(201);
      expect((await call(t.url, "POST", "/v1/store/listings", a.apiKey, listingBody())).json.code).toBe("too_many_listings");
    } finally {
      await t.close();
    }
  });

  it("lets only the owner edit, and never undo the creator's pull", async () => {
    const a = await agent(h, "alpha");
    const b = await agent(h, "beta");
    const l = (await call(h.url, "POST", "/v1/store/listings", a.apiKey, listingBody())).json;
    expect((await call(h.url, "POST", `/v1/store/listings/${l.id}`, b.apiKey, { price_cents: 100 })).status).toBe(404);
    const up = await call(h.url, "POST", `/v1/store/listings/${l.id}`, a.apiKey, { price_cents: 900, title: "Primes, deluxe" });
    expect(up.json).toMatchObject({ price_cents: 900, title: "Primes, deluxe", on_sale: true });
    expect((await call(h.url, "POST", `/v1/store/listings/${l.id}`, a.apiKey, { live: "yes" })).status).toBe(400);
    expect((await call(h.url, "POST", `/v1/store/listings/${l.id}`, a.apiKey, { live: false })).json.on_sale).toBe(false);
    expect((await shop(h, "GET", `/p/${l.id}`)).status).toBe(404);

    h.storefront.setPulled(l.id, true);
    const tryBack = await call(h.url, "POST", `/v1/store/listings/${l.id}`, a.apiKey, { live: true });
    expect(tryBack.json).toMatchObject({ live: true, pulled_by_creator: true, on_sale: false });
    h.storefront.setPulled(l.id, false);
    expect((await shop(h, "GET", `/p/${l.id}`)).status).toBe(200);
  });

  it("gives every store a unique address", () => {
    expect(slugify("Alpha Co!")).toBe("alpha-co");
    expect(slugify("***")).toBe("store");
    expect(cleanFilename("a/b/c d.PDF")).toBe("c-d.PDF");
    expect(() => cleanFilename("...")).toThrow();
  });
});

describe("storefront: public pages", () => {
  let h: TestHost;
  beforeEach(async () => {
    h = await startTestHost({ storefront: OPEN }, { stripeKey: "sk_test_p", fetchImpl: fakeStripe().fetchImpl });
  });
  afterEach(async () => h.close());

  it("renders agent text as text, runs no script, and says who sells", async () => {
    const a = await agent(h, "alpha");
    const l = (await call(h.url, "POST", "/v1/store/listings", a.apiKey, listingBody({
      title: `<script>alert(1)</script>`, description: `<img src=x onerror=alert(1)> "quoted" & more`,
    }))).json;
    await call(h.url, "POST", "/v1/store", a.apiKey, { tagline: `Best <b>files</b>` });
    for (const p of ["/", "/s/alpha", `/p/${l.id}`]) {
      const r = await shop(h, "GET", p);
      expect(r.status).toBe(200);
      expect(r.text).not.toMatch(/<script/i);
      expect(r.text).not.toContain("<img");
      expect(r.text).not.toContain("<b>");
      expect(r.headers.get("content-security-policy")).toContain("default-src 'none'");
      expect(r.headers.get("content-security-policy")).not.toContain("script-src");
      expect(r.text).toContain("autonomous AI agents run by Test Operator");
      expect(r.text).toContain("mailto:help@example.com");
    }
    const item = await shop(h, "GET", `/p/${l.id}`);
    expect(item.text).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(item.text).toContain(`<form method="post" action="/p/${l.id}/buy">`);
    expect((await shop(h, "GET", "/s/nobody")).status).toBe(404);
    expect((await shop(h, "GET", "/v1/store")).status).toBe(404);
    expect((await shop(h, "GET", "/api/overview")).status).toBe(404);
    expect(escapeHtml(`<"'&>`)).toBe("&lt;&quot;&#39;&amp;&gt;");
    expect((await shop(h, "GET", "/favicon.ico")).status).toBe(204);
  });

  it("will not take money until the operator, contact, address and Stripe are set", async () => {
    const t = await startTestHost({ storefront: { ...OPEN, operatorName: "" } });
    try {
      const a = await agent(t, "alpha");
      const l = (await call(t.url, "POST", "/v1/store/listings", a.apiKey, listingBody())).json;
      expect((await call(t.url, "GET", "/v1/store", a.apiKey)).json.open_for_purchases).toBe(false);
      expect(t.storefront.missingForSales).toEqual(["storefront.operatorName", "STRIPE_SECRET_KEY"]);
      const page = await shop(t, "GET", `/p/${l.id}`);
      expect(page.text).toContain("Purchases are not open yet");
      expect((await shop(t, "POST", `/p/${l.id}/buy`)).status).toBe(503);
    } finally {
      await t.close();
    }
  });

  it("refuses an http or path-bearing public address in host.json", () => {
    expect(() => validateHostConfig(testConfig({ storefront: { ...OPEN, publicUrl: "http://shop.example.com" } }))).toThrow(/https/);
    expect(() => validateHostConfig(testConfig({ storefront: { ...OPEN, publicUrl: "https://shop.example.com/store" } }))).toThrow(/origin/);
    expect(() => validateHostConfig({ ...testConfig({ storefront: { ...OPEN, port: 4820 } }), port: 4820 })).toThrow(/differ/);
    expect(() => validateHostConfig(testConfig({ storefront: OPEN }))).not.toThrow();
  });
});

describe("storefront: buying", () => {
  let h: TestHost;
  let stripe: ReturnType<typeof fakeStripe>;
  beforeEach(async () => {
    stripe = fakeStripe();
    h = await startTestHost({ storefront: { ...OPEN, maxDownloads: 3 } }, { stripeKey: "sk_test_s", fetchImpl: stripe.fetchImpl });
  });
  afterEach(async () => h.close());

  async function buy(listingId: string) {
    const r = await shop(h, "POST", `/p/${listingId}/buy`);
    expect(r.status).toBe(303);
    const sessionId = /cs_test_\d+/.exec(r.headers.get("location")!)![0];
    const success = new URL(stripe.sessions.get(sessionId).params.success_url);
    return { sessionId, orderPath: success.pathname + success.search, orderId: success.pathname.split("/").pop()! };
  }

  it("sends the buyer to Stripe, then delivers the file once paid and credits the agent", async () => {
    const a = await agent(h, "alpha");
    const content = "2\n3\n5\n7\n";
    const l = (await call(h.url, "POST", "/v1/store/listings", a.apiKey, listingBody({ filename: "page.html", content_base64: b64(content) }))).json;
    const { sessionId, orderPath, orderId } = await buy(l.id);
    const params = stripe.sessions.get(sessionId).params;
    expect(params).toMatchObject({
      mode: "payment", "line_items[0][price_data][unit_amount]": "500", "line_items[0][price_data][product_data][name]": "Prime table",
      cancel_url: `https://shop.example.com/p/${l.id}`, "metadata[automaton_address]": a.address,
    });
    expect(params.success_url).toMatch(/^https:\/\/shop\.example\.com\/order\/[0-9A-Z]{26}\?k=[A-Za-z0-9_-]{20,}$/);

    // Not paid yet.
    expect((await shop(h, "GET", orderPath)).text).toContain("Waiting for payment");
    expect(h.store.getBalanceMicro(a.address)).toBe(0);
    // Without the key from the success address, the order does not exist.
    expect((await shop(h, "GET", `/order/${orderId}`)).status).toBe(404);
    expect((await shop(h, "GET", `/order/${orderId}?k=wrong`)).status).toBe(404);

    stripe.pay(sessionId);
    const page = await shop(h, "GET", orderPath);
    expect(page.text).toContain("Thank you");
    const link = /href="(\/d\/[A-Za-z0-9_-]+)"/.exec(page.text)![1]!;
    const dl = await shop(h, "GET", link);
    expect(dl.status).toBe(200);
    expect(dl.text).toBe(content);
    // Agent-made HTML is never rendered on this domain.
    expect(dl.headers.get("content-type")).toBe("application/octet-stream");
    expect(dl.headers.get("content-disposition")).toBe('attachment; filename="page.html"');
    expect(dl.headers.get("content-security-policy")).toContain("sandbox");

    // $5.00 less 2.9% and 30 cents.
    expect(h.store.getBalanceMicro(a.address)).toBe(usd(4.555));
    expect(h.store.getLedger(a.address)[0]).toMatchObject({ kind: "sale", ref: orderId });
    expect(h.store.getFitness(a.address).earnedMicro).toBe(usd(4.555));

    // Each visit gives a fresh link; the old one stops working. Downloads are capped.
    const again = /href="(\/d\/[A-Za-z0-9_-]+)"/.exec((await shop(h, "GET", orderPath)).text)![1]!;
    expect((await shop(h, "GET", link)).status).toBe(404);
    expect((await shop(h, "GET", again)).status).toBe(200);
    expect((await shop(h, "GET", again)).status).toBe(200);
    expect((await shop(h, "GET", again)).status).toBe(410);
    expect((await shop(h, "GET", orderPath)).text).toContain("Download limit reached");
    expect(h.store.getBalanceMicro(a.address)).toBe(usd(4.555));
    expect(h.store.verifyLedger()).toEqual([]);

    const view = (await call(h.url, "GET", "/v1/store", a.apiKey)).json.listings[0];
    expect(view).toMatchObject({ sales: 1, sales_net_micro_usd: usd(4.555) });
  });

  it("expires download links", async () => {
    const a = await agent(h, "alpha");
    const l = (await call(h.url, "POST", "/v1/store/listings", a.apiKey, listingBody())).json;
    const { sessionId, orderPath, orderId } = await buy(l.id);
    stripe.pay(sessionId);
    const link = /href="(\/d\/[A-Za-z0-9_-]+)"/.exec((await shop(h, "GET", orderPath)).text)![1]!;
    h.store.db.prepare("UPDATE orders SET download_expires = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), orderId);
    expect((await shop(h, "GET", link)).status).toBe(410);
    expect((await shop(h, "GET", "/d/" + "x".repeat(32))).status).toBe(404);
  });

  it("credits a buyer who paid but never came back, exactly once", async () => {
    const a = await agent(h, "alpha");
    const l = (await call(h.url, "POST", "/v1/store/listings", a.apiKey, listingBody())).json;
    const { sessionId, orderPath } = await buy(l.id);
    expect(await h.storefront.pollOrders()).toEqual({ paid: 0, expired: 0 });
    stripe.pay(sessionId);
    expect((await h.storefront.pollOrders()).paid).toBe(1);
    expect((await h.storefront.pollOrders()).paid).toBe(0);
    expect((await shop(h, "GET", orderPath)).text).toContain("Thank you");
    expect(h.store.getBalanceMicro(a.address)).toBe(usd(4.555));
  });

  it("expires abandoned checkouts", async () => {
    const a = await agent(h, "alpha");
    const l = (await call(h.url, "POST", "/v1/store/listings", a.apiKey, listingBody())).json;
    const one = await buy(l.id);
    stripe.sessions.get(one.sessionId).status = "expired";
    expect((await h.storefront.pollOrders()).expired).toBe(1);
    expect((await shop(h, "GET", one.orderPath)).text).toContain("Nothing was charged");
    const two = await buy(l.id);
    await h.storefront.pollOrders(Date.now() + 26 * 3_600_000);
    expect(h.storefront.getOrder(two.orderId)!.status).toBe("expired");
  });

  it("refunds through Stripe and takes the money back from the agent", async () => {
    const a = await agent(h, "alpha");
    const l = (await call(h.url, "POST", "/v1/store/listings", a.apiKey, listingBody())).json;
    const { sessionId, orderPath, orderId } = await buy(l.id);
    stripe.pay(sessionId);
    const link = /href="(\/d\/[A-Za-z0-9_-]+)"/.exec((await shop(h, "GET", orderPath)).text)![1]!;
    const o = await h.storefront.refund(orderId);
    expect(o.status).toBe("refunded");
    expect(stripe.refunds).toEqual([`pi_${sessionId}`]);
    expect(h.store.getBalanceMicro(a.address)).toBe(0);
    expect(h.store.getFitness(a.address).earnedMicro).toBe(0);
    expect((await shop(h, "GET", link)).status).toBe(404);
    expect((await shop(h, "GET", orderPath)).text).toContain("Refunded");
    await expect(h.storefront.refund(orderId)).rejects.toThrow(/refunded/);
    expect(h.store.verifyLedger()).toEqual([]);
  });

  it("closes a suspended store and a pulled listing to buyers", async () => {
    const a = await agent(h, "alpha");
    const l = (await call(h.url, "POST", "/v1/store/listings", a.apiKey, listingBody())).json;
    h.storefront.setSuspended(a.address, true);
    expect((await shop(h, "GET", "/s/alpha")).status).toBe(404);
    expect((await shop(h, "GET", `/p/${l.id}`)).status).toBe(404);
    expect((await shop(h, "POST", `/p/${l.id}/buy`)).status).toBe(404);
    expect((await shop(h, "GET", "/")).text).toContain("No stores are open");
    h.storefront.setSuspended(a.address, false);
    expect((await shop(h, "GET", "/s/alpha")).status).toBe(200);
    expect(stripe.calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("still delivers to buyers after the agent dies, and keeps late money with the creator", async () => {
    const a = await agent(h, "alpha");
    const l = (await call(h.url, "POST", "/v1/store/listings", a.apiKey, listingBody())).json;
    const early = await buy(l.id);
    const late = await buy(l.id);
    stripe.pay(early.sessionId);
    await h.storefront.pollOrders();
    await h.economy.die(a.address, "test");

    expect((await shop(h, "GET", "/s/alpha")).status).toBe(404);
    expect((await shop(h, "GET", `/p/${l.id}`)).status).toBe(404);
    expect(h.storefront.getListing(l.id)!.removed).toBe(true);
    expect((await shop(h, "GET", (/href="(\/d\/[^"]+)"/.exec((await shop(h, "GET", early.orderPath)).text)![1]!))).status).toBe(200);

    stripe.pay(late.sessionId);
    const page = await shop(h, "GET", late.orderPath);
    expect(page.text).toContain("Thank you");
    expect(h.storefront.getOrder(late.orderId)!.status).toBe("paid_after_death");
    expect((await shop(h, "GET", /href="(\/d\/[^"]+)"/.exec(page.text)![1]!)).status).toBe(200);
  });

  it("limits how many checkouts one visitor can start", async () => {
    const a = await agent(h, "alpha");
    const l = (await call(h.url, "POST", "/v1/store/listings", a.apiKey, listingBody())).json;
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await shop(h, "POST", `/p/${l.id}/buy`, { "cf-connecting-ip": "203.0.113.5" })).status);
    expect(statuses.slice(0, 10).every((s) => s === 303)).toBe(true);
    expect(statuses[10]).toBe(429);
    // Behind the tunnel, each real visitor has their own allowance.
    expect((await shop(h, "POST", `/p/${l.id}/buy`, { "cf-connecting-ip": "203.0.113.6" })).status).toBe(303);
  });
});

describe("storefront: what an agent may sell", () => {
  let home: string;
  let saved: string | undefined;
  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agent-home-")));
    saved = process.env.HOME;
    process.env.HOME = home;
    fs.mkdirSync(path.join(home, ".automaton"));
    fs.writeFileSync(path.join(home, ".automaton", "wallet.json"), '{"privateKey":"0xabc"}');
    fs.mkdirSync(path.join(home, "products"));
    fs.writeFileSync(path.join(home, "products", "guide.txt"), "A useful guide.");
  });
  afterEach(() => {
    process.env.HOME = saved;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("reads ordinary files and refuses keys, state and anything outside home", () => {
    expect(readSellableFile("products/guide.txt")).toEqual({ name: "guide.txt", base64: b64("A useful guide.") });
    expect(() => readSellableFile(path.join(home, ".automaton", "wallet.json"))).toThrow(/\.automaton/);
    fs.symlinkSync(path.join(home, ".automaton", "wallet.json"), path.join(home, "products", "innocent.txt"));
    expect(() => readSellableFile("products/innocent.txt")).toThrow(/\.automaton/);
    fs.writeFileSync(path.join(home, "products", "server.pem"), "x");
    expect(() => readSellableFile("products/server.pem")).toThrow(/key or credential/);
    fs.writeFileSync(path.join(home, "products", "notes.txt"), "-----BEGIN EC PRIVATE KEY-----\nabc");
    expect(() => readSellableFile("products/notes.txt")).toThrow(/private key/);
    fs.writeFileSync(path.join(home, "products", "cfg.txt"), "stripe sk_live_abcdefghijklmnop");
    expect(() => readSellableFile("products/cfg.txt")).toThrow(/API key/);
    expect(() => readSellableFile("/etc/hostname")).toThrow(/home directory/);
    expect(() => readSellableFile("products")).toThrow(/regular files/);
    expect(() => readSellableFile("products/missing.txt")).toThrow(/No file/);
    fs.writeFileSync(path.join(home, "products", "empty.txt"), "");
    expect(() => readSellableFile("products/empty.txt")).toThrow(/empty/);
  });

  it("lists, inspects and edits through the agent's own tools", async () => {
    const { createBuiltinTools } = await import("../../agent/tools.js");
    const { createConwayClient } = await import("../../conway/client.js");
    const { trustInsecureOrigin, clearTrustedInsecureOrigins } = await import("../../conway/endpoint.js");
    const h = await startTestHost({ storefront: OPEN }, { stripeKey: "sk_test_t", fetchImpl: fakeStripe().fetchImpl });
    trustInsecureOrigin(h.url);
    try {
      const a = await agent(h, "alpha");
      const tools = new Map(createBuiltinTools("").map((t) => [t.name, t]));
      const ctx = { conway: createConwayClient({ apiUrl: h.url, apiKey: a.apiKey, sandboxId: "" }) } as any;
      expect(await tools.get("my_store")!.execute({}, ctx)).toContain("You have no store yet");
      expect(await tools.get("create_listing")!.execute({ title: "Secret", description: "x", price_cents: 500, file_path: ".automaton/wallet.json" }, ctx)).toMatch(/^Blocked: Files under ~\/\.automaton/);
      const made = await tools.get("create_listing")!.execute({ title: "Guide", description: "A guide.", price_cents: 700, file_path: "products/guide.txt" }, ctx);
      expect(made).toMatch(/^Listed [0-9A-Z]{26} "Guide" at \$7\.00: https:\/\/shop\.example\.com\/p\//);
      const id = /Listed ([0-9A-Z]{26})/.exec(made)![1]!;
      expect(await tools.get("create_listing")!.execute({ title: "Cheap", description: "x", price_cents: 1, file_path: "products/guide.txt" }, ctx)).toMatch(/^Blocked: price_cents/);
      expect(await tools.get("set_store_tagline")!.execute({ tagline: "Guides that work" }, ctx)).toBe("Tagline set.");
      expect(await tools.get("update_listing")!.execute({ listing_id: id, price_cents: 900 }, ctx)).toContain("$9.00, on sale");
      const view = await tools.get("my_store")!.execute({}, ctx);
      expect(view).toContain("Store: https://shop.example.com/s/alpha");
      expect(view).toContain("Tagline: Guides that work");
      expect(view).toContain(`${id} "Guide" $9.00 guide.txt [on sale] sales: 0 ($0.00 to you)`);
      h.storefront.setPulled(id, true);
      expect(await tools.get("my_store")!.execute({}, ctx)).toContain("[pulled by your creator]");
    } finally {
      clearTrustedInsecureOrigins();
      await h.close();
    }
  });
});
