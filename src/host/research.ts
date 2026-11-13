/**
 * Host Control Plane — Market research for agents
 *
 * Agents decide what to make and sell. This gives them evidence instead of
 * guesses, from three sources:
 *
 *   store       This host's own marketplace: what sells across every agent's
 *               store, at what price, how many visitors each item gets and
 *               how many of them buy. The most direct evidence there is: real
 *               buyers spending real money here.
 *   hackernews  The Hacker News search API (hn.algolia.com, free, no key):
 *               stories on a topic in the last N days ranked by points, or the
 *               front page; "hackernews_launches" ranks recent Show HN posts,
 *               which is what people are building and selling.
 *   wikipedia   The Wikimedia pageviews API (free, no key): the most-read
 *               articles yesterday, or whether interest in one topic is
 *               rising or falling over the last N days.
 *
 * The host makes these calls, not the agent: answers are cached and shared
 * between agents, each agent has an hourly allowance, and the outside
 * services see one polite client. Text from outside sources is returned to
 * the agent marked as untrusted.
 *
 *   businesses  OpenStreetMap (free, no key): businesses of a kind in a place,
 *               with any website, email and phone mappers recorded. Places
 *               are looked up with Nominatim (at most one request a second);
 *               businesses with Overpass, capped per day for the whole host.
 *
 * Google Trends has no generally available official API (its official API is
 * a gated alpha), so it is not a source here. Agents can still read public
 * web pages themselves from their containers.
 */

import type { HostConfig } from "./config.js";
import type { FetchLike } from "./economy.js";
import type { Storefront } from "./storefront.js";
import { formatUsd, normalizeAddress, type HostStore } from "./store.js";

export const RESEARCH_SOURCES = ["store", "hackernews", "hackernews_launches", "wikipedia", "businesses"] as const;

/**
 * Plain words for kinds of business, mapped to OpenStreetMap tags. An agent
 * may also give a tag directly, like "shop=bicycle".
 */
export const BUSINESS_KINDS: Record<string, Array<[string, string]>> = {
  plumber: [["craft", "plumber"]],
  electrician: [["craft", "electrician"]],
  roofer: [["craft", "roofer"]],
  hvac: [["craft", "hvac"]],
  carpenter: [["craft", "carpenter"]],
  painter: [["craft", "painter"]],
  landscaper: [["craft", "gardener"], ["shop", "garden_centre"]],
  locksmith: [["craft", "locksmith"], ["shop", "locksmith"]],
  photographer: [["craft", "photographer"], ["shop", "photo"]],
  cleaner: [["shop", "dry_cleaning"], ["craft", "cleaning"]],
  restaurant: [["amenity", "restaurant"]],
  cafe: [["amenity", "cafe"]],
  bar: [["amenity", "bar"], ["amenity", "pub"]],
  bakery: [["shop", "bakery"]],
  florist: [["shop", "florist"]],
  "hair salon": [["shop", "hairdresser"]],
  "beauty salon": [["shop", "beauty"]],
  barber: [["shop", "hairdresser"]],
  "auto repair": [["shop", "car_repair"]],
  "car dealer": [["shop", "car"]],
  dentist: [["amenity", "dentist"], ["healthcare", "dentist"]],
  "physio": [["healthcare", "physiotherapist"]],
  chiropractor: [["healthcare", "chiropractor"]],
  veterinarian: [["amenity", "veterinary"]],
  gym: [["leisure", "fitness_centre"]],
  lawyer: [["office", "lawyer"]],
  accountant: [["office", "accountant"]],
  "real estate": [["office", "estate_agent"]],
  insurance: [["office", "insurance"]],
  "it services": [["office", "it"]],
  hotel: [["tourism", "hotel"], ["tourism", "guest_house"]],
  "clothing store": [["shop", "clothes"]],
  "pet store": [["shop", "pet"]],
  "hardware store": [["shop", "hardware"], ["shop", "doityourself"]],
  "furniture store": [["shop", "furniture"]],
  jeweller: [["shop", "jewelry"]],
  tattoo: [["shop", "tattoo"]],
};
export type ResearchSource = (typeof RESEARCH_SOURCES)[number];

export class ResearchError extends Error {
  constructor(message: string, public readonly status = 400, public readonly code = "invalid_request") {
    super(message);
    this.name = "ResearchError";
  }
}

export interface ResearchResult {
  source: ResearchSource;
  query: string | null;
  days: number;
  /** Plain lines for the agent. Lines from outside sources are untrusted text. */
  lines: string[];
  cached: boolean;
  fetchedAt: string;
}

/** Outside text as one short, plain line. */
function clip(s: unknown, max = 140): string {
  return String(s ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

const ymd = (d: Date) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;

export class MarketResearch {
  private cache = new Map<string, { at: number; result: ResearchResult }>();
  private places = new Map<string, { at: number; area: { id: number } | { lat: number; lon: number } | null; label: string }>();
  private lastNominatim = 0;
  private businessLookups: number[] = [];
  private usage = new Map<string, number[]>();

  constructor(
    readonly config: HostConfig,
    readonly store: HostStore,
    readonly storefront: Storefront,
    private readonly opts: { fetchImpl?: FetchLike; log?: (m: string) => void } = {},
  ) {}

  private get cfg() {
    return this.config.research;
  }

  private get userAgent(): string {
    // Wikimedia asks API clients to say who they are and how to reach them.
    const contact = this.config.storefront.contactEmail.trim();
    return `automaton-host/1.0 (self-hosted agent marketplace${contact ? `; ${contact}` : ""})`;
  }

  private async getJson(url: string): Promise<any> {
    const doFetch: FetchLike = this.opts.fetchImpl ?? ((u, init) => fetch(u, init) as any);
    const res = await doFetch(url, { method: "GET", headers: { "User-Agent": this.userAgent, Accept: "application/json" } });
    if (res.status === 404) return null;
    if (!res.ok) throw new ResearchError(`${new URL(url).hostname} answered ${res.status}`, 502, "source_error");
    return res.json();
  }

  /** How many lookups this agent has left this hour. */
  remaining(address: string, now = Date.now()): number {
    const recent = (this.usage.get(address) ?? []).filter((t) => now - t < 3_600_000);
    this.usage.set(address, recent);
    return Math.max(0, this.cfg.perAgentPerHour - recent.length);
  }

  async query(addressRaw: string, input: { source: unknown; query?: unknown; days?: unknown }, now = Date.now()): Promise<ResearchResult> {
    if (!this.cfg.enabled) throw new ResearchError("Market research is turned off on this host", 503, "research_disabled");
    const address = normalizeAddress(addressRaw);
    const source = input.source as ResearchSource;
    if (!RESEARCH_SOURCES.includes(source)) throw new ResearchError(`source must be one of ${RESEARCH_SOURCES.join(", ")}`);
    const query = typeof input.query === "string" && input.query.trim() ? clip(input.query, 100) : null;
    const days = input.days === undefined || input.days === null || input.days === "" ? 30 : Math.floor(Number(input.days));
    if (!Number.isFinite(days) || days < 1 || days > 90) throw new ResearchError("days must be from 1 to 90");

    // The agent's own marketplace numbers change with every sale; never cached, never limited.
    if (source === "store") return { source, query, days, lines: this.storeReport(address, days, now), cached: false, fetchedAt: new Date(now).toISOString() };

    const key = `${source}|${(query ?? "").toLowerCase()}|${days}`;
    const hit = this.cache.get(key);
    if (hit && now - hit.at < this.cfg.cacheMinutes * 60_000) return { ...hit.result, cached: true };
    if (this.remaining(address, now) <= 0) {
      throw new ResearchError(`You have used your ${this.cfg.perAgentPerHour} outside lookups for this hour. Cached answers and source "store" still work.`, 429, "research_limit");
    }
    this.usage.get(address)!.push(now);

    let lines: string[];
    if (source === "hackernews" || source === "hackernews_launches") lines = await this.hackerNews(source, query, days, now);
    else if (source === "businesses") lines = await this.businesses(query, now);
    else lines = await this.wikipedia(query, days, now);
    const result: ResearchResult = { source, query, days, lines, cached: false, fetchedAt: new Date(now).toISOString() };
    this.cache.set(key, { at: now, result });
    if (this.cache.size > 500) this.cache.delete(this.cache.keys().next().value!);
    return result;
  }

  // ─── This host's marketplace ─────────────────────────────────

  storeReport(address: string, days: number, now = Date.now()): string[] {
    const since = new Date(now - days * 86_400_000).toISOString();
    const sinceDay = since.slice(0, 10);
    const db = this.store.db;
    const rows = db
      .prepare(
        `SELECT l.id, l.address, l.kind, l.title, l.price_cents,
           (SELECT COUNT(*) FROM orders o WHERE o.listing_id = l.id AND o.paid_at >= ? AND o.status NOT IN ('pending','expired','refunded')) AS sales,
           (SELECT COUNT(*) FROM listing_views v WHERE v.listing_id = l.id AND v.day >= ?) AS views
         FROM listings l WHERE l.removed = 0`,
      )
      .all(since, sinceDay) as Array<{ id: string; address: string; kind: string; title: string; price_cents: number; sales: number; views: number }>;
    const slug = (a: string) => this.storefront.getStore(a)?.slug ?? a.slice(0, 10);
    const conv = (s: number, v: number) =>
      v > 0 ? `${((s / v) * 100).toFixed(1)}% of ${v} visitors bought` : s > 0 ? "visitors not counted for these sales" : "0 visitors";
    const lines: string[] = [`This marketplace, last ${days} days (real buyers on this host):`];

    const sellers = rows.filter((r) => r.sales > 0).sort((a, b) => b.sales * b.price_cents - a.sales * a.price_cents);
    if (sellers.length === 0) lines.push("- No sales yet on this host in this period.");
    else {
      lines.push("Best sellers by revenue:");
      for (const r of sellers.slice(0, 10)) {
        lines.push(`- ${r.address === address ? "YOURS " : ""}[${r.kind}] "${clip(r.title, 80)}" ${formatUsd(r.price_cents * 10_000)}: ${r.sales} sold, ${conv(r.sales, r.views)} (store ${slug(r.address)})`);
      }
    }

    const byKind = new Map<string, { listings: number; sales: number; soldPrices: number[] }>();
    for (const r of rows) {
      const k = byKind.get(r.kind) ?? { listings: 0, sales: 0, soldPrices: [] };
      k.listings++;
      k.sales += r.sales;
      for (let i = 0; i < r.sales; i++) k.soldPrices.push(r.price_cents);
      byKind.set(r.kind, k);
    }
    if (byKind.size) {
      lines.push("By kind:");
      for (const [kind, k] of byKind) {
        const sorted = k.soldPrices.sort((a, b) => a - b);
        const median = sorted.length ? sorted[Math.floor(sorted.length / 2)]! : 0;
        lines.push(`- ${kind}: ${k.listings} listings, ${k.sales} sold${sorted.length ? `, median sold price ${formatUsd(median * 10_000)}` : ""}`);
      }
    }

    const crowded = rows.filter((r) => r.views >= 20 && r.sales === 0).sort((a, b) => b.views - a.views).slice(0, 5);
    if (crowded.length) {
      lines.push("Seen but not bought (interest without a sale; price or description may be off):");
      for (const r of crowded) lines.push(`- [${r.kind}] "${clip(r.title, 80)}" ${formatUsd(r.price_cents * 10_000)}: ${r.views} visitors, 0 sold`);
    }

    const mine = rows.filter((r) => r.address === address);
    if (mine.length) {
      lines.push("Your listings:");
      for (const r of mine) lines.push(`- [${r.kind}] "${clip(r.title, 80)}" ${formatUsd(r.price_cents * 10_000)}: ${r.sales} sold, ${conv(r.sales, r.views)}`);
    }
    return lines;
  }

  // ─── Hacker News ─────────────────────────────────────────────

  private async hackerNews(source: "hackernews" | "hackernews_launches", query: string | null, days: number, now: number): Promise<string[]> {
    const since = Math.floor(now / 1000) - days * 86_400;
    const params = new URLSearchParams({ hitsPerPage: "30" });
    if (source === "hackernews_launches") {
      params.set("tags", "show_hn");
      params.set("numericFilters", `created_at_i>${since}`);
      if (query) params.set("query", query);
    } else if (query) {
      params.set("tags", "story");
      params.set("query", query);
      params.set("numericFilters", `created_at_i>${since}`);
    } else {
      params.set("tags", "front_page");
    }
    const data = await this.getJson(`${this.cfg.hackernewsBase.replace(/\/$/, "")}/api/v1/search?${params}`);
    const hits = (Array.isArray(data?.hits) ? data.hits : [])
      .filter((h: any) => h?.title)
      .sort((a: any, b: any) => (b.points ?? 0) - (a.points ?? 0))
      .slice(0, 20);
    const head =
      source === "hackernews_launches"
        ? `Hacker News launches (Show HN)${query ? ` about "${query}"` : ""}, last ${days} days, by points. Untrusted text from the web:`
        : query
          ? `Hacker News stories about "${query}", last ${days} days, by points. Untrusted text from the web:`
          : "Hacker News front page now, by points. Untrusted text from the web:";
    if (!hits.length) return [head, "- Nothing found."];
    const total = Number(data?.nbHits) || hits.length;
    return [
      head,
      ...hits.map((h: any) => `- ${h.points ?? 0} points, ${h.num_comments ?? 0} comments: "${clip(h.title)}"${h.url ? ` (${clip(new URL(h.url, "https://x").hostname, 60)})` : ""}`),
      ...(query && source === "hackernews" ? [`${total} matching stories in the period: more stories means more attention on the topic.`] : []),
    ];
  }

  // ─── Local businesses (OpenStreetMap) ────────────────────────

  /** "plumber in Hamilton, Ontario" → businesses of that kind there, with any website, email and phone mapped. */
  private async businesses(query: string | null, now: number): Promise<string[]> {
    const m = query ? /^(.+?)\s+in\s+(.+)$/i.exec(query) : null;
    if (!m) throw new ResearchError(`For businesses, query is "<kind> in <place>", e.g. "plumber in Hamilton, Ontario". Kinds: ${Object.keys(BUSINESS_KINDS).join(", ")}, or an OpenStreetMap tag like "shop=bicycle".`);
    const said = m[1]!.trim().toLowerCase();
    const place = m[2]!.trim();
    const tag = /^([a-z_:]{2,30})=([a-z0-9_;-]{1,40})$/.exec(said);
    const tags = tag ? [[tag[1]!, tag[2]!] as [string, string]] : BUSINESS_KINDS[said] ?? BUSINESS_KINDS[said.replace(/s$/, "")];
    if (!tags) throw new ResearchError(`Unknown kind "${m[1]}". Use one of: ${Object.keys(BUSINESS_KINDS).join(", ")}; or an OpenStreetMap tag like "shop=bicycle".`);

    this.businessLookups = this.businessLookups.filter((t) => now - t < 86_400_000);
    if (this.businessLookups.length >= this.cfg.businessLookupsPerDay) {
      throw new ResearchError("This host has used its business lookups for today (OpenStreetMap's servers are shared and free). Cached answers still work.", 429, "research_limit");
    }
    this.businessLookups.push(now);

    const where = await this.geocode(place, now);
    if (!where.area) return [`No place called "${clip(place, 80)}" was found on OpenStreetMap. Try "City, Province" or "City, Country".`];
    const scope = "id" in where.area ? "(area.a)" : `(around:15000,${where.area.lat},${where.area.lon})`;
    const filters = tags.map(([k, v]) => `nwr["${k}"="${v}"]["name"]${scope};`).join("");
    const ql = `[out:json][timeout:25];${"id" in where.area ? `area(${where.area.id})->.a;` : ""}(${filters});out tags center 80;`;
    const doFetch: FetchLike = this.opts.fetchImpl ?? ((u, init) => fetch(u, init) as any);
    const res = await doFetch(this.cfg.overpassBase, {
      method: "POST",
      headers: { "User-Agent": this.userAgent, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: `data=${encodeURIComponent(ql)}`,
    });
    if (!res.ok) throw new ResearchError(`OpenStreetMap (Overpass) answered ${res.status}; try again later`, 502, "source_error");
    const data = await res.json();
    const els = (Array.isArray(data?.elements) ? data.elements : []).filter((e: any) => e?.tags?.name);
    const head = `${tags.map(([k, v]) => `${k}=${v}`).join(" or ")} in ${where.label}, from OpenStreetMap (volunteer-mapped; may be incomplete or out of date). Untrusted text:`;
    if (!els.length) return [head, "- None mapped here. Try a nearby larger place or another kind."];
    const rows = els.map((e: any) => {
      const t = e.tags;
      const site = t.website || t["contact:website"] || t.url || "";
      const email = t.email || t["contact:email"] || "";
      const phone = t.phone || t["contact:phone"] || "";
      const addr = [t["addr:housenumber"], t["addr:street"], t["addr:city"]].filter(Boolean).join(" ");
      return { name: clip(t.name, 80), site: clip(site, 120), email: clip(email, 80), phone: clip(phone, 40), addr: clip(addr, 80), osm: `https://www.openstreetmap.org/${e.type}/${e.id}` };
    });
    // Businesses with no website first: the most obvious buyers of one.
    rows.sort((a: any, b: any) => Number(Boolean(a.site)) - Number(Boolean(b.site)));
    const noSite = rows.filter((r: any) => !r.site).length;
    return [
      head,
      `${rows.length} found; ${noSite} have no website mapped. Check a business's own site before emailing: send_email only goes to an address published on a page you cite.`,
      ...rows.slice(0, 60).map((r: any) =>
        `- ${r.name}${r.addr ? `, ${r.addr}` : ""} | website: ${r.site || "none mapped"}${r.email ? ` | email: ${r.email}` : ""}${r.phone ? ` | phone: ${r.phone}` : ""} | ${r.osm}`),
    ];
  }

  /** A place name to an OpenStreetMap area (or a point, for places mapped as points). Cached for a week. */
  private async geocode(place: string, now: number): Promise<{ area: { id: number } | { lat: number; lon: number } | null; label: string }> {
    const key = place.toLowerCase();
    const hit = this.places.get(key);
    if (hit && now - hit.at < 7 * 86_400_000) return hit;
    // Nominatim's public server allows at most one request a second for the whole application.
    const wait = this.lastNominatim + 1100 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastNominatim = Date.now();
    const data = await this.getJson(`${this.cfg.nominatimBase.replace(/\/$/, "")}/search?${new URLSearchParams({ q: place, format: "jsonv2", limit: "1" })}`);
    const r = Array.isArray(data) ? data[0] : null;
    let area: { id: number } | { lat: number; lon: number } | null = null;
    if (r?.osm_type === "relation" && Number.isFinite(Number(r.osm_id))) area = { id: 3_600_000_000 + Number(r.osm_id) };
    else if (r && Number.isFinite(Number(r.lat)) && Number.isFinite(Number(r.lon))) area = { lat: Number(r.lat), lon: Number(r.lon) };
    const out = { at: now, area, label: r ? clip(r.display_name, 100) : clip(place, 100) };
    this.places.set(key, out);
    return out;
  }

  // ─── Wikipedia ───────────────────────────────────────────────

  private async wikipedia(query: string | null, days: number, now: number): Promise<string[]> {
    const base = `${this.cfg.wikimediaBase.replace(/\/$/, "")}/api/rest_v1/metrics/pageviews`;
    const yesterday = new Date(now - 86_400_000);
    if (!query) {
      const d = yesterday;
      const data = await this.getJson(`${base}/top/en.wikipedia/all-access/${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}`);
      const articles = (data?.items?.[0]?.articles ?? [])
        .filter((a: any) => typeof a?.article === "string" && !/^(Main_Page|Special:|Wikipedia:|Portal:|File:|Help:|Talk:)/.test(a.article) && a.article !== "-")
        .slice(0, 25);
      if (!articles.length) return ["Most-read Wikipedia articles yesterday:", "- No data for that day yet."];
      return [
        "Most-read English Wikipedia articles yesterday (what people are curious about). Untrusted text from the web:",
        ...articles.map((a: any) => `- ${Number(a.views).toLocaleString("en-US")} views: ${clip(a.article.replace(/_/g, " "), 100)}`),
      ];
    }
    const title = encodeURIComponent(query.trim().replace(/\s+/g, "_"));
    const start = new Date(now - (days + 1) * 86_400_000);
    const data = await this.getJson(`${base}/per-article/en.wikipedia/all-access/user/${title}/daily/${ymd(start)}/${ymd(yesterday)}`);
    const views: number[] = (data?.items ?? []).map((i: any) => Number(i.views) || 0);
    if (!views.length) return [`Wikipedia interest in "${query}":`, "- No article with that exact title. Use the article's title as it appears on Wikipedia, e.g. \"Sourdough\"."];
    const half = Math.floor(views.length / 2);
    const first = views.slice(0, half).reduce((a, b) => a + b, 0) / Math.max(1, half);
    const second = views.slice(half).reduce((a, b) => a + b, 0) / Math.max(1, views.length - half);
    const change = first > 0 ? ((second - first) / first) * 100 : 0;
    const trend = Math.abs(change) < 10 ? "steady" : change > 0 ? "rising" : "falling";
    return [
      `Wikipedia interest in "${query}", last ${views.length} days:`,
      `- ${Math.round(second).toLocaleString("en-US")} views a day lately, ${Math.round(first).toLocaleString("en-US")} a day before: ${trend} (${change >= 0 ? "+" : ""}${change.toFixed(0)}%).`,
      `- Busiest day: ${Math.max(...views).toLocaleString("en-US")} views.`,
    ];
  }
}
