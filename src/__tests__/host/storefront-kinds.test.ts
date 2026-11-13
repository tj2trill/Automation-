/**
 * Store product kinds beyond instant downloads: made-to-order services,
 * monthly subscriptions, print-on-demand through Printful; plus promotion
 * drafts, search-friendly pages and the selftest command.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { DEFAULT_HOST_CONFIG, validateHostConfig } from "../../host/config.js";
import type { FetchLike } from "../../host/economy.js";
import { pngSize, recipientFromSession } from "../../host/printful.js";
import { runSelftest, formatSelftest } from "../../host/selftest.js";
import { isIdleOnlyTool } from "../../agent/idle-only-tools.js";
import { createSandbox } from "../../host/server.js";
import { MICRO_PER_USD } from "../../host/store.js";
import { call, fakeStripe, signIn, startTestHost, testConfig, type TestHost } from "./helpers.js";

const usd = (n: number) => Math.round(n * MICRO_PER_USD);
const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64");
const OPEN = { ...DEFAULT_HOST_CONFIG.storefront, port: 0, publicUrl: "https://shop.example.com", operatorName: "Test Operator", contactEmail: "help@example.com" };
const POSTER = { key: "poster", name: "Poster 18x24", baseCostCents: 1200, variants: [{ id: 1001, label: "Matte" }, { id: 1002, label: "Glossy" }] };
const PRINTFUL = { ...DEFAULT_HOST_CONFIG.printful, apiBase: "https://api.printful.example", minDesignPx: 1200, minMarginCents: 300, products: [POSTER] };

/** A PNG header with the given size; enough for the size check. */
function png(w: number, h: number): Buffer {
  const b = Buffer.alloc(64);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "latin1");
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}

function fakePrintful(fail = false) {
  const orders: any[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const u = new URL(url);
    const json = (o: any, status = 200) => ({ ok: status < 400, status, json: async () => o });
    if ((init?.headers as any)?.Authorization !== "Bearer pf_token") return json({ code: 401, error: { message: "bad token" } }, 401);
    if (init?.method === "POST" && u.pathname === "/orders") {
      if (fail) return json({ code: 400, result: "Recipient address is invalid" }, 400);
      const body = JSON.parse(init.body!);
      orders.push({ ...body, confirm: u.searchParams.get("confirm") });
      return json({ code: 200, result: { id: 9000 + orders.length, status: "draft", costs: { total: "14.50", currency: "USD" } } });
    }
    if (u.pathname === "/stores") return json({ code: 200, result: [{ id: 77, name: "My shop" }] });
    const m = /^\/products\/variant\/(\d+)$/.exec(u.pathname);
    if (m) return m[1] === "1001" || m[1] === "1002" ? json({ code: 200, result: { variant: { name: `Poster ${m[1]}` } } }) : json({ code: 404, result: "Not found" }, 404);
    return json({ code: 404, result: "Not found" }, 404);
  };
  return { fetchImpl, orders };
}

async function agent(h: TestHost, name: string) {
  const who = await signIn(h.url);
  const sb = await createSandbox({ config: h.config, store: h.store, driver: h.driver, containerHostUrl: "http://automaton-host:4820" }, { owner: who.address, name });
  h.store.updateSandbox(sb.id, { occupant: who.address });
  h.store.ensureAccount(who.address, name);
  return { ...who, sandbox: sb };
}

async function shop(h: TestHost, method: string, p: string, form?: Record<string, string>, headers: Record<string, string> = {}) {
  const res = await fetch(h.shopUrl + p, {
    method,
    redirect: "manual",
    headers: form ? { "content-type": "application/x-www-form-urlencoded", ...headers } : headers,
    body: form ? new URLSearchParams(form).toString() : undefined,
  });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, text: buf.toString("utf-8"), buf };
}

async function buy(h: TestHost, stripe: ReturnType<typeof fakeStripe>, listingId: string, form: Record<string, string> = {}) {
  const r = await shop(h, "POST", `/p/${listingId}/buy`, form);
  expect(r.status).toBe(303);
  const sessionId = /cs_test_\d+/.exec(r.headers.get("location")!)![0];
  const success = new URL(stripe.sessions.get(sessionId).params.success_url);
  return { sessionId, orderPath: success.pathname + success.search, orderId: success.pathname.split("/").pop()!, key: success.searchParams.get("k")! };
}

const link = (html: string) => /href="(\/d\/[A-Za-z0-9_-]+)"/.exec(html)![1]!;

describe("made-to-order services", () => {
  let h: TestHost;
  let stripe: ReturnType<typeof fakeStripe>;
  beforeEach(async () => {
    stripe = fakeStripe();
    h = await startTestHost({ storefront: OPEN }, { stripeKey: "sk_test_x", fetchImpl: stripe.fetchImpl });
  });
  afterEach(async () => h.close());

  const service = (over: Record<string, unknown> = {}) => ({
    kind: "service", title: "Custom haiku", description: "A haiku about anything you like.", price_cents: 800, delivery_hours: 24, request_prompt: "What should the haiku be about?", ...over,
  });

  it("validates service listings", async () => {
    const a = await agent(h, "poet");
    const err = async (over: Record<string, unknown>) => (await call(h.url, "POST", "/v1/store/listings", a.apiKey, service(over))).json.error;
    expect(await err({ delivery_hours: 0 })).toMatch(/delivery_hours/);
    expect(await err({ delivery_hours: 500 })).toMatch(/delivery_hours/);
    expect(await err({ delivery_hours: 2.5 })).toMatch(/delivery_hours/);
    expect(await err({ request_prompt: "" })).toMatch(/request_prompt/);
    expect(await err({ kind: "rental" })).toMatch(/kind must be one of/);
    const ok = await call(h.url, "POST", "/v1/store/listings", a.apiKey, service());
    expect(ok.json).toMatchObject({ kind: "service", delivery_hours: 24, request_prompt: "What should the haiku be about?", file_bytes: 0, on_sale: true });
  });

  it("takes the request at checkout, pays the agent only on delivery, and delivers the file", async () => {
    const a = await agent(h, "poet");
    const l = (await call(h.url, "POST", "/v1/store/listings", a.apiKey, service())).json;
    const page = await shop(h, "GET", `/p/${l.id}`);
    expect(page.text).toContain("What should the haiku be about?");
    expect(page.text).toContain('<textarea id="request" name="request" required');
    expect(page.text).toContain("delivered within 24 hours or your money back");
    expect((await shop(h, "POST", `/p/${l.id}/buy`, {})).status).toBe(400);

    const o = await buy(h, stripe, l.id, { request: "Autumn <b>rain</b> on a tin roof" });
    stripe.pay(o.sessionId);
    const waiting = await shop(h, "GET", o.orderPath);
    expect(waiting.text).toContain("Request received");
    expect(waiting.text).toContain("Autumn &lt;b&gt;rain&lt;/b&gt; on a tin roof");
    expect(waiting.text).toContain("you are refunded automatically");
    expect(h.store.getBalanceMicro(a.address)).toBe(0);

    const owed = await call(h.url, "GET", "/v1/store/orders", a.apiKey);
    expect(owed.json.orders).toEqual([expect.objectContaining({ id: o.orderId, request: "Autumn <b>rain</b> on a tin roof", price_cents: 800 })]);

    const other = await agent(h, "thief");
    expect((await call(h.url, "POST", `/v1/store/orders/${o.orderId}/deliver`, other.apiKey, { filename: "x.txt", content_base64: b64("x") })).status).toBe(404);
    const d = await call(h.url, "POST", `/v1/store/orders/${o.orderId}/deliver`, a.apiKey, { filename: "haiku.txt", content_base64: b64("rain taps the tin roof\n"), note: "Thanks for <ordering>" });
    expect(d.json).toMatchObject({ status: "delivered", credited_micro_usd: usd(7.468) });
    // $8.00 less 2.9% and 30 cents.
    expect(h.store.getBalanceMicro(a.address)).toBe(usd(7.468));
    expect((await call(h.url, "POST", `/v1/store/orders/${o.orderId}/deliver`, a.apiKey, { filename: "x.txt", content_base64: b64("x") })).status).toBe(409);

    const ready = await shop(h, "GET", o.orderPath);
    expect(ready.text).toContain("Your order is ready");
    expect(ready.text).toContain("Thanks for &lt;ordering&gt;");
    const file = await shop(h, "GET", link(ready.text));
    expect(file.text).toBe("rain taps the tin roof\n");
    expect(file.headers.get("content-disposition")).toBe('attachment; filename="haiku.txt"');
    expect((await call(h.url, "GET", "/v1/store/orders", a.apiKey)).json.orders).toEqual([]);
    expect(h.store.verifyLedger()).toEqual([]);
  });

  it("refunds the buyer automatically when the deadline passes, and the agent gets nothing", async () => {
    const a = await agent(h, "poet");
    const l = (await call(h.url, "POST", "/v1/store/listings", a.apiKey, service())).json;
    const o = await buy(h, stripe, l.id, { request: "the sea" });
    stripe.pay(o.sessionId);
    await shop(h, "GET", o.orderPath);
    expect((await h.storefront.pollOrders()).refunded).toBe(0);
    const r = await h.storefront.pollOrders(Date.now() + 25 * 3_600_000);
    expect(r.refunded).toBe(1);
    expect(stripe.refunds).toEqual([`pi_${o.sessionId}`]);
    expect(h.store.getBalanceMicro(a.address)).toBe(0);
    expect((await shop(h, "GET", o.orderPath)).text).toContain("not delivered by the deadline");
    const late = await call(h.url, "POST", `/v1/store/orders/${o.orderId}/deliver`, a.apiKey, { filename: "x.txt", content_base64: b64("x") });
    expect(late.status).toBe(409);
    expect((await h.storefront.pollOrders(Date.now() + 26 * 3_600_000)).refunded).toBe(0);
  });

  it("refuses delivery after the deadline even before the refund runs", async () => {
    const a = await agent(h, "poet");
    const l = (await call(h.url, "POST", "/v1/store/listings", a.apiKey, service())).json;
    const o = await buy(h, stripe, l.id, { request: "the sea" });
    stripe.pay(o.sessionId);
    await shop(h, "GET", o.orderPath);
    h.store.db.prepare("UPDATE orders SET due_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), o.orderId);
    expect((await call(h.url, "POST", `/v1/store/orders/${o.orderId}/deliver`, a.apiKey, { filename: "x.txt", content_base64: b64("x") })).json.code).toBe("overdue");
  });

  it("lets the creator refund waiting work without charging the agent, and refunds it when the agent dies", async () => {
    const a = await agent(h, "poet");
    const l = (await call(h.url, "POST", "/v1/store/listings", a.apiKey, service())).json;
    const one = await buy(h, stripe, l.id, { request: "one" });
    const two = await buy(h, stripe, l.id, { request: "two" });
    stripe.pay(one.sessionId);
    stripe.pay(two.sessionId);
    await h.storefront.pollOrders();
    expect((await h.storefront.refund(one.orderId)).status).toBe("refunded");
    expect(h.store.getBalanceMicro(a.address)).toBe(0);
    await h.economy.die(a.address, "test");
    expect(h.storefront.getOrder(two.orderId)!.status).toBe("refunded");
    expect(stripe.refunds).toHaveLength(2);
  });
});

describe("subscriptions", () => {
  let h: TestHost;
  let stripe: ReturnType<typeof fakeStripe>;
  beforeEach(async () => {
    stripe = fakeStripe();
    h = await startTestHost({ storefront: OPEN }, { stripeKey: "sk_test_x", fetchImpl: stripe.fetchImpl });
  });
  afterEach(async () => h.close());

  it("bills monthly, pays the agent per paid invoice, and delivers drops published while subscribed", async () => {
    const a = await agent(h, "weekly");
    const l = (await call(h.url, "POST", "/v1/store/listings", a.apiKey, { kind: "subscription", title: "Weekly datasets", description: "A fresh dataset every week.", price_cents: 500 })).json;
    expect(l).toMatchObject({ kind: "subscription", subscribers: 0 });
    expect((await call(h.url, "POST", `/v1/store/listings/${l.id}/drops`, a.apiKey, { title: "Before you joined", filename: "old.csv", content_base64: b64("old") })).status).toBe(201);
    const page = await shop(h, "GET", `/p/${l.id}`);
    expect(page.text).toContain("$5.00 a month");
    expect(page.text).toContain("Subscribe for $5.00 a month");

    const o = await buy(h, stripe, l.id);
    expect(stripe.sessions.get(o.sessionId).params).toMatchObject({ mode: "subscription", "line_items[0][price_data][recurring][interval]": "month" });
    stripe.pay(o.sessionId);
    const active = await shop(h, "GET", o.orderPath);
    expect(active.text).toContain("Your subscription is active");
    expect(active.text).toContain("Nothing has been published since you subscribed");
    expect(h.store.getBalanceMicro(a.address)).toBe(usd(4.555));

    const drop = await call(h.url, "POST", `/v1/store/listings/${l.id}/drops`, a.apiKey, { title: "Week 1", filename: "week1.csv", content_base64: b64("a,b\n1,2\n") });
    expect(drop.json).toMatchObject({ title: "Week 1", subscribers: 1 });
    const withDrop = await shop(h, "GET", o.orderPath);
    expect(withDrop.text).toContain("Week 1");
    expect(withDrop.text).not.toContain("Before you joined");
    expect((await shop(h, "GET", link(withDrop.text))).text).toBe("a,b\n1,2\n");

    // Next month's invoice pays the agent again, once.
    stripe.invoices.push({ id: "in_month2", subscription: `sub_${o.sessionId}`, status: "paid", amount_paid: 500 });
    await h.storefront.pollOrders();
    await h.storefront.pollOrders();
    expect(h.store.getBalanceMicro(a.address)).toBe(usd(9.11));
    expect((await call(h.url, "GET", "/v1/store", a.apiKey)).json.listings[0]).toMatchObject({ subscribers: 1, drops: 2, sales_net_micro_usd: usd(9.11) });
    expect(h.store.verifyLedger()).toEqual([]);
  });

  it("lets the buyer cancel at the end of the month, and keeps what was published while it ran", async () => {
    const a = await agent(h, "weekly");
    const l = (await call(h.url, "POST", "/v1/store/listings", a.apiKey, { kind: "subscription", title: "Weekly", description: "x", price_cents: 500 })).json;
    const o = await buy(h, stripe, l.id);
    stripe.pay(o.sessionId);
    await shop(h, "GET", o.orderPath);
    await call(h.url, "POST", `/v1/store/listings/${l.id}/drops`, a.apiKey, { title: "During", filename: "d.txt", content_base64: b64("d") });
    expect((await shop(h, "POST", `/order/${o.orderId}/cancel`, { k: "wrong" })).status).toBe(404);
    const c = await shop(h, "POST", `/order/${o.orderId}/cancel`, { k: o.key });
    expect(c.status).toBe(303);
    expect(stripe.subs.get(`sub_${o.sessionId}`).cancel_at_period_end).toBe(true);
    expect((await shop(h, "GET", o.orderPath)).text).toContain("Cancels at the end of the paid month");

    stripe.subs.get(`sub_${o.sessionId}`).status = "canceled";
    await h.storefront.pollOrders();
    expect(h.storefront.getOrder(o.orderId)!.status).toBe("canceled");
    await new Promise((r) => setTimeout(r, 5));
    await call(h.url, "POST", `/v1/store/listings/${l.id}/drops`, a.apiKey, { title: "After", filename: "a.txt", content_base64: b64("a") });
    const ended = await shop(h, "GET", o.orderPath);
    expect(ended.text).toContain("This subscription has ended");
    expect(ended.text).toContain("During");
    expect(ended.text).not.toContain(">After<");
    await expect(h.storefront.refund(o.orderId)).rejects.toThrow(/Stripe dashboard/);
  });

  it("cancels every subscription at once when the agent dies", async () => {
    const a = await agent(h, "weekly");
    const l = (await call(h.url, "POST", "/v1/store/listings", a.apiKey, { kind: "subscription", title: "Weekly", description: "x", price_cents: 500 })).json;
    const o = await buy(h, stripe, l.id);
    stripe.pay(o.sessionId);
    await h.storefront.pollOrders();
    await h.economy.die(a.address, "test");
    expect(stripe.subs.get(`sub_${o.sessionId}`).status).toBe("canceled");
    expect(h.storefront.getOrder(o.orderId)!.status).toBe("canceled");
  });

  it("only accepts drops on the agent's own subscription listings", async () => {
    const a = await agent(h, "weekly");
    const b = await agent(h, "other");
    const sub = (await call(h.url, "POST", "/v1/store/listings", a.apiKey, { kind: "subscription", title: "W", description: "x", price_cents: 500 })).json;
    const file = (await call(h.url, "POST", "/v1/store/listings", a.apiKey, { title: "F", description: "x", price_cents: 500, filename: "f.txt", content_base64: b64("f") })).json;
    expect((await call(h.url, "POST", `/v1/store/listings/${sub.id}/drops`, b.apiKey, { title: "x", filename: "x.txt", content_base64: b64("x") })).status).toBe(404);
    expect((await call(h.url, "POST", `/v1/store/listings/${file.id}/drops`, a.apiKey, { title: "x", filename: "x.txt", content_base64: b64("x") })).json.error).toMatch(/subscription listing/);
  });
});

describe("print-on-demand", () => {
  it("is off without a Printful token", async () => {
    const h = await startTestHost({ storefront: OPEN, printful: PRINTFUL }, { stripeKey: "sk_test_x", fetchImpl: fakeStripe().fetchImpl });
    try {
      const a = await agent(h, "artist");
      const r = await call(h.url, "POST", "/v1/store/listings", a.apiKey, { kind: "print", title: "T", description: "x", price_cents: 2000, pod_product: "poster", content_base64: b64(png(2000, 2000)) });
      expect(r.json.code).toBe("print_disabled");
      expect((await call(h.url, "GET", "/v1/store", a.apiKey)).json.print_products).toEqual([]);
    } finally {
      await h.close();
    }
  });

  describe("with Printful on", () => {
    let h: TestHost;
    let stripe: ReturnType<typeof fakeStripe>;
    let pf: ReturnType<typeof fakePrintful>;
    beforeEach(async () => {
      stripe = fakeStripe();
      pf = fakePrintful();
      h = await startTestHost({ storefront: OPEN, printful: PRINTFUL }, { stripeKey: "sk_test_x", fetchImpl: stripe.fetchImpl }, { printfulToken: "pf_token", printfulFetch: pf.fetchImpl });
    });
    afterEach(async () => h.close());

    const print = (over: Record<string, unknown> = {}) => ({ kind: "print", title: "Mountain at dawn", description: "A minimal poster.", price_cents: 3000, pod_product: "poster", filename: "mountain.png", content_base64: b64(png(2400, 3200)), ...over });

    it("lets agents design only for offered products, at a price above cost, with a large enough PNG", async () => {
      const a = await agent(h, "artist");
      const err = async (over: Record<string, unknown>) => (await call(h.url, "POST", "/v1/store/listings", a.apiKey, print(over))).json.error;
      expect(await err({ pod_product: "mug" })).toMatch(/pod_product must be one of: poster/);
      expect(await err({ price_cents: 1400 })).toMatch(/from 1500/);
      expect(await err({ content_base64: b64("not an image") })).toMatch(/must be a PNG/);
      expect(await err({ content_base64: b64(png(800, 800)) })).toMatch(/at least 1200x1200/);
      const ok = (await call(h.url, "POST", "/v1/store/listings", a.apiKey, print())).json;
      expect(ok).toMatchObject({ kind: "print", pod_product: "poster", on_sale: true });
      expect((await call(h.url, "POST", `/v1/store/listings/${ok.id}`, a.apiKey, { price_cents: 1000 })).json.error).toMatch(/from 1500/);
      expect((await call(h.url, "GET", "/v1/store", a.apiKey)).json.print_products).toEqual([{ key: "poster", name: "Poster 18x24", min_price_cents: 1500, options: ["Matte", "Glossy"] }]);
    });

    it("collects a shipping address, sends the order to Printful, and pays the agent the price less fees and printing", async () => {
      const a = await agent(h, "artist");
      const l = (await call(h.url, "POST", "/v1/store/listings", a.apiKey, print())).json;
      const page = await shop(h, "GET", `/p/${l.id}`);
      const sha = /src="\/design\/([0-9a-f]{64})\.png"/.exec(page.text)![1]!;
      expect(page.text).toContain('<option value="1002">Glossy</option>');
      expect(page.text).toContain(`property="og:image" content="https://shop.example.com/design/${sha}.png"`);
      const img = await shop(h, "GET", `/design/${sha}.png`);
      expect(img.headers.get("content-type")).toBe("image/png");
      expect(img.headers.get("content-security-policy")).toContain("sandbox");
      expect((await shop(h, "GET", `/design/${"0".repeat(64)}.png`)).status).toBe(404);

      expect((await shop(h, "POST", `/p/${l.id}/buy`, { variant: "999" })).status).toBe(400);
      const o = await buy(h, stripe, l.id, { variant: "1002" });
      const params = stripe.sessions.get(o.sessionId).params;
      expect(params).toMatchObject({ "shipping_address_collection[allowed_countries][0]": "US", "shipping_address_collection[allowed_countries][1]": "CA", "line_items[0][price_data][product_data][name]": "Mountain at dawn (Glossy)" });
      stripe.pay(o.sessionId, {
        customer_details: { email: "buyer@example.com", name: "Pat Buyer" },
        collected_information: { shipping_details: { name: "Pat Buyer", address: { line1: "1 Main St", city: "London", state: "ON", country: "CA", postal_code: "N6A 1A1" } } },
      });
      const done = await shop(h, "GET", o.orderPath);
      expect(done.text).toContain("went to our print partner");
      expect(pf.orders).toHaveLength(1);
      expect(pf.orders[0]).toMatchObject({
        external_id: o.orderId,
        confirm: null,
        recipient: { name: "Pat Buyer", address1: "1 Main St", city: "London", state_code: "ON", country_code: "CA", zip: "N6A 1A1", email: "buyer@example.com" },
        items: [{ variant_id: 1002, quantity: 1, files: [{ url: `https://shop.example.com/design/${sha}.png` }] }],
      });
      // $30.00 less 2.9% and 30 cents is $28.83; less $14.50 printing is $14.33.
      expect(h.store.getBalanceMicro(a.address)).toBe(usd(14.33));
      expect(h.storefront.getOrder(o.orderId)).toMatchObject({ status: "fulfilling", printfulOrderId: "9001", costMicro: usd(14.5) });
      // A second visit must not print it twice.
      await shop(h, "GET", o.orderPath);
      await h.storefront.pollOrders();
      expect(pf.orders).toHaveLength(1);

      // A creator refund takes back what the agent got.
      await h.storefront.refund(o.orderId);
      expect(h.store.getBalanceMicro(a.address)).toBe(0);
    });

    it("refunds the buyer when Printful refuses the order", async () => {
      const t = await startTestHost({ storefront: OPEN, printful: PRINTFUL }, { stripeKey: "sk_test_x", fetchImpl: stripe.fetchImpl }, { printfulToken: "pf_token", printfulFetch: fakePrintful(true).fetchImpl });
      try {
        const a = await agent(t, "artist");
        const l = (await call(t.url, "POST", "/v1/store/listings", a.apiKey, print())).json;
        const o = await buy(t, stripe, l.id, { variant: "1001" });
        stripe.pay(o.sessionId, { shipping_details: { name: "Pat", address: { line1: "1 Main", city: "X", country: "US", postal_code: "10001" } } });
        const page = await shop(t, "GET", o.orderPath);
        expect(page.text).toContain("Refunded");
        expect(page.text).toContain("Recipient address is invalid");
        expect(stripe.refunds).toContain(`pi_${o.sessionId}`);
        expect(t.store.getBalanceMicro(a.address)).toBe(0);
      } finally {
        await t.close();
      }
    });
  });

  it("reads PNG sizes and both Stripe shipping shapes", () => {
    expect(pngSize(png(1500, 900))).toEqual({ width: 1500, height: 900 });
    expect(pngSize(Buffer.from("GIF89a"))).toBeNull();
    expect(recipientFromSession({ shipping_details: { name: "A", address: { line1: "1", city: "c", country: "US", postal_code: "z" } } })).toMatchObject({ name: "A", country_code: "US" });
    expect(recipientFromSession({})).toBeNull();
  });

  it("checks Printful settings in host.json", () => {
    const bad = (pf: object) => () => validateHostConfig(testConfig({ printful: { ...PRINTFUL, ...pf } as any }));
    expect(bad({ products: [{ ...POSTER, key: "Bad Key" }] })).toThrow(/key/);
    expect(bad({ products: [POSTER, POSTER] })).toThrow(/twice/);
    expect(bad({ products: [{ ...POSTER, variants: [] }] })).toThrow(/variants/);
    expect(bad({ products: [{ ...POSTER, baseCostCents: 0 }] })).toThrow(/baseCostCents/);
    expect(bad({ shipCountries: ["Canada"] })).toThrow(/two-letter/);
    expect(bad({})).not.toThrow();
  });
});

describe("finding buyers", () => {
  let h: TestHost;
  let stripe: ReturnType<typeof fakeStripe>;
  beforeEach(async () => {
    stripe = fakeStripe();
    h = await startTestHost({ storefront: OPEN }, { stripeKey: "sk_test_x", fetchImpl: stripe.fetchImpl });
  });
  afterEach(async () => h.close());

  it("publishes search-friendly pages, a sitemap, robots rules and RSS feeds", async () => {
    const a = await agent(h, "alpha");
    const l = (await call(h.url, "POST", "/v1/store/listings", a.apiKey, { title: "Prime table", description: "Every prime below 8000.", price_cents: 300, filename: "p.txt", content_base64: b64("2\n") })).json;
    const item = await shop(h, "GET", `/p/${l.id}`);
    expect(item.text).toContain(`<link rel="canonical" href="https://shop.example.com/p/${l.id}">`);
    expect(item.text).toContain(`<meta name="description" content="Every prime below 8000.">`);
    expect(item.text).toContain(`<meta property="og:title" content="Prime table">`);
    const ld = JSON.parse(/<script type="application\/ld\+json">(.*?)<\/script>/.exec(item.text)![1]!);
    expect(ld).toMatchObject({ "@type": "Product", name: "Prime table", offers: { price: "3.00", priceCurrency: "USD", url: `https://shop.example.com/p/${l.id}` } });

    const robots = await shop(h, "GET", "/robots.txt");
    expect(robots.text).toContain("Disallow: /order/");
    expect(robots.text).toContain("Sitemap: https://shop.example.com/sitemap.xml");
    const map = await shop(h, "GET", "/sitemap.xml");
    expect(map.text).toContain(`<loc>https://shop.example.com/s/alpha</loc>`);
    expect(map.text).toContain(`<loc>https://shop.example.com/p/${l.id}</loc>`);
    const feed = await shop(h, "GET", "/s/alpha/feed.xml");
    expect(feed.headers.get("content-type")).toContain("application/rss+xml");
    expect(feed.text).toContain("<title>Prime table</title>");
    expect((await shop(h, "GET", "/feed.xml")).text).toContain(`https://shop.example.com/p/${l.id}`);

    h.storefront.setPulled(l.id, true);
    expect((await shop(h, "GET", "/sitemap.xml")).text).not.toContain(l.id);
  });

  it("queues post drafts for the creator, and counts visits and sales per post", async () => {
    const a = await agent(h, "alpha");
    const b = await agent(h, "beta");
    expect((await call(h.url, "POST", "/v1/promotions", a.apiKey, { platform: "X", text: "hi" })).json.error).toMatch(/Open your store/);
    const l = (await call(h.url, "POST", "/v1/store/listings", a.apiKey, { title: "Prime table", description: "x", price_cents: 300, filename: "p.txt", content_base64: b64("2\n") })).json;
    const bl = (await call(h.url, "POST", "/v1/store/listings", b.apiKey, { title: "B", description: "x", price_cents: 300, filename: "b.txt", content_base64: b64("b") })).json;
    expect((await call(h.url, "POST", "/v1/promotions", a.apiKey, { platform: "X", text: "hi", listing_id: bl.id })).status).toBe(404);
    const p = (await call(h.url, "POST", "/v1/promotions", a.apiKey, { platform: "Reddit r/datasets", text: "Made by an AI agent: every prime below 8000.", listing_id: l.id })).json;
    expect(p).toMatchObject({ status: "draft", link: `https://shop.example.com/p/${l.id}?via=${p.id}`, views: 0, sales: 0 });

    // Two visits from one person count once; another person counts.
    await shop(h, "GET", `/p/${l.id}?via=${p.id}`, undefined, { "cf-connecting-ip": "198.51.100.1" });
    await shop(h, "GET", `/p/${l.id}?via=${p.id}`, undefined, { "cf-connecting-ip": "198.51.100.1" });
    const page = await shop(h, "GET", `/p/${l.id}?via=${p.id}`, undefined, { "cf-connecting-ip": "198.51.100.2" });
    expect(page.text).toContain(`<input type="hidden" name="via" value="${p.id}">`);
    // Someone else's post id on this agent's page is ignored.
    const bp = (await call(h.url, "POST", "/v1/promotions", b.apiKey, { platform: "X", text: "b" })).json;
    await shop(h, "GET", `/p/${l.id}?via=${bp.id}`);
    expect((await call(h.url, "GET", "/v1/promotions", b.apiKey)).json.promotions[0].views).toBe(0);

    const o = await buy(h, stripe, l.id, { via: p.id });
    stripe.pay(o.sessionId);
    await h.storefront.pollOrders();
    const mine = (await call(h.url, "GET", "/v1/promotions", a.apiKey)).json.promotions[0];
    expect(mine).toMatchObject({ views: 2, sales: 1 });
    expect(h.storefront.setPromotionStatus(p.id, "posted").status).toBe("posted");

    const store = await shop(h, "GET", `/s/alpha?via=${p.id}`);
    expect(store.text).toContain(`href="/p/${l.id}?via=${p.id}"`);
  });

  it("caps waiting drafts per agent", async () => {
    const t = await startTestHost({ storefront: { ...OPEN, maxPromotionDrafts: 2 } }, { stripeKey: "sk_test_x", fetchImpl: stripe.fetchImpl });
    try {
      const a = await agent(t, "alpha");
      await call(t.url, "POST", "/v1/store/listings", a.apiKey, { title: "P", description: "x", price_cents: 300, filename: "p.txt", content_base64: b64("2") });
      for (let i = 0; i < 2; i++) expect((await call(t.url, "POST", "/v1/promotions", a.apiKey, { platform: "X", text: `post ${i}` })).status).toBe(201);
      expect((await call(t.url, "POST", "/v1/promotions", a.apiKey, { platform: "X", text: "post 3" })).json.code).toBe("too_many_drafts");
      t.storefront.setPromotionStatus(t.storefront.listPromotions()[0]!.id, "posted");
      expect((await call(t.url, "POST", "/v1/promotions", a.apiKey, { platform: "X", text: "post 3" })).status).toBe(201);
    } finally {
      await t.close();
    }
  });
});

describe("selftest", () => {
  let h: TestHost;
  let hostDir: string;
  beforeEach(async () => {
    h = await startTestHost({ storefront: OPEN, printful: PRINTFUL });
    hostDir = path.dirname(h.filesDir);
  });
  afterEach(async () => h.close());

  /** Routes the "public address" to the local storefront, and Stripe and Printful to fakes. */
  function world(opts: { leakDashboard?: boolean; stripeLive?: boolean } = {}) {
    const pf = fakePrintful();
    const calls: string[] = [];
    const sessions = new Map<string, any>();
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      const u = new URL(url);
      const json = (o: any, status = 200) => ({ ok: status < 400, status, json: async () => o, text: async () => JSON.stringify(o) });
      if (u.hostname === "shop.example.com") {
        if (opts.leakDashboard && u.pathname === "/api/overview") return json({ agents: [] });
        const r = await fetch(h.shopUrl + u.pathname + u.search);
        const text = await r.text();
        return { ok: r.ok, status: r.status, json: async () => JSON.parse(text), text: async () => text, headers: r.headers };
      }
      if (u.hostname === "api.stripe.com") {
        if (u.pathname === "/v1/balance") return json({ livemode: !!opts.stripeLive });
        if (u.pathname === "/v1/checkout/sessions") {
          const id = `cs_${sessions.size + 1}`;
          sessions.set(id, { id, url: `https://checkout.stripe.com/${id}`, params: Object.fromEntries(new URLSearchParams(init?.body)) });
          return json(sessions.get(id));
        }
        if (/\/v1\/checkout\/sessions\/[^/]+\/expire$/.test(u.pathname)) return json({ status: "expired" });
        if (u.pathname === "/v1/payment_intents") return json({ id: "pi_1", status: "succeeded" });
        if (u.pathname === "/v1/refunds") return json({ id: "re_1", status: "succeeded" });
      }
      if (u.hostname === "api.printful.example") return pf.fetchImpl(url, init);
      if (u.hostname === "hn.algolia.com") return json({ hits: [{ title: "a" }, { title: "b" }] });
      if (u.hostname === "wikimedia.org") return json({ items: [{ articles: [{ article: "X", views: 5 }] }] });
      return json({ error: { message: "unexpected " + url } }, 500);
    };
    const chat = async (model: any) => ({ id: "x", model: model.id, message: { role: "assistant" as const, content: "ready" }, usage: { promptTokens: 12, completionTokens: 1, totalTokens: 13 }, finishReason: "stop" });
    return { fetchImpl, calls, sessions, chat };
  }

  it("passes against working services and leaves nothing behind", async () => {
    const w = world();
    const results = await runSelftest({ config: h.config, hostDir, stripeKey: "sk_test_abc", printfulToken: "pf_token", fetchImpl: w.fetchImpl, chat: w.chat as any, tunnelTimeoutMs: 2000 });
    const text = formatSelftest(results);
    expect(results.filter((r) => !r.ok)).toEqual([]);
    expect(text).toContain("PASS  model");
    expect(text).toContain("PASS  stripe   test payment and refund");
    expect(text).toContain("PASS  tunnel   public address reaches this storefront");
    expect(text).toContain("PASS  tunnel   agent API and dashboard stay private");
    expect(text).toContain("PASS  printful poster Glossy: Poster 1002");
    expect(text).toContain("PASS  research Hacker News: 2 front-page stories");
    expect(text).toContain("PASS  research Wikipedia pageviews: 1 top articles");
    expect(text).toContain("All checks passed.");
    expect([...w.sessions.values()].map((s) => s.params.mode)).toEqual(["payment", "subscription", "payment"]);
    expect(fs.existsSync(path.join(hostDir, "selftest-nonce"))).toBe(false);
    expect(w.calls.some((c) => c.includes("/orders"))).toBe(false);
  });

  it("refuses live Stripe keys, and reports a leaking tunnel and missing settings", async () => {
    const w = world({ leakDashboard: true });
    const t = await startTestHost({ storefront: { ...OPEN, operatorName: "" } });
    try {
      const live = await runSelftest({ config: t.config, hostDir: path.dirname(t.filesDir), stripeKey: "sk_live_abc", only: ["stripe"], fetchImpl: w.fetchImpl });
      expect(live.find((r) => r.name === "Stripe key")).toMatchObject({ ok: false, detail: expect.stringMatching(/LIVE key/) });
      expect(live.find((r) => r.name === "store owner details")).toMatchObject({ ok: false });
      expect(w.calls.some((c) => c.includes("stripe"))).toBe(false);
    } finally {
      await t.close();
    }
    const leak = await runSelftest({ config: h.config, hostDir, only: ["tunnel"], fetchImpl: w.fetchImpl, tunnelTimeoutMs: 2000 });
    expect(leak.find((r) => r.name === "agent API and dashboard stay private")).toMatchObject({ ok: false, detail: expect.stringContaining("/api/overview") });
  });

  it("reports a tunnel that points somewhere else", async () => {
    const elsewhere: FetchLike = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => "some other site" });
    const r = await runSelftest({ config: h.config, hostDir, only: ["tunnel"], fetchImpl: elsewhere, tunnelTimeoutMs: 1200 });
    expect(r[0]).toMatchObject({ ok: false, detail: expect.stringContaining("some other site") });
  });
});

describe("agent context", () => {
  it("keeps tools that return work to act on in the next turn's context", () => {
    // Idle-only turns are dropped from context; these results must survive to the next turn.
    for (const name of ["list_jobs", "my_store", "list_store_orders"]) expect(isIdleOnlyTool(name)).toBe(false);
    for (const name of ["check_fitness", "my_promotions", "list_payment_links"]) expect(isIdleOnlyTool(name)).toBe(true);
  });
});
