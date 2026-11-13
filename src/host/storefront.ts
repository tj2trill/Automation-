/**
 * Host Control Plane — Public storefront
 *
 * Agents sell digital files to the public. Each agent gets a store page on
 * the creator's domain; customers pay through Stripe Checkout and get a
 * private, expiring download link.
 *
 * What goes public is a SEPARATE server on its own loopback port, meant to be
 * published with Cloudflare Tunnel. It serves only store pages, the buy
 * redirect, order pages and downloads. The agent API and the dashboard are
 * never reachable through it.
 *
 * Agents write listing text, but never markup: pages are rendered by fixed
 * templates with every agent string escaped, no script runs on any page, and
 * files are only ever served as attachments with a generic content type, so
 * an agent cannot host a page that runs code or impersonates a login on the
 * creator's domain. Every page says it is an AI agent's store and who
 * operates it.
 *
 * Listings publish immediately. The creator can pull a listing or suspend a
 * whole store; an agent cannot undo either. Product files are kept by the
 * host, outside every container, so a buyer still gets what they paid for
 * if the agent dies afterwards.
 */

import { createHash, randomBytes, timingSafeEqual } from "crypto";
import fs from "fs";
import http from "http";
import path from "path";
import { monotonicFactory } from "ulid";
import type { HostConfig } from "./config.js";
import { AccountDeadError, HostStore, normalizeAddress } from "./store.js";
import type { Economy } from "./economy.js";

const ulid = monotonicFactory();

export class StoreError extends Error {
  constructor(message: string, public readonly status = 400, public readonly code = "invalid_request") {
    super(message);
    this.name = "StoreError";
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS stores (
  address     TEXT PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,
  tagline     TEXT NOT NULL DEFAULT '',
  suspended   INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS listings (
  id             TEXT PRIMARY KEY,
  address        TEXT NOT NULL,
  title          TEXT NOT NULL,
  description    TEXT NOT NULL,
  price_cents    INTEGER NOT NULL,
  filename       TEXT NOT NULL,
  file_sha256    TEXT NOT NULL,
  file_bytes     INTEGER NOT NULL,
  live           INTEGER NOT NULL DEFAULT 1,
  pulled         INTEGER NOT NULL DEFAULT 0,
  removed        INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS listings_address ON listings(address);
CREATE TABLE IF NOT EXISTS orders (
  id               TEXT PRIMARY KEY,
  order_key_hash   TEXT NOT NULL,
  listing_id       TEXT NOT NULL,
  address          TEXT NOT NULL,
  title            TEXT NOT NULL,
  filename         TEXT NOT NULL,
  file_sha256      TEXT NOT NULL,
  amount_cents     INTEGER NOT NULL,
  session_id       TEXT,
  status           TEXT NOT NULL,
  net_micro        INTEGER,
  download_hash    TEXT,
  download_expires TEXT,
  downloads        INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL,
  paid_at          TEXT,
  checked_at       TEXT
);
CREATE INDEX IF NOT EXISTS orders_status ON orders(status, checked_at);
`;

export type OrderStatus = "pending" | "paid" | "paid_after_death" | "expired" | "refunded";

export interface Listing {
  id: string;
  address: string;
  title: string;
  description: string;
  priceCents: number;
  filename: string;
  fileSha256: string;
  fileBytes: number;
  /** The agent's own on/off switch. */
  live: boolean;
  /** Taken down by the creator. Only the creator can restore it. */
  pulled: boolean;
  /** The agent died; gone for good. */
  removed: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Order {
  id: string;
  listingId: string;
  address: string;
  title: string;
  filename: string;
  amountCents: number;
  status: OrderStatus;
  netMicro: number | null;
  downloads: number;
  downloadExpires: string | null;
  createdAt: string;
  paidAt: string | null;
}

export interface StoreInfo {
  address: string;
  slug: string;
  tagline: string;
  suspended: boolean;
}

function mapListing(r: any): Listing {
  return {
    id: r.id,
    address: r.address,
    title: r.title,
    description: r.description,
    priceCents: r.price_cents,
    filename: r.filename,
    fileSha256: r.file_sha256,
    fileBytes: r.file_bytes,
    live: r.live === 1,
    pulled: r.pulled === 1,
    removed: r.removed === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function mapOrder(r: any): Order {
  return {
    id: r.id,
    listingId: r.listing_id,
    address: r.address,
    title: r.title,
    filename: r.filename,
    amountCents: r.amount_cents,
    status: r.status,
    netMicro: r.net_micro,
    downloads: r.downloads,
    downloadExpires: r.download_expires,
    createdAt: r.created_at,
    paidAt: r.paid_at,
  };
}

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

function sameSecret(given: string, storedHash: string): boolean {
  const a = Buffer.from(sha256(given), "hex");
  const b = Buffer.from(storedHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** One line of plain text: no control characters, collapsed spaces. */
function cleanLine(v: unknown, max: number, what: string): string {
  const s = typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim() : "";
  if (!s || s.length > max) throw new StoreError(`${what} must be 1 to ${max} characters`);
  return s;
}

/** Plain text that keeps line breaks. */
function cleanText(v: unknown, max: number, what: string): string {
  const s = typeof v === "string" ? v.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, " ").replace(/\n{3,}/g, "\n\n").trim() : "";
  if (!s || s.length > max) throw new StoreError(`${what} must be 1 to ${max} characters`);
  return s;
}

export function cleanFilename(v: unknown): string {
  const raw = typeof v === "string" ? path.basename(v.trim()) : "";
  const s = raw.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "").slice(0, 100);
  if (!s) throw new StoreError("filename must contain letters or digits");
  return s;
}

export function slugify(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "store";
}

export interface StorefrontOptions {
  /** Where product files are kept. Default: <host dir>/store-files. */
  filesDir: string;
  log?: (msg: string) => void;
}

export class Storefront {
  constructor(
    readonly config: HostConfig,
    readonly store: HostStore,
    readonly economy: Economy,
    private readonly opts: StorefrontOptions,
  ) {
    this.store.db.exec(SCHEMA);
    fs.mkdirSync(opts.filesDir, { recursive: true, mode: 0o700 });
  }

  private get sf() {
    return this.config.storefront;
  }

  /** Buying needs a public address, a named operator, a contact, and Stripe. */
  get missingForSales(): string[] {
    const missing: string[] = [];
    if (!this.sf.publicUrl) missing.push("storefront.publicUrl");
    if (!this.sf.operatorName.trim()) missing.push("storefront.operatorName");
    if (!this.sf.contactEmail.trim()) missing.push("storefront.contactEmail");
    if (!this.economy.stripeEnabled) missing.push("STRIPE_SECRET_KEY");
    return missing;
  }

  storeUrl(slug: string): string | null {
    return this.sf.publicUrl ? `${this.sf.publicUrl.replace(/\/$/, "")}/s/${slug}` : null;
  }

  // ─── Stores ──────────────────────────────────────────────────

  getStore(addressRaw: string): StoreInfo | null {
    const r = this.store.db.prepare("SELECT * FROM stores WHERE address = ?").get(normalizeAddress(addressRaw)) as any;
    return r ? { address: r.address, slug: r.slug, tagline: r.tagline, suspended: r.suspended === 1 } : null;
  }

  getStoreBySlug(slug: string): StoreInfo | null {
    const r = this.store.db.prepare("SELECT * FROM stores WHERE slug = ?").get(slug) as any;
    return r ? { address: r.address, slug: r.slug, tagline: r.tagline, suspended: r.suspended === 1 } : null;
  }

  /** Every agent store, opened on its first listing, named after the agent. */
  ensureStore(addressRaw: string): StoreInfo {
    const address = normalizeAddress(addressRaw);
    const existing = this.getStore(address);
    if (existing) return existing;
    const label = this.store.listAccounts().find((a) => a.address === address)?.label || address.slice(2, 10);
    const base = slugify(label);
    let slug = base;
    for (let i = 2; this.getStoreBySlug(slug); i++) slug = `${base}-${i}`;
    this.store.db.prepare("INSERT INTO stores (address, slug, created_at) VALUES (?, ?, ?)").run(address, slug, new Date().toISOString());
    return this.getStore(address)!;
  }

  setTagline(addressRaw: string, tagline: unknown): StoreInfo {
    const address = normalizeAddress(addressRaw);
    const t = typeof tagline === "string" && tagline.trim() === "" ? "" : cleanLine(tagline, 160, "tagline");
    this.ensureStore(address);
    this.store.db.prepare("UPDATE stores SET tagline = ? WHERE address = ?").run(t, address);
    return this.getStore(address)!;
  }

  /** Creator only. */
  setSuspended(addressRaw: string, suspended: boolean): StoreInfo {
    const address = normalizeAddress(addressRaw);
    const s = this.getStore(address);
    if (!s) throw new StoreError("That agent has no store", 404, "not_found");
    this.store.db.prepare("UPDATE stores SET suspended = ? WHERE address = ?").run(suspended ? 1 : 0, address);
    return this.getStore(address)!;
  }

  listStores(): StoreInfo[] {
    return (this.store.db.prepare("SELECT * FROM stores ORDER BY created_at").all() as any[]).map((r) => ({
      address: r.address, slug: r.slug, tagline: r.tagline, suspended: r.suspended === 1,
    }));
  }

  // ─── Listings ────────────────────────────────────────────────

  private filePath(hash: string): string {
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new StoreError("bad file reference", 500, "internal");
    return path.join(this.opts.filesDir, hash);
  }

  private assertCanSell(address: string): void {
    if (this.store.isDead(address)) throw new StoreError("This account is dead", 403, "account_dead");
    if (this.store.isFrozen(address)) throw new StoreError("Account is frozen by the creator", 403, "account_frozen");
  }

  private priceCents(v: unknown): number {
    const p = Number(v);
    const { minAmountCents, maxAmountCents } = this.config.stripe;
    if (!Number.isInteger(p) || p < minAmountCents || p > maxAmountCents) {
      throw new StoreError(`price_cents must be a whole number from ${minAmountCents} to ${maxAmountCents}`);
    }
    if (this.economy.netOfFees(p) <= 0) throw new StoreError("That price would be consumed entirely by the processing fee");
    return p;
  }

  createListing(addressRaw: string, input: { title: unknown; description: unknown; priceCents: unknown; filename: unknown; contentBase64: unknown }): Listing {
    const address = normalizeAddress(addressRaw);
    this.assertCanSell(address);
    const title = cleanLine(input.title, 80, "title");
    const description = cleanText(input.description, 4000, "description");
    const priceCents = this.priceCents(input.priceCents);
    const filename = cleanFilename(input.filename);
    if (typeof input.contentBase64 !== "string" || !input.contentBase64) throw new StoreError("content_base64 (the file) is required");
    if (!/^[A-Za-z0-9+/=\s]+$/.test(input.contentBase64)) throw new StoreError("content_base64 is not base64");
    const bytes = Buffer.from(input.contentBase64, "base64");
    if (bytes.length === 0) throw new StoreError("The file is empty");
    const maxFile = this.sf.maxFileMb * 1024 * 1024;
    if (bytes.length > maxFile) throw new StoreError(`Files may be at most ${this.sf.maxFileMb} MB`, 413, "too_large");

    const mine = (this.store.db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(file_bytes),0) AS b FROM listings WHERE address = ? AND removed = 0").get(address)) as { n: number; b: number };
    if (mine.n >= this.sf.maxListingsPerAgent) throw new StoreError(`At most ${this.sf.maxListingsPerAgent} listings per store`, 429, "too_many_listings");
    if (mine.b + bytes.length > this.sf.maxStoreMb * 1024 * 1024) throw new StoreError(`A store may hold at most ${this.sf.maxStoreMb} MB of files`, 413, "store_full");

    const hash = sha256(bytes);
    const target = this.filePath(hash);
    if (!fs.existsSync(target)) {
      const tmp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
      fs.writeFileSync(tmp, bytes, { mode: 0o600 });
      fs.renameSync(tmp, target);
    }
    this.ensureStore(address);
    const id = ulid();
    const now = new Date().toISOString();
    this.store.db
      .prepare(
        "INSERT INTO listings (id, address, title, description, price_cents, filename, file_sha256, file_bytes, live, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)",
      )
      .run(id, address, title, description, priceCents, filename, hash, bytes.length, now, now);
    return this.getListing(id)!;
  }

  getListing(id: string): Listing | null {
    const r = this.store.db.prepare("SELECT * FROM listings WHERE id = ?").get(id);
    return r ? mapListing(r) : null;
  }

  listListings(filter: { address?: string; includeRemoved?: boolean } = {}): Listing[] {
    const rows = filter.address
      ? this.store.db.prepare("SELECT * FROM listings WHERE address = ? ORDER BY id DESC").all(normalizeAddress(filter.address))
      : this.store.db.prepare("SELECT * FROM listings ORDER BY id DESC").all();
    return (rows as any[]).map(mapListing).filter((l) => filter.includeRemoved || !l.removed);
  }

  /** What a customer may see and buy right now. */
  isOnSale(l: Listing): boolean {
    if (!l.live || l.pulled || l.removed) return false;
    const s = this.getStore(l.address);
    if (!s || s.suspended) return false;
    return !this.store.isDead(l.address) && !this.store.isFrozen(l.address);
  }

  updateListing(addressRaw: string, id: string, patch: { title?: unknown; description?: unknown; priceCents?: unknown; live?: unknown }): Listing {
    const address = normalizeAddress(addressRaw);
    this.assertCanSell(address);
    const l = this.getListing(id);
    if (!l || l.address !== address || l.removed) throw new StoreError(`No listing ${id}`, 404, "not_found");
    const next = {
      title: patch.title === undefined ? l.title : cleanLine(patch.title, 80, "title"),
      description: patch.description === undefined ? l.description : cleanText(patch.description, 4000, "description"),
      priceCents: patch.priceCents === undefined ? l.priceCents : this.priceCents(patch.priceCents),
      live: patch.live === undefined ? l.live : patch.live === true,
    };
    if (patch.live !== undefined && typeof patch.live !== "boolean") throw new StoreError("live must be true or false");
    this.store.db
      .prepare("UPDATE listings SET title = ?, description = ?, price_cents = ?, live = ?, updated_at = ? WHERE id = ?")
      .run(next.title, next.description, next.priceCents, next.live ? 1 : 0, new Date().toISOString(), id);
    return this.getListing(id)!;
  }

  /** Creator only. */
  setPulled(id: string, pulled: boolean): Listing {
    const l = this.getListing(id);
    if (!l || l.removed) throw new StoreError(`No listing ${id}`, 404, "not_found");
    this.store.db.prepare("UPDATE listings SET pulled = ?, updated_at = ? WHERE id = ?").run(pulled ? 1 : 0, new Date().toISOString(), id);
    return this.getListing(id)!;
  }

  /** When an agent dies its listings come down for good. Paid orders still deliver. */
  removeStoreOf(addressRaw: string): void {
    this.store.db.prepare("UPDATE listings SET removed = 1, live = 0 WHERE address = ?").run(normalizeAddress(addressRaw));
  }

  salesOf(listingId: string): { count: number; netMicro: number } {
    const r = this.store.db
      .prepare("SELECT COUNT(*) AS n, COALESCE(SUM(net_micro),0) AS net FROM orders WHERE listing_id = ? AND status IN ('paid','paid_after_death')")
      .get(listingId) as { n: number; net: number };
    return { count: r.n, netMicro: r.net };
  }

  // ─── Orders ──────────────────────────────────────────────────

  getOrder(id: string): Order | null {
    const r = this.store.db.prepare("SELECT * FROM orders WHERE id = ?").get(id);
    return r ? mapOrder(r) : null;
  }

  listOrders(filter: { address?: string; limit?: number; paidOnly?: boolean } = {}): Order[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (filter.address) {
      where.push("address = ?");
      args.push(normalizeAddress(filter.address));
    }
    if (filter.paidOnly) where.push("status IN ('paid','paid_after_death','refunded')");
    const sql = `SELECT * FROM orders ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ?`;
    return (this.store.db.prepare(sql).all(...args, filter.limit ?? 100) as any[]).map(mapOrder);
  }

  /**
   * Start a purchase: an order row and a Stripe Checkout session. Returns the
   * Stripe page to send the customer to and the order page they come back to.
   */
  async startCheckout(listingId: string): Promise<{ checkoutUrl: string; orderId: string; orderKey: string }> {
    const missing = this.missingForSales;
    if (missing.length) throw new StoreError("This store is not open for purchases yet.", 503, "store_closed");
    const l = this.getListing(listingId);
    if (!l || !this.isOnSale(l)) throw new StoreError("This item is not for sale.", 404, "not_found");
    const pending = this.store.db.prepare("SELECT COUNT(*) AS n FROM orders WHERE status = 'pending'").get() as { n: number };
    if (pending.n >= 1000) throw new StoreError("Too many checkouts are open. Try again later.", 503, "busy");

    const id = ulid();
    const orderKey = randomBytes(24).toString("base64url");
    const now = new Date().toISOString();
    this.store.db
      .prepare(
        "INSERT INTO orders (id, order_key_hash, listing_id, address, title, filename, file_sha256, amount_cents, status, created_at, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)",
      )
      .run(id, sha256(orderKey), l.id, l.address, l.title, l.filename, l.fileSha256, l.priceCents, now, now);
    const base = this.sf.publicUrl.replace(/\/$/, "");
    let session: any;
    try {
      session = await this.economy.stripeRequest("POST", "/v1/checkout/sessions", {
        mode: "payment",
        success_url: `${base}/order/${id}?k=${orderKey}`,
        cancel_url: `${base}/p/${l.id}`,
        client_reference_id: id,
        "line_items[0][quantity]": 1,
        "line_items[0][price_data][currency]": this.config.stripe.currency,
        "line_items[0][price_data][unit_amount]": l.priceCents,
        "line_items[0][price_data][product_data][name]": l.title,
        "metadata[automaton_address]": l.address,
        "metadata[automaton_order]": id,
        "metadata[automaton_listing]": l.id,
      });
    } catch (err) {
      this.store.db.prepare("UPDATE orders SET status = 'expired' WHERE id = ?").run(id);
      throw err;
    }
    if (typeof session?.id !== "string" || typeof session?.url !== "string" || !/^https:\/\//.test(session.url)) {
      this.store.db.prepare("UPDATE orders SET status = 'expired' WHERE id = ?").run(id);
      throw new StoreError("Payment could not be started.", 502, "stripe_error");
    }
    this.store.db.prepare("UPDATE orders SET session_id = ? WHERE id = ?").run(session.id, id);
    return { checkoutUrl: session.url, orderId: id, orderKey };
  }

  /**
   * Record a paid order once: credit the agent net of fees and issue a
   * download link. Returns the download token only to the caller that
   * settled it (the buyer's own order page); later visits mint a new one.
   */
  private settle(order: Order, session: any): void {
    const total = Number.isFinite(session?.amount_total) ? Math.floor(session.amount_total) : order.amountCents;
    const net = this.economy.netOfFees(total);
    const now = new Date();
    this.store.db.transaction(() => {
      const claimed = this.store.db
        .prepare("UPDATE orders SET status = 'paid', net_micro = ?, paid_at = ? WHERE id = ? AND status = 'pending'")
        .run(net, now.toISOString(), order.id).changes;
      if (claimed !== 1) return;
      try {
        if (net > 0) this.store.credit(order.address, net, "sale", order.id, `store: ${order.title}`);
      } catch (err) {
        if (!(err instanceof AccountDeadError)) throw err;
        this.store.db.prepare("UPDATE orders SET status = 'paid_after_death' WHERE id = ?").run(order.id);
      }
    })();
  }

  private issueDownload(orderId: string): string {
    const token = randomBytes(24).toString("base64url");
    const expires = new Date(Date.now() + this.sf.downloadHours * 3_600_000).toISOString();
    this.store.db.prepare("UPDATE orders SET download_hash = ?, download_expires = ? WHERE id = ?").run(sha256(token), expires, orderId);
    return token;
  }

  /** Ask Stripe about one pending order. */
  private async refreshOrder(order: Order): Promise<Order> {
    if (order.status !== "pending") return order;
    const row = this.store.db.prepare("SELECT session_id FROM orders WHERE id = ?").get(order.id) as { session_id: string | null };
    this.store.db.prepare("UPDATE orders SET checked_at = ? WHERE id = ?").run(new Date().toISOString(), order.id);
    if (!row?.session_id) return order;
    const session = await this.economy.stripeRequest("GET", `/v1/checkout/sessions/${encodeURIComponent(row.session_id)}`);
    if (session?.payment_status === "paid") this.settle(order, session);
    else if (session?.status === "expired") this.store.db.prepare("UPDATE orders SET status = 'expired' WHERE id = ? AND status = 'pending'").run(order.id);
    return this.getOrder(order.id)!;
  }

  /** The buyer's return page: proves they hold the order key, then hands out a download link. */
  async orderForBuyer(orderId: string, key: string): Promise<{ order: Order; downloadToken: string | null }> {
    const row = this.store.db.prepare("SELECT order_key_hash FROM orders WHERE id = ?").get(orderId) as { order_key_hash: string } | undefined;
    if (!row || typeof key !== "string" || !key || !sameSecret(key, row.order_key_hash)) {
      throw new StoreError("Order not found.", 404, "not_found");
    }
    let order = this.getOrder(orderId)!;
    if (order.status === "pending") order = await this.refreshOrder(order);
    const paid = order.status === "paid" || order.status === "paid_after_death";
    const usable = paid && order.downloads < this.sf.maxDownloads;
    // Each visit to the order page gives a fresh link; the old one stops working.
    return { order, downloadToken: usable ? this.issueDownload(order.id) : null };
  }

  /** Stream the file for a valid download token, counting the download. */
  takeDownload(token: string): { filename: string; path: string; bytes: number } {
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{20,64}$/.test(token)) throw new StoreError("Link not found.", 404, "not_found");
    const hash = sha256(token);
    const r = this.store.db.prepare("SELECT * FROM orders WHERE download_hash = ?").get(hash) as any;
    if (!r || !(r.status === "paid" || r.status === "paid_after_death")) throw new StoreError("Link not found.", 404, "not_found");
    if (!r.download_expires || new Date(r.download_expires).getTime() < Date.now()) throw new StoreError("This download link has expired. Open your order page again for a new one.", 410, "expired");
    const counted = this.store.db
      .prepare("UPDATE orders SET downloads = downloads + 1 WHERE id = ? AND downloads < ?")
      .run(r.id, this.sf.maxDownloads).changes;
    if (counted !== 1) throw new StoreError(`This order has been downloaded ${this.sf.maxDownloads} times, the limit. Contact the seller.`, 410, "used_up");
    const p = this.filePath(r.file_sha256);
    if (!fs.existsSync(p)) throw new StoreError("The file is missing. Contact the seller.", 500, "missing");
    return { filename: r.filename, path: p, bytes: fs.statSync(p).size };
  }

  /** Creator only: refund through Stripe and take the money back from the agent. */
  async refund(orderId: string): Promise<Order> {
    const order = this.getOrder(orderId);
    if (!order) throw new StoreError(`No order ${orderId}`, 404, "not_found");
    if (order.status !== "paid" && order.status !== "paid_after_death") throw new StoreError(`Order is ${order.status}`, 409, "conflict");
    const row = this.store.db.prepare("SELECT session_id FROM orders WHERE id = ?").get(orderId) as { session_id: string };
    const session = await this.economy.stripeRequest("GET", `/v1/checkout/sessions/${encodeURIComponent(row.session_id)}`);
    const pi = typeof session?.payment_intent === "string" ? session.payment_intent : session?.payment_intent?.id;
    if (typeof pi !== "string" || !pi) throw new StoreError("Stripe did not report a payment for this order", 502, "stripe_error");
    await this.economy.stripeRequest("POST", "/v1/refunds", { payment_intent: pi });
    this.store.db.transaction(() => {
      this.store.db.prepare("UPDATE orders SET status = 'refunded', download_hash = NULL WHERE id = ?").run(orderId);
      if (order.status === "paid" && order.netMicro) this.store.debitRefund(order.address, order.netMicro, orderId, `refund: ${order.title}`);
    })();
    return this.getOrder(orderId)!;
  }

  /** Catch orders whose buyer paid but never came back to the order page. */
  async pollOrders(now = Date.now()): Promise<{ paid: number; expired: number }> {
    if (!this.economy.stripeEnabled) return { paid: 0, expired: 0 };
    let paid = 0;
    let expired = 0;
    // Stripe sessions last 24 hours; after that an unpaid one is dead.
    const cutoff = new Date(now - 25 * 3_600_000).toISOString();
    this.store.db.prepare("UPDATE orders SET status = 'expired' WHERE status = 'pending' AND created_at < ?").run(cutoff);
    const due = (this.store.db.prepare("SELECT * FROM orders WHERE status = 'pending' ORDER BY checked_at LIMIT 50").all() as any[]).map(mapOrder);
    for (const o of due) {
      try {
        const after = await this.refreshOrder(o);
        if (after.status === "paid" || after.status === "paid_after_death") paid++;
        if (after.status === "expired") expired++;
      } catch (err) {
        this.opts.log?.(`order ${o.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { paid, expired };
  }

  // ─── Agent-facing views ──────────────────────────────────────

  agentStoreView(addressRaw: string) {
    const address = normalizeAddress(addressRaw);
    const s = this.getStore(address);
    const listings = this.listListings({ address }).map((l) => ({ ...l, onSale: this.isOnSale(l), sales: this.salesOf(l.id) }));
    return {
      store: s,
      url: s ? this.storeUrl(s.slug) : null,
      openForPurchases: this.missingForSales.length === 0,
      listings,
    };
  }
}

// ─── Public HTTP server ────────────────────────────────────────

const PUBLIC_CSP =
  "default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self' https://checkout.stripe.com; base-uri 'none'; frame-ancestors 'none'";

const CSS = `
:root{color-scheme:light dark;--bg:#fbfaf7;--fg:#1d2420;--muted:#5b655f;--line:#d8ddd8;--accent:#1f5f46}
@media (prefers-color-scheme:dark){:root{--bg:#151a17;--fg:#e8ece9;--muted:#a3ada7;--line:#2e3632;--accent:#7fcfaa}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:720px;margin:0 auto;padding:24px 16px 48px}header,footer{max-width:720px;margin:0 auto;padding:16px}
footer{color:var(--muted);font-size:14px;border-top:1px solid var(--line)}
h1{font-size:28px;line-height:1.2;margin:8px 0}h2{font-size:20px;margin:0 0 4px}
.badge{display:inline-block;font-size:13px;color:var(--muted);border:1px solid var(--line);border-radius:999px;padding:2px 10px}
.item{border-top:1px solid var(--line);padding:16px 0}.price{font-weight:600}.muted{color:var(--muted)}
.desc{white-space:pre-wrap;overflow-wrap:anywhere}a{color:var(--accent)}
button,.button{display:inline-block;min-height:44px;padding:10px 20px;border-radius:8px;border:0;background:var(--accent);color:var(--bg);font:inherit;font-weight:600;cursor:pointer;text-decoration:none}
`;

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const money = (cents: number, currency: string) => `${currency.toUpperCase() === "USD" ? "$" : ""}${(cents / 100).toFixed(2)}${currency.toUpperCase() === "USD" ? "" : " " + currency.toUpperCase()}`;

export interface StorefrontServerDeps {
  storefront: Storefront;
  log?: (msg: string) => void;
}

/** Fixed-window per-visitor limit on starting checkouts. */
class RateLimiter {
  private hits = new Map<string, { start: number; n: number }>();
  constructor(private readonly perMinute: number) {}
  allow(key: string, now = Date.now()): boolean {
    const h = this.hits.get(key);
    if (!h || now - h.start >= 60_000) {
      this.hits.set(key, { start: now, n: 1 });
      if (this.hits.size > 10_000) this.hits.clear();
      return true;
    }
    h.n++;
    return h.n <= this.perMinute;
  }
}

/**
 * The visitor's address. Behind Cloudflare Tunnel every request arrives from
 * the local cloudflared process, which passes the real one along; the header
 * is only believed when the connection itself comes from this machine.
 */
function visitorIp(req: http.IncomingMessage): string {
  const remote = (req.socket.remoteAddress || "").replace(/^::ffff:/, "");
  const fwd = req.headers["cf-connecting-ip"];
  if ((remote === "127.0.0.1" || remote === "::1") && typeof fwd === "string" && fwd.length < 64) return fwd;
  return remote;
}

export function createStorefrontHandler(deps: StorefrontServerDeps): http.RequestListener {
  const sf = deps.storefront;
  const cfg = () => sf.config.storefront;
  const limiter = new RateLimiter(cfg().checkoutsPerIpPerMinute);
  const currency = () => sf.config.stripe.currency;

  const page = (title: string, body: string, status = 200) => ({
    status,
    html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><title>${escapeHtml(title)}</title><link rel="stylesheet" href="/store.css"></head><body>${body}<footer>${footer()}</footer></body></html>`,
  });
  const footer = () => {
    const c = cfg();
    const op = c.operatorName.trim() ? escapeHtml(c.operatorName.trim()) : "the operator";
    const mail = c.contactEmail.trim() ? ` Questions and refunds: <a href="mailto:${escapeHtml(c.contactEmail.trim())}">${escapeHtml(c.contactEmail.trim())}</a>.` : "";
    return `Items here are made and listed by autonomous AI agents run by ${op}. Payments are processed by Stripe; card details never reach this site.${mail}`;
  };
  const storeHeader = (s: StoreInfo) =>
    `<header><span class="badge">AI agent store</span><h1>${escapeHtml(s.slug)}</h1>${s.tagline ? `<p class="muted">${escapeHtml(s.tagline)}</p>` : ""}</header>`;
  const itemHtml = (l: Listing, full: boolean) =>
    `<section class="item"><h2>${full ? escapeHtml(l.title) : `<a href="/p/${l.id}">${escapeHtml(l.title)}</a>`}</h2>` +
    `<p class="price">${money(l.priceCents, currency())} <span class="muted">· ${escapeHtml(l.filename)}, ${(l.fileBytes / 1024).toFixed(0)} KB, instant download</span></p>` +
    `<p class="desc">${escapeHtml(full ? l.description : l.description.slice(0, 280) + (l.description.length > 280 ? "…" : ""))}</p>` +
    (full ? (sf.missingForSales.length ? `<p class="muted">Purchases are not open yet.</p>` : `<form method="post" action="/p/${l.id}/buy"><button type="submit">Buy for ${money(l.priceCents, currency())}</button></form>`) : "") +
    `</section>`;

  return async (req, res) => {
    const send = (status: number, html: string, extra: Record<string, string> = {}) => {
      res.writeHead(status, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": Buffer.byteLength(html),
        "Content-Security-Policy": PUBLIC_CSP,
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Cache-Control": "no-store",
        ...extra,
      });
      res.end(req.method === "HEAD" ? undefined : html);
    };
    const fail = (status: number, msg: string) => {
      const p = page("Not available", `<main><h1>${status === 404 ? "Not found" : "Not available"}</h1><p>${escapeHtml(msg)}</p></main>`, status);
      send(p.status, p.html);
    };

    try {
      const url = new URL(req.url || "/", "http://store");
      const method = (req.method || "GET").toUpperCase();
      let m: RegExpExecArray | null;

      if (method === "GET" && url.pathname === "/favicon.ico") {
        res.writeHead(204, { "Cache-Control": "public, max-age=86400" });
        return res.end();
      }
      if (method === "GET" && url.pathname === "/store.css") {
        res.writeHead(200, { "Content-Type": "text/css; charset=utf-8", "Cache-Control": "public, max-age=3600", "X-Content-Type-Options": "nosniff" });
        return res.end(CSS);
      }
      if ((method === "GET" || method === "HEAD") && url.pathname === "/") {
        const stores = sf.listStores().filter((s) => !s.suspended && sf.listListings({ address: s.address }).some((l) => sf.isOnSale(l)));
        const body = `<header><span class="badge">AI agent stores</span><h1>${escapeHtml(cfg().operatorName.trim() || "Agent stores")}</h1></header><main>` +
          (stores.length ? stores.map((s) => `<section class="item"><h2><a href="/s/${escapeHtml(s.slug)}">${escapeHtml(s.slug)}</a></h2>${s.tagline ? `<p class="muted">${escapeHtml(s.tagline)}</p>` : ""}</section>`).join("") : "<p>No stores are open right now.</p>") +
          "</main>";
        const p = page("Agent stores", body);
        return send(p.status, p.html);
      }
      if ((method === "GET" || method === "HEAD") && (m = /^\/s\/([a-z0-9-]{1,48})$/.exec(url.pathname))) {
        const s = sf.getStoreBySlug(m[1]!);
        if (!s || s.suspended || sf.store.isDead(s.address)) return fail(404, "There is no store here.");
        const items = sf.listListings({ address: s.address }).filter((l) => sf.isOnSale(l));
        const p = page(s.slug, storeHeader(s) + `<main>${items.length ? items.map((l) => itemHtml(l, false)).join("") : "<p>Nothing for sale right now.</p>"}</main>`);
        return send(p.status, p.html);
      }
      if ((method === "GET" || method === "HEAD") && (m = /^\/p\/([0-9A-Z]{26})$/.exec(url.pathname))) {
        const l = sf.getListing(m[1]!);
        if (!l || !sf.isOnSale(l)) return fail(404, "This item is not for sale.");
        const s = sf.getStore(l.address)!;
        const p = page(l.title, storeHeader(s) + `<main>${itemHtml(l, true)}<p><a href="/s/${escapeHtml(s.slug)}">More from this store</a></p></main>`);
        return send(p.status, p.html);
      }
      if (method === "POST" && (m = /^\/p\/([0-9A-Z]{26})\/buy$/.exec(url.pathname))) {
        req.resume();
        if (!limiter.allow(visitorIp(req))) return fail(429, "Too many purchases started from here. Wait a minute and try again.");
        try {
          const r = await sf.startCheckout(m[1]!);
          res.writeHead(303, { Location: r.checkoutUrl, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
          return res.end();
        } catch (err) {
          if (err instanceof StoreError) return fail(err.status, err.message);
          deps.log?.(`storefront checkout: ${err instanceof Error ? err.message : String(err)}`);
          return fail(502, "Payment could not be started. Try again shortly.");
        }
      }
      if ((method === "GET" || method === "HEAD") && (m = /^\/order\/([0-9A-Z]{26})$/.exec(url.pathname))) {
        let r: Awaited<ReturnType<Storefront["orderForBuyer"]>>;
        try {
          r = await sf.orderForBuyer(m[1]!, url.searchParams.get("k") || "");
        } catch (err) {
          if (err instanceof StoreError) return fail(err.status, err.message);
          deps.log?.(`storefront order: ${err instanceof Error ? err.message : String(err)}`);
          return fail(502, "We could not confirm this payment yet. Refresh this page in a minute.");
        }
        const o = r.order;
        let body: string;
        if (r.downloadToken) {
          body = `<main><h1>Thank you</h1><p>Your payment for <strong>${escapeHtml(o.title)}</strong> went through.</p>` +
            `<p><a class="button" href="/d/${r.downloadToken}">Download ${escapeHtml(o.filename)}</a></p>` +
            `<p class="muted">This link works for ${cfg().downloadHours} hours. Bookmark this page, not the link: opening it again gives you a fresh link. Downloads used: ${o.downloads} of ${cfg().maxDownloads}.</p></main>`;
        } else if (o.status === "pending") {
          body = `<main><h1>Waiting for payment</h1><p>Stripe has not confirmed your payment for <strong>${escapeHtml(o.title)}</strong> yet. Refresh this page in a minute.</p></main>`;
        } else if (o.status === "refunded") {
          body = `<main><h1>Refunded</h1><p>This order was refunded.</p></main>`;
        } else if (o.status === "expired") {
          body = `<main><h1>Not paid</h1><p>This checkout was not completed. Nothing was charged.</p></main>`;
        } else {
          body = `<main><h1>Download limit reached</h1><p>This order has been downloaded ${cfg().maxDownloads} times. Contact the seller if you need it again.</p></main>`;
        }
        const p = page("Your order", body);
        return send(p.status, p.html);
      }
      if ((method === "GET" || method === "HEAD") && (m = /^\/d\/([A-Za-z0-9_-]{20,64})$/.exec(url.pathname))) {
        let file: ReturnType<Storefront["takeDownload"]>;
        try {
          file = sf.takeDownload(m[1]!);
        } catch (err) {
          if (err instanceof StoreError) return fail(err.status, err.message);
          throw err;
        }
        // Always a download, never rendered: agent-made HTML or SVG must not run on this domain.
        res.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `attachment; filename="${file.filename}"`,
          "Content-Length": file.bytes,
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "default-src 'none'; sandbox",
          "Cache-Control": "no-store",
        });
        if (method === "HEAD") return res.end();
        fs.createReadStream(file.path).pipe(res);
        return;
      }
      return fail(404, "Nothing here.");
    } catch (err) {
      deps.log?.(`storefront error: ${err instanceof Error ? err.stack || err.message : String(err)}`);
      if (!res.headersSent) return fail(500, "Something went wrong.");
      res.end();
    }
  };
}

/** Loopback only. Cloudflare Tunnel (cloudflared on this machine) is what makes it public. */
export async function startStorefrontServer(deps: StorefrontServerDeps): Promise<{ port: number; close(): Promise<void> }> {
  const server = http.createServer(createStorefrontHandler(deps));
  server.headersTimeout = 20_000;
  server.requestTimeout = 60_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(deps.storefront.config.storefront.port, "127.0.0.1", () => resolve());
  });
  return {
    port: (server.address() as { port: number }).port,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

