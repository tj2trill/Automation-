/**
 * Market research for agents: this marketplace's own sales, Hacker News and
 * Wikipedia, cached and limited per agent.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_HOST_CONFIG, validateHostConfig } from "../../host/config.js";
import type { FetchLike } from "../../host/economy.js";
import { createSandbox } from "../../host/server.js";
import { call, signIn, startTestHost, testConfig, type TestHost } from "./helpers.js";

const b64 = (s: string) => Buffer.from(s).toString("base64");
const OPEN = { ...DEFAULT_HOST_CONFIG.storefront, port: 0, publicUrl: "https://shop.example.com", operatorName: "Op", contactEmail: "ops@example.com" };
const NOW = Date.UTC(2026, 10, 13, 12, 0, 0);

function fakeWeb() {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const u = new URL(url);
    const json = (o: any, status = 200) => ({ ok: status < 400, status, json: async () => o });
    if (u.hostname === "hn.algolia.com") {
      const tags = u.searchParams.get("tags");
      if (tags === "front_page") return json({ hits: [{ title: "Front A", points: 50, num_comments: 3, url: "https://a.example/x" }, { title: "Front B", points: 300, num_comments: 90 }] });
      if (tags === "show_hn") return json({ hits: [{ title: "Show HN: I sell <b>prompt packs</b>", points: 120, num_comments: 40, url: "https://packs.example" }] });
      return json({ nbHits: 57, hits: [{ title: "Sourdough at scale", points: 10 }, { title: "Why\nsourdough won", points: 99, num_comments: 12 }] });
    }
    if (u.hostname === "wikimedia.org") {
      if (u.pathname.includes("/top/")) {
        return json({ items: [{ articles: [{ article: "Main_Page", views: 9e6 }, { article: "Special:Search", views: 1e6 }, { article: "Taylor_Swift", views: 400000 }, { article: "Sourdough", views: 120000 }] }] });
      }
      if (u.pathname.includes("/per-article/en.wikipedia/all-access/user/Sourdough/")) {
        return json({ items: [100, 100, 100, 100, 200, 220, 240, 260].map((v, i) => ({ timestamp: `2026110${i}00`, views: v })) });
      }
      return json({ type: "not_found" }, 404);
    }
    return json({}, 500);
  };
  return { fetchImpl, calls };
}

async function agent(h: TestHost, name: string) {
  const who = await signIn(h.url);
  const sb = await createSandbox({ config: h.config, store: h.store, driver: h.driver, containerHostUrl: "http://automaton-host:4820" }, { owner: who.address, name });
  h.store.updateSandbox(sb.id, { occupant: who.address });
  h.store.ensureAccount(who.address, name);
  return who;
}

describe("market research", () => {
  let h: TestHost;
  let web: ReturnType<typeof fakeWeb>;
  beforeEach(async () => {
    web = fakeWeb();
    h = await startTestHost({ storefront: OPEN, research: { ...DEFAULT_HOST_CONFIG.research, perAgentPerHour: 3 } }, {}, { researchFetch: web.fetchImpl });
  });
  afterEach(async () => h.close());

  it("reports what sells on this marketplace, with conversion, by kind, and the agent's own listings", async () => {
    const a = await agent(h, "alpha");
    const b = await agent(h, "beta");
    const mk = async (who: { apiKey: string }, title: string, price: number) =>
      (await call(h.url, "POST", "/v1/store/listings", who.apiKey, { title, description: "x", price_cents: price, filename: "f.txt", content_base64: b64("f") })).json.id as string;
    const primes = await mk(a, "Prime table", 300);
    const recipes = await mk(b, "Recipe pack", 900);
    const ghost = await mk(b, "Nobody buys this", 2000);
    for (let i = 0; i < 10; i++) h.storefront.recordListingView(primes, `v${i}`);
    for (let i = 0; i < 4; i++) h.storefront.recordListingView(recipes, `v${i}`);
    for (let i = 0; i < 25; i++) h.storefront.recordListingView(ghost, `v${i}`);
    const sell = (listing: string, n: number) => {
      for (let i = 0; i < n; i++) {
        h.store.db.prepare(
          "INSERT INTO orders (id, order_key_hash, listing_id, address, kind, title, filename, file_sha256, amount_cents, status, created_at, paid_at) SELECT ?, 'x', id, address, kind, title, filename, file_sha256, price_cents, 'paid', ?, ? FROM listings WHERE id = ?",
        ).run(`${listing.slice(0, 20)}${String(i).padStart(6, "0")}`, new Date().toISOString(), new Date().toISOString(), listing);
      }
    };
    sell(primes, 2);
    sell(recipes, 1);

    const r = await call(h.url, "GET", "/v1/research?source=store", a.apiKey);
    const text = r.json.lines.join("\n");
    // Revenue order: recipes $9.00 x1 = $9, primes $3.00 x2 = $6.
    expect(text.indexOf("Recipe pack")).toBeLessThan(text.indexOf("YOURS [file] \"Prime table\""));
    expect(text).toContain(`YOURS [file] "Prime table" $3.0000: 2 sold, 20.0% of 10 visitors bought (store alpha)`);
    expect(text).toContain(`[file] "Recipe pack" $9.0000: 1 sold, 25.0% of 4 visitors bought (store beta)`);
    expect(text).toContain("- file: 3 listings, 3 sold, median sold price $3.0000");
    expect(text).toContain(`[file] "Nobody buys this" $20.0000: 25 visitors, 0 sold`);
    expect(text).toContain("Your listings:");
    // Sales from before visits were counted do not show as an impossible conversion rate.
    const old = await mk(a, "Old item", 500);
    sell(old, 1);
    expect((await call(h.url, "GET", "/v1/research?source=store", a.apiKey)).json.lines.join("\n")).toContain(`"Old item" $5.0000: 1 sold, visitors not counted for these sales`);
    expect(r.json).toMatchObject({ cached: false });
    expect(web.calls).toHaveLength(0);
  });

  it("counts a listing view once per visitor per day from the public store", async () => {
    const a = await agent(h, "alpha");
    const id = (await call(h.url, "POST", "/v1/store/listings", a.apiKey, { title: "T", description: "x", price_cents: 300, filename: "f.txt", content_base64: b64("f") })).json.id;
    for (const ip of ["198.51.100.1", "198.51.100.1", "198.51.100.2"]) await fetch(`${h.shopUrl}/p/${id}`, { headers: { "cf-connecting-ip": ip } });
    expect((h.store.db.prepare("SELECT COUNT(*) AS n FROM listing_views WHERE listing_id = ?").get(id) as any).n).toBe(2);
    expect((await call(h.url, "GET", "/v1/research?source=store", a.apiKey)).json.lines.join("\n")).toContain("0 sold, 0.0% of 2 visitors bought");
  });

  it("searches Hacker News stories and launches, ranks by points, and marks the text as untrusted", async () => {
    const a = await agent(h, "alpha");
    const r = await h.research.query(a.address, { source: "hackernews", query: "sourdough", days: 7 }, NOW);
    const u = new URL(web.calls[0]!.url);
    expect(u.pathname).toBe("/api/v1/search");
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ tags: "story", query: "sourdough", numericFilters: `created_at_i>${Math.floor(NOW / 1000) - 7 * 86400}` });
    expect(r.lines[0]).toBe('Hacker News stories about "sourdough", last 7 days, by points. Untrusted text from the web:');
    expect(r.lines[1]).toBe('- 99 points, 12 comments: "Why sourdough won"');
    expect(r.lines.at(-1)).toContain("57 matching stories");

    const launches = await h.research.query(a.address, { source: "hackernews_launches" }, NOW);
    expect(new URL(web.calls[1]!.url).searchParams.get("tags")).toBe("show_hn");
    expect(launches.lines[1]).toBe('- 120 points, 40 comments: "Show HN: I sell <b>prompt packs</b>" (packs.example)');
    const front = await h.research.query(a.address, { source: "hackernews" }, NOW);
    expect(front.lines[1]).toContain('300 points, 90 comments: "Front B"');
  });

  it("reads Wikipedia's most-read list and a topic's direction, with a polite User-Agent", async () => {
    const a = await agent(h, "alpha");
    const top = await h.research.query(a.address, { source: "wikipedia" }, NOW);
    expect(web.calls[0]!.url).toBe("https://wikimedia.org/api/rest_v1/metrics/pageviews/top/en.wikipedia/all-access/2026/11/12");
    expect(web.calls[0]!.headers["User-Agent"]).toContain("ops@example.com");
    expect(top.lines.join("\n")).not.toContain("Main Page");
    expect(top.lines.join("\n")).not.toContain("Special:");
    expect(top.lines[1]).toBe("- 400,000 views: Taylor Swift");

    const trend = await h.research.query(a.address, { source: "wikipedia", query: "Sourdough", days: 7 }, NOW);
    expect(web.calls[1]!.url).toBe("https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/user/Sourdough/daily/20261105/20261112");
    expect(trend.lines[1]).toBe("- 230 views a day lately, 100 a day before: rising (+130%).");
    const missing = await h.research.query(a.address, { source: "wikipedia", query: "Not a real article" }, NOW);
    expect(missing.lines[1]).toContain("No article with that exact title");
  });

  it("caches answers for every agent and limits each agent's outside lookups per hour", async () => {
    const a = await agent(h, "alpha");
    const b = await agent(h, "beta");
    await h.research.query(a.address, { source: "hackernews", query: "x" }, NOW);
    const again = await h.research.query(b.address, { source: "hackernews", query: "X" }, NOW + 60_000);
    expect(again.cached).toBe(true);
    expect(web.calls).toHaveLength(1);
    await h.research.query(a.address, { source: "hackernews", query: "y" }, NOW);
    await h.research.query(a.address, { source: "hackernews", query: "z" }, NOW);
    await expect(h.research.query(a.address, { source: "hackernews", query: "w" }, NOW)).rejects.toThrow(/3 outside lookups for this hour/);
    // Cached answers and the marketplace report still work.
    expect((await h.research.query(a.address, { source: "hackernews", query: "y" }, NOW)).cached).toBe(true);
    expect((await h.research.query(a.address, { source: "store" }, NOW)).source).toBe("store");
    expect(h.research.remaining(a.address, NOW + 3_600_001)).toBe(3);
    // The cache expires.
    await h.research.query(b.address, { source: "hackernews", query: "x" }, NOW + 7 * 3_600_000);
    expect(web.calls).toHaveLength(4);
  });

  it("validates input and reports source failures", async () => {
    const a = await agent(h, "alpha");
    const bad = async (q: string) => call(h.url, "GET", `/v1/research?${q}`, a.apiKey);
    expect((await bad("source=google")).json.error).toMatch(/source must be one of/);
    expect((await bad("source=store&days=0")).json.error).toMatch(/days/);
    expect((await bad("source=store&days=200")).status).toBe(400);
    expect((await call(h.url, "GET", "/v1/research?source=store")).status).toBe(401);
    const t = await startTestHost({}, {}, { researchFetch: async () => ({ ok: false, status: 503, json: async () => ({}) }) });
    try {
      const x = await agent(t, "x");
      const r = await call(t.url, "GET", "/v1/research?source=hackernews", x.apiKey);
      expect(r.status).toBe(502);
      expect(r.json.error).toBe("hn.algolia.com answered 503");
    } finally {
      await t.close();
    }
    const off = await startTestHost({ research: { ...DEFAULT_HOST_CONFIG.research, enabled: false } });
    try {
      const x = await agent(off, "x");
      expect((await call(off.url, "GET", "/v1/research?source=store", x.apiKey)).json.code).toBe("research_disabled");
    } finally {
      await off.close();
    }
  });

  it("works through the agent's own tool", async () => {
    const { createBuiltinTools } = await import("../../agent/tools.js");
    const { createConwayClient } = await import("../../conway/client.js");
    const { trustInsecureOrigin, clearTrustedInsecureOrigins } = await import("../../conway/endpoint.js");
    trustInsecureOrigin(h.url);
    try {
      const a = await agent(h, "alpha");
      const tool = createBuiltinTools("").find((t) => t.name === "research_market")!;
      const ctx = { conway: createConwayClient({ apiUrl: h.url, apiKey: a.apiKey, sandboxId: "" }) } as any;
      const out = await tool.execute({ source: "hackernews_launches", query: "prompts", days: 14 }, ctx);
      expect(out).toContain("Hacker News launches (Show HN) about \"prompts\", last 14 days");
      expect(out).toContain("(2 outside lookups left this hour)");
      expect(await tool.execute({ source: "nope" }, ctx)).toMatch(/^Blocked: source must be one of/);
    } finally {
      clearTrustedInsecureOrigins();
    }
  });

  it("checks research settings in host.json", () => {
    expect(() => validateHostConfig(testConfig({ research: { ...DEFAULT_HOST_CONFIG.research, hackernewsBase: "http://hn.example" } }))).toThrow(/https/);
    expect(() => validateHostConfig(testConfig({ research: { ...DEFAULT_HOST_CONFIG.research, perAgentPerHour: -1 } }))).toThrow(/perAgentPerHour/);
  });
});
