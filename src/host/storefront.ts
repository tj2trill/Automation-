/**
 * Host Control Plane — Public storefront
 *
 * Agents sell to the public from store pages on the creator's domain.
 * Four kinds of product:
 *   file          a digital file, downloaded right after payment
 *   service       made to order: the buyer says what they want at checkout,
 *                 the agent delivers a file by a deadline, or the buyer is
 *                 refunded automatically. The agent is paid on delivery.
 *   subscription  billed monthly by Stripe; subscribers download every file
 *                 ("drop") the agent publishes while they are subscribed.
 *                 The agent is paid per paid invoice.
 *   print         a design the agent made, printed and shipped by the
 *                 creator's Printful account. The agent is paid the price
 *                 less Stripe's fee and Printful's cost.
 *
 * What goes public is a SEPARATE server on its own loopback port, meant to be
 * published with Cloudflare Tunnel. It serves only store pages, feeds, the
 * buy redirect, order pages and downloads. The agent API and the dashboard
 * are never reachable through it.
 *
 * Agents write listing text, never markup: pages are rendered by fixed
 * templates with every agent string escaped, no script runs on any page,
 * and files are only ever served as attachments with a generic content type
 * (print designs are served as validated PNG images), so an agent cannot
 * host a page that runs code or impersonates a login on the creator's
 * domain. Every page says it is an AI agent's store and who operates it.
 *
 * Agents may also draft promotional posts. Drafts are never posted by the
 * host; the creator reads them, posts the good ones, and marks them posted.
 * Each draft carries its own link, so the agent can see which posts brought
 * visits and sales.
 */

import { createHash, randomBytes, timingSafeEqual } from "crypto";
import fs from "fs";
import http from "http";
import path from "path";
import { monotonicFactory } from "ulid";
import type { HostConfig } from "./config.js";
import { AccountDeadError, HostStore, MICRO_PER_CENT, normalizeAddress } from "./store.js";
import type { Economy, FetchLike } from "./economy.js";
import { PrintfulClient, pngSize, recipientFromSession, type PrintfulProduct } from "./printful.js";

const ulid = monotonicFactory();

export class StoreError extends Error {
  constructor(message: string, public readonly status = 400, public readonly code = "invalid_request") {
    super(message);
    this.name = "StoreError";
  }
}

export type ListingKind = "file" | "service" | "subscription" | "print";
export const LISTING_KINDS: ListingKind[] = ["file", "service", "subscription", "print"];

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
CREATE TABLE IF NOT EXISTS download_tokens (
  hash        TEXT PRIMARY KEY,
  order_id    TEXT NOT NULL,
  drop_id     TEXT NOT NULL DEFAULT '',
  expires_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS download_counts (
  order_id  TEXT NOT NULL,
  drop_id   TEXT NOT NULL DEFAULT '',
  n         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (order_id, drop_id)
);
CREATE TABLE IF NOT EXISTS drops (
  id           TEXT PRIMARY KEY,
  listing_id   TEXT NOT NULL,
  address      TEXT NOT NULL,
  title        TEXT NOT NULL,
  filename     TEXT NOT NULL,
  file_sha256  TEXT NOT NULL,
  file_bytes   INTEGER NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS drops_listing ON drops(listing_id, created_at);
CREATE TABLE IF NOT EXISTS sub_invoices (
  invoice_id  TEXT PRIMARY KEY,
  order_id    TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  net_micro   INTEGER NOT NULL,
  paid_at     TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS promotions (
  id          TEXT PRIMARY KEY,
  address     TEXT NOT NULL,
  listing_id  TEXT,
  platform    TEXT NOT NULL,
  text        TEXT NOT NULL,
  status      TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS promo_hits (
  promotion_id TEXT NOT NULL,
  visitor      TEXT NOT NULL,
  day          TEXT NOT NULL,
  PRIMARY KEY (promotion_id, visitor, day)
);
`;

/** Columns added after the first storefront release, for databases that predate them. */
const LATER_COLUMNS: Record<string, Array<[string, string]>> = {
  listings: [
    ["kind", "TEXT NOT NULL DEFAULT 'file'"],
    ["delivery_hours", "INTEGER"],
    ["request_prompt", "TEXT"],
    ["pod_product", "TEXT"],
  ],
  orders: [
    ["kind", "TEXT NOT NULL DEFAULT 'file'"],
    ["request_text", "TEXT"],
    ["due_at", "TEXT"],
    ["delivered_at", "TEXT"],
    ["delivery_note", "TEXT"],
    ["variant_id", "INTEGER"],
    ["variant_label", "TEXT"],
    ["printful_order_id", "TEXT"],
    ["cost_micro", "INTEGER"],
    ["stripe_subscription", "TEXT"],
    ["canceled_at", "TEXT"],
    ["via", "TEXT"],
    ["note", "TEXT"],
  ],
};

export type OrderStatus =
  | "pending" // checkout started, not paid
  | "expired" // checkout abandoned
  | "paid" // file: paid and downloadable
  | "paid_after_death" // file: paid after the agent died; delivered, money kept by the creator
  | "awaiting_delivery" // service: paid, agent has not delivered yet
  | "delivered" // service: agent delivered; downloadable
  | "fulfilling" // print: sent to Printful
  | "subscribed" // subscription: active
  | "refunding" // a refund is in flight
  | "canceled" // subscription: ended
  | "refunded";

export interface Listing {
  id: string;
  address: string;
  kind: ListingKind;
  title: string;
  description: string;
  /** For a subscription, the monthly price. */
  priceCents: number;
  /** file: the product. print: the design. service and subscription: empty. */
  filename: string;
  fileSha256: string;
  fileBytes: number;
  deliveryHours: number | null;
  requestPrompt: string | null;
  podProduct: string | null;
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
  kind: ListingKind;
  title: string;
  filename: string;
  amountCents: number;
  status: OrderStatus;
  netMicro: number | null;
  createdAt: string;
  paidAt: string | null;
  requestText: string | null;
  dueAt: string | null;
  deliveredAt: string | null;
  deliveryNote: string | null;
  variantLabel: string | null;
  printfulOrderId: string | null;
  costMicro: number | null;
  canceledAt: string | null;
  via: string | null;
  note: string | null;
}

export interface Drop {
  id: string;
  listingId: string;
  title: string;
  filename: string;
  fileBytes: number;
  createdAt: string;
}

export interface StoreInfo {
  address: string;
  slug: string;
  tagline: string;
  suspended: boolean;
}

export interface Promotion {
  id: string;
  address: string;
  listingId: string | null;
  platform: string;
  text: string;
  status: "draft" | "posted" | "discarded";
  link: string | null;
  views: number;
  sales: number;
  createdAt: string;
}

function mapListing(r: any): Listing {
  return {
    id: r.id,
    address: r.address,
    kind: (r.kind || "file") as ListingKind,
    title: r.title,
    description: r.description,
    priceCents: r.price_cents,
    filename: r.filename,
    fileSha256: r.file_sha256,
    fileBytes: r.file_bytes,
    deliveryHours: r.delivery_hours ?? null,
    requestPrompt: r.request_prompt ?? null,
    podProduct: r.pod_product ?? null,
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
    kind: (r.kind || "file") as ListingKind,
    title: r.title,
    filename: r.filename,
    amountCents: r.amount_cents,
    status: r.status,
    netMicro: r.net_micro,
    createdAt: r.created_at,
    paidAt: r.paid_at,
    requestText: r.request_text ?? null,
    dueAt: r.due_at ?? null,
    deliveredAt: r.delivered_at ?? null,
    deliveryNote: r.delivery_note ?? null,
    variantLabel: r.variant_label ?? null,
    printfulOrderId: r.printful_order_id ?? null,
    costMicro: r.cost_micro ?? null,
    canceledAt: r.canceled_at ?? null,
    via: r.via ?? null,
    note: r.note ?? null,
  };
}

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

function sameSecret(given: string, storedHash: string): boolean {
  const a = Buffer.from(sha256(given), "hex");
  const b = Buffer.from(storedHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

// Built from code points so no literal line-separator character sits in the source.
const LINE_SEPARATORS = String.fromCharCode(0x2028, 0x2029);
const CONTROL_ONE_LINE = new RegExp(`[\\u0000-\\u001f\\u007f${LINE_SEPARATORS}]+`, "g");
const CONTROL_KEEP_NEWLINES = new RegExp(`[\\u0000-\\u0009\\u000b-\\u001f\\u007f${LINE_SEPARATORS}]+`, "g");

/** One line of plain text: no control characters, collapsed spaces. */
function cleanLine(v: unknown, max: number, what: string): string {
  const s = typeof v === "string" ? v.replace(CONTROL_ONE_LINE, " ").replace(/\s+/g, " ").trim() : "";
  if (!s || s.length > max) throw new StoreError(`${what} must be 1 to ${max} characters`);
  return s;
}

/** Plain text that keeps line breaks. */
function cleanText(v: unknown, max: number, what: string): string {
  const s = typeof v === "string" ? v.replace(/\r\n?/g, "\n").replace(CONTROL_KEEP_NEWLINES, " ").replace(/\n{3,}/g, "\n\n").trim() : "";
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
  /** Turns on print-on-demand. */
  printfulToken?: string;
  printfulFetch?: FetchLike;
}

const PAID_DOWNLOADABLE = new Set<OrderStatus>(["paid", "paid_after_death", "delivered"]);
const SUB_ACCESS = new Set<OrderStatus>(["subscribed", "canceled"]);

export class Storefront {
  readonly printful: PrintfulClient | null;

  constructor(
    readonly config: HostConfig,
    readonly store: HostStore,
    readonly economy: Economy,
    private readonly opts: StorefrontOptions,
  ) {
    this.store.db.exec(SCHEMA);
    for (const [table, cols] of Object.entries(LATER_COLUMNS)) {
      const have = new Set((this.store.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name));
      for (const [name, def] of cols) if (!have.has(name)) this.store.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`);
    }
    fs.mkdirSync(opts.filesDir, { recursive: true, mode: 0o700 });
    this.printful = opts.printfulToken ? new PrintfulClient(config.printful, opts.printfulToken, opts.printfulFetch) : null;
  }

  private get sf() {
    return this.config.storefront;
  }

  private get base(): string {
    return this.sf.publicUrl.replace(/\/$/, "");
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
    return this.sf.publicUrl ? `${this.base}/s/${slug}` : null;
  }

  listingUrl(id: string): string | null {
    return this.sf.publicUrl ? `${this.base}/p/${id}` : null;
  }

  printProducts(): PrintfulProduct[] {
    return this.printful ? this.config.printful.products : [];
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

  /** A store visitors can see: open, alive, with something on sale. */
  isStoreVisible(s: StoreInfo): boolean {
    return !s.suspended && !this.store.isDead(s.address) && this.listListings({ address: s.address }).some((l) => this.isOnSale(l));
  }

  // ─── Files ───────────────────────────────────────────────────

  private filePath(hash: string): string {
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new StoreError("bad file reference", 500, "internal");
    return path.join(this.opts.filesDir, hash);
  }

  private assertCanSell(address: string): void {
    if (this.store.isDead(address)) throw new StoreError("This account is dead", 403, "account_dead");
    if (this.store.isFrozen(address)) throw new StoreError("Account is frozen by the creator", 403, "account_frozen");
  }

  private storeBytes(address: string): number {
    const a = this.store.db.prepare("SELECT COALESCE(SUM(file_bytes),0) AS b FROM listings WHERE address = ? AND removed = 0").get(address) as { b: number };
    const d = this.store.db.prepare("SELECT COALESCE(SUM(file_bytes),0) AS b FROM drops WHERE address = ?").get(address) as { b: number };
    return a.b + d.b;
  }

  /** Decode, check limits, and keep a file by its content hash. */
  private keepFile(address: string, contentBase64: unknown, extraBytesCounted = true): { hash: string; bytes: Buffer } {
    if (typeof contentBase64 !== "string" || !contentBase64) throw new StoreError("content_base64 (the file) is required");
    if (!/^[A-Za-z0-9+/=\s]+$/.test(contentBase64)) throw new StoreError("content_base64 is not base64");
    const bytes = Buffer.from(contentBase64, "base64");
    if (bytes.length === 0) throw new StoreError("The file is empty");
    if (bytes.length > this.sf.maxFileMb * 1024 * 1024) throw new StoreError(`Files may be at most ${this.sf.maxFileMb} MB`, 413, "too_large");
    if (extraBytesCounted && this.storeBytes(address) + bytes.length > this.sf.maxStoreMb * 1024 * 1024) {
      throw new StoreError(`A store may hold at most ${this.sf.maxStoreMb} MB of files`, 413, "store_full");
    }
    const hash = sha256(bytes);
    const target = this.filePath(hash);
    if (!fs.existsSync(target)) {
      const tmp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
      fs.writeFileSync(tmp, bytes, { mode: 0o600 });
      fs.renameSync(tmp, target);
    }
    return { hash, bytes };
  }

  // ─── Listings ────────────────────────────────────────────────

  private priceCents(v: unknown, floorCents = 0): number {
    const p = Number(v);
    const { minAmountCents, maxAmountCents } = this.config.stripe;
    const min = Math.max(minAmountCents, floorCents);
    if (!Number.isInteger(p) || p < min || p > maxAmountCents) {
      throw new StoreError(`price_cents must be a whole number from ${min} to ${maxAmountCents}`);
    }
    if (this.economy.netOfFees(p) <= 0) throw new StoreError("That price would be consumed entirely by the processing fee");
    return p;
  }

  private printFloor(product: PrintfulProduct): number {
    return product.baseCostCents + this.config.printful.minMarginCents;
  }

  createListing(
    addressRaw: string,
    input: {
      kind?: unknown;
      title: unknown;
      description: unknown;
      priceCents: unknown;
      filename?: unknown;
      contentBase64?: unknown;
      deliveryHours?: unknown;
      requestPrompt?: unknown;
      podProduct?: unknown;
    },
  ): Listing {
    const address = normalizeAddress(addressRaw);
    this.assertCanSell(address);
    const kind = (input.kind === undefined || input.kind === null || input.kind === "" ? "file" : input.kind) as ListingKind;
    if (!LISTING_KINDS.includes(kind)) throw new StoreError(`kind must be one of ${LISTING_KINDS.join(", ")}`);
    const title = cleanLine(input.title, 80, "title");
    const description = cleanText(input.description, 4000, "description");
    const count = this.store.db.prepare("SELECT COUNT(*) AS n FROM listings WHERE address = ? AND removed = 0").get(address) as { n: number };
    if (count.n >= this.sf.maxListingsPerAgent) throw new StoreError(`At most ${this.sf.maxListingsPerAgent} listings per store`, 429, "too_many_listings");

    let filename = "";
    let hash = "";
    let bytes = 0;
    let deliveryHours: number | null = null;
    let requestPrompt: string | null = null;
    let podProduct: string | null = null;
    let priceCents: number;

    if (kind === "file") {
      priceCents = this.priceCents(input.priceCents);
      filename = cleanFilename(input.filename);
      const kept = this.keepFile(address, input.contentBase64);
      hash = kept.hash;
      bytes = kept.bytes.length;
    } else if (kind === "service") {
      priceCents = this.priceCents(input.priceCents);
      const h = Number(input.deliveryHours);
      if (!Number.isInteger(h) || h < 1 || h > this.sf.maxDeliveryHours) {
        throw new StoreError(`delivery_hours must be a whole number from 1 to ${this.sf.maxDeliveryHours}`);
      }
      deliveryHours = h;
      requestPrompt = cleanLine(input.requestPrompt, 300, "request_prompt (what the buyer should tell you)");
    } else if (kind === "subscription") {
      priceCents = this.priceCents(input.priceCents);
    } else {
      if (!this.printful) throw new StoreError("Print-on-demand is not turned on by your creator", 503, "print_disabled");
      const product = this.config.printful.products.find((p) => p.key === input.podProduct);
      if (!product) {
        const keys = this.config.printful.products.map((p) => p.key).join(", ") || "none";
        throw new StoreError(`pod_product must be one of: ${keys}`);
      }
      priceCents = this.priceCents(input.priceCents, this.printFloor(product));
      podProduct = product.key;
      filename = cleanFilename(input.filename || "design.png");
      if (!/\.png$/i.test(filename)) filename += ".png";
      const decoded = typeof input.contentBase64 === "string" ? Buffer.from(input.contentBase64, "base64") : Buffer.alloc(0);
      const size = pngSize(decoded);
      if (!size) throw new StoreError("A print design must be a PNG image");
      const min = this.config.printful.minDesignPx;
      if (size.width < min || size.height < min) throw new StoreError(`A print design must be at least ${min}x${min} pixels; this one is ${size.width}x${size.height}`);
      const kept = this.keepFile(address, input.contentBase64);
      hash = kept.hash;
      bytes = kept.bytes.length;
    }

    this.ensureStore(address);
    const id = ulid();
    const now = new Date().toISOString();
    this.store.db
      .prepare(
        `INSERT INTO listings (id, address, kind, title, description, price_cents, filename, file_sha256, file_bytes,
           delivery_hours, request_prompt, pod_product, live, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(id, address, kind, title, description, priceCents, filename, hash, bytes, deliveryHours, requestPrompt, podProduct, now, now);
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
    if (l.kind === "print" && (!this.printful || !this.config.printful.products.some((p) => p.key === l.podProduct))) return false;
    const s = this.getStore(l.address);
    if (!s || s.suspended) return false;
    return !this.store.isDead(l.address) && !this.store.isFrozen(l.address);
  }

  updateListing(
    addressRaw: string,
    id: string,
    patch: { title?: unknown; description?: unknown; priceCents?: unknown; live?: unknown; deliveryHours?: unknown; requestPrompt?: unknown },
  ): Listing {
    const address = normalizeAddress(addressRaw);
    this.assertCanSell(address);
    const l = this.getListing(id);
    if (!l || l.address !== address || l.removed) throw new StoreError(`No listing ${id}`, 404, "not_found");
    if (patch.live !== undefined && typeof patch.live !== "boolean") throw new StoreError("live must be true or false");
    const product = l.kind === "print" ? this.config.printful.products.find((p) => p.key === l.podProduct) : undefined;
    const next = {
      title: patch.title === undefined ? l.title : cleanLine(patch.title, 80, "title"),
      description: patch.description === undefined ? l.description : cleanText(patch.description, 4000, "description"),
      priceCents: patch.priceCents === undefined ? l.priceCents : this.priceCents(patch.priceCents, product ? this.printFloor(product) : 0),
      live: patch.live === undefined ? l.live : patch.live === true,
      deliveryHours: l.deliveryHours,
      requestPrompt: l.requestPrompt,
    };
    if (l.kind === "service") {
      if (patch.deliveryHours !== undefined) {
        const h = Number(patch.deliveryHours);
        if (!Number.isInteger(h) || h < 1 || h > this.sf.maxDeliveryHours) throw new StoreError(`delivery_hours must be a whole number from 1 to ${this.sf.maxDeliveryHours}`);
        next.deliveryHours = h;
      }
      if (patch.requestPrompt !== undefined) next.requestPrompt = cleanLine(patch.requestPrompt, 300, "request_prompt");
    }
    // A subscription's price is fixed per subscriber at checkout; a change applies to new subscribers.
    this.store.db
      .prepare("UPDATE listings SET title = ?, description = ?, price_cents = ?, live = ?, delivery_hours = ?, request_prompt = ?, updated_at = ? WHERE id = ?")
      .run(next.title, next.description, next.priceCents, next.live ? 1 : 0, next.deliveryHours, next.requestPrompt, new Date().toISOString(), id);
    return this.getListing(id)!;
  }

  /** Creator only. */
  setPulled(id: string, pulled: boolean): Listing {
    const l = this.getListing(id);
    if (!l || l.removed) throw new StoreError(`No listing ${id}`, 404, "not_found");
    this.store.db.prepare("UPDATE listings SET pulled = ?, updated_at = ? WHERE id = ?").run(pulled ? 1 : 0, new Date().toISOString(), id);
    return this.getListing(id)!;
  }

  /**
   * When an agent dies its store closes for good. Buyers of finished orders
   * still download what they paid for. Unfinished made-to-order work is
   * refunded, and subscriptions are cancelled so nobody keeps paying a dead
   * agent.
   */
  async closeStoreOf(addressRaw: string): Promise<void> {
    const address = normalizeAddress(addressRaw);
    this.store.db.prepare("UPDATE listings SET removed = 1, live = 0 WHERE address = ?").run(address);
    const open = (this.store.db.prepare("SELECT * FROM orders WHERE address = ? AND status IN ('awaiting_delivery','subscribed')").all(address) as any[]).map(mapOrder);
    for (const o of open) {
      try {
        if (o.status === "awaiting_delivery") await this.refundUndelivered(o, "the seller closed before delivering");
        else await this.cancelSubscription(o, true);
      } catch (err) {
        this.opts.log?.(`closing order ${o.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /** Kept for callers that cannot wait; prefer closeStoreOf. */
  removeStoreOf(addressRaw: string): Promise<void> {
    return this.closeStoreOf(addressRaw);
  }

  salesOf(listingId: string): { count: number; netMicro: number; subscribers: number; waiting: number } {
    const sold = this.store.db
      .prepare("SELECT COUNT(*) AS n FROM orders WHERE listing_id = ? AND status IN ('paid','paid_after_death','delivered','fulfilling','subscribed','canceled')")
      .get(listingId) as { n: number };
    const net = this.store.db
      .prepare("SELECT COALESCE(SUM(delta_micro),0) AS net FROM ledger WHERE kind IN ('sale','refund') AND ref IN (SELECT id FROM orders WHERE listing_id = ? UNION SELECT invoice_id FROM sub_invoices WHERE order_id IN (SELECT id FROM orders WHERE listing_id = ?))")
      .get(listingId, listingId) as { net: number };
    const subs = this.store.db.prepare("SELECT COUNT(*) AS n FROM orders WHERE listing_id = ? AND status = 'subscribed'").get(listingId) as { n: number };
    const waiting = this.store.db.prepare("SELECT COUNT(*) AS n FROM orders WHERE listing_id = ? AND status = 'awaiting_delivery'").get(listingId) as { n: number };
    return { count: sold.n, netMicro: net.net, subscribers: subs.n, waiting: waiting.n };
  }

  // ─── Subscription drops ──────────────────────────────────────

  publishDrop(addressRaw: string, listingId: string, input: { title: unknown; filename: unknown; contentBase64: unknown }): Drop {
    const address = normalizeAddress(addressRaw);
    this.assertCanSell(address);
    const l = this.getListing(listingId);
    if (!l || l.address !== address || l.removed) throw new StoreError(`No listing ${listingId}`, 404, "not_found");
    if (l.kind !== "subscription") throw new StoreError("Drops can only be published to a subscription listing");
    const title = cleanLine(input.title, 120, "title");
    const filename = cleanFilename(input.filename);
    const kept = this.keepFile(address, input.contentBase64);
    const id = ulid();
    this.store.db
      .prepare("INSERT INTO drops (id, listing_id, address, title, filename, file_sha256, file_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, l.id, address, title, filename, kept.hash, kept.bytes.length, new Date().toISOString());
    return this.listDrops(l.id).find((d) => d.id === id)!;
  }

  listDrops(listingId: string): Drop[] {
    return (this.store.db.prepare("SELECT * FROM drops WHERE listing_id = ? ORDER BY id DESC").all(listingId) as any[]).map((r) => ({
      id: r.id, listingId: r.listing_id, title: r.title, filename: r.filename, fileBytes: r.file_bytes, createdAt: r.created_at,
    }));
  }

  /** Drops a subscriber may download: published while their subscription was running. */
  dropsFor(order: Order): Drop[] {
    if (!SUB_ACCESS.has(order.status) || !order.paidAt) return [];
    const end = order.canceledAt ? new Date(order.canceledAt).getTime() : Infinity;
    const start = new Date(order.paidAt).getTime();
    return this.listDrops(order.listingId).filter((d) => {
      const t = new Date(d.createdAt).getTime();
      return t >= start && t <= end;
    });
  }

  // ─── Orders ──────────────────────────────────────────────────

  getOrder(id: string): Order | null {
    const r = this.store.db.prepare("SELECT * FROM orders WHERE id = ?").get(id);
    return r ? mapOrder(r) : null;
  }

  listOrders(filter: { address?: string; limit?: number; paidOnly?: boolean; status?: OrderStatus } = {}): Order[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (filter.address) {
      where.push("address = ?");
      args.push(normalizeAddress(filter.address));
    }
    if (filter.status) {
      where.push("status = ?");
      args.push(filter.status);
    } else if (filter.paidOnly) {
      where.push("status NOT IN ('pending','expired')");
    }
    const sql = `SELECT * FROM orders ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ?`;
    return (this.store.db.prepare(sql).all(...args, filter.limit ?? 100) as any[]).map(mapOrder);
  }

  /**
   * Start a purchase: an order row and a Stripe Checkout session. Returns the
   * Stripe page to send the customer to and the order page they come back to.
   */
  async startCheckout(
    listingId: string,
    extra: { request?: unknown; variantId?: unknown; via?: unknown } = {},
  ): Promise<{ checkoutUrl: string; orderId: string; orderKey: string }> {
    const missing = this.missingForSales;
    if (missing.length) throw new StoreError("This store is not open for purchases yet.", 503, "store_closed");
    const l = this.getListing(listingId);
    if (!l || !this.isOnSale(l)) throw new StoreError("This item is not for sale.", 404, "not_found");
    const pending = this.store.db.prepare("SELECT COUNT(*) AS n FROM orders WHERE status = 'pending'").get() as { n: number };
    if (pending.n >= 1000) throw new StoreError("Too many checkouts are open. Try again later.", 503, "busy");

    let requestText: string | null = null;
    let variant: { id: number; label: string } | null = null;
    if (l.kind === "service") requestText = cleanText(extra.request, 4000, "Your request");
    if (l.kind === "print") {
      const product = this.config.printful.products.find((p) => p.key === l.podProduct)!;
      variant = product.variants.find((v) => String(v.id) === String(extra.variantId)) ?? null;
      if (!variant) throw new StoreError("Choose a size or option.");
    }
    const via = typeof extra.via === "string" && /^[0-9A-Z]{26}$/.test(extra.via) && this.getPromotionRow(extra.via)?.address === l.address ? extra.via : null;

    const id = ulid();
    const orderKey = randomBytes(24).toString("base64url");
    const now = new Date().toISOString();
    this.store.db
      .prepare(
        `INSERT INTO orders (id, order_key_hash, listing_id, address, kind, title, filename, file_sha256, amount_cents, status,
           request_text, variant_id, variant_label, via, created_at, checked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, sha256(orderKey), l.id, l.address, l.kind, l.title, l.filename, l.fileSha256, l.priceCents, requestText, variant?.id ?? null, variant?.label ?? null, via, now, now);

    const fields: Record<string, string | number> = {
      mode: l.kind === "subscription" ? "subscription" : "payment",
      success_url: `${this.base}/order/${id}?k=${orderKey}`,
      cancel_url: `${this.base}/p/${l.id}`,
      client_reference_id: id,
      "line_items[0][quantity]": 1,
      "line_items[0][price_data][currency]": this.config.stripe.currency,
      "line_items[0][price_data][unit_amount]": l.priceCents,
      "line_items[0][price_data][product_data][name]": variant ? `${l.title} (${variant.label})` : l.title,
      "metadata[automaton_address]": l.address,
      "metadata[automaton_order]": id,
      "metadata[automaton_listing]": l.id,
    };
    if (l.kind === "subscription") fields["line_items[0][price_data][recurring][interval]"] = "month";
    if (l.kind === "print") {
      this.config.printful.shipCountries.forEach((c, i) => {
        fields[`shipping_address_collection[allowed_countries][${i}]`] = c;
      });
    }
    let session: any;
    try {
      session = await this.economy.stripeRequest("POST", "/v1/checkout/sessions", fields);
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

  private credit(order: Order, netMicro: number, ref: string, note: string): boolean {
    if (netMicro <= 0) return true;
    try {
      this.store.credit(order.address, netMicro, "sale", ref, note);
      return true;
    } catch (err) {
      if (err instanceof AccountDeadError) return false;
      throw err;
    }
  }

  /** Record a paid checkout once, then do what that kind of product needs. */
  private async settle(order: Order, session: any): Promise<void> {
    const total = Number.isFinite(session?.amount_total) ? Math.floor(session.amount_total) : order.amountCents;
    const net = this.economy.netOfFees(total);
    const now = new Date();
    const l = this.getListing(order.listingId);

    if (order.kind === "file") {
      this.store.db.transaction(() => {
        const claimed = this.store.db.prepare("UPDATE orders SET status = 'paid', net_micro = ?, paid_at = ? WHERE id = ? AND status = 'pending'").run(net, now.toISOString(), order.id).changes;
        if (claimed !== 1) return;
        if (!this.credit(order, net, order.id, `store: ${order.title}`)) this.store.db.prepare("UPDATE orders SET status = 'paid_after_death' WHERE id = ?").run(order.id);
      })();
      return;
    }

    if (order.kind === "service") {
      // Paid on delivery, not now: the money waits with the creator until the work arrives.
      const due = new Date(now.getTime() + (l?.deliveryHours ?? 24) * 3_600_000).toISOString();
      this.store.db.prepare("UPDATE orders SET status = 'awaiting_delivery', net_micro = ?, paid_at = ?, due_at = ? WHERE id = ? AND status = 'pending'").run(net, now.toISOString(), due, order.id);
      if (this.store.isDead(order.address)) await this.refundUndelivered(this.getOrder(order.id)!, "the seller closed before delivering");
      return;
    }

    if (order.kind === "subscription") {
      const subId = typeof session?.subscription === "string" ? session.subscription : session?.subscription?.id;
      const claimed = this.store.db
        .prepare("UPDATE orders SET status = 'subscribed', paid_at = ?, stripe_subscription = ? WHERE id = ? AND status = 'pending'")
        .run(now.toISOString(), subId ?? null, order.id).changes;
      if (claimed === 1) {
        if (this.store.isDead(order.address)) await this.cancelSubscription(this.getOrder(order.id)!, true);
        else await this.syncSubscription(this.getOrder(order.id)!);
      }
      return;
    }

    // print: claim first, so a second visit cannot send the order to the printer twice.
    const claimed = this.store.db.prepare("UPDATE orders SET status = 'fulfilling', net_micro = ?, paid_at = ? WHERE id = ? AND status = 'pending'").run(net, now.toISOString(), order.id).changes;
    if (claimed !== 1) return;
    const fresh = this.getOrder(order.id)!;
    const variantRow = this.store.db.prepare("SELECT variant_id FROM orders WHERE id = ?").get(order.id) as { variant_id: number };
    const recipient = recipientFromSession(session);
    const product = this.config.printful.products.find((p) => p.key === l?.podProduct);
    try {
      if (!this.printful || !product) throw new Error("print-on-demand is no longer set up on this host");
      if (!recipient) throw new Error("Stripe did not return a shipping address");
      const pf = await this.printful.createOrder({
        externalId: order.id,
        recipient,
        variantId: variantRow.variant_id,
        // Printful downloads the design from the public storefront.
        fileUrl: `${this.base}/design/${(this.store.db.prepare("SELECT file_sha256 FROM orders WHERE id = ?").get(order.id) as any).file_sha256}.png`,
      });
      const cost = Number.isFinite(pf.costMicro) ? pf.costMicro : product.baseCostCents * MICRO_PER_CENT;
      const agentShare = net - cost;
      this.store.db.prepare("UPDATE orders SET printful_order_id = ?, cost_micro = ?, note = ? WHERE id = ?").run(pf.id, cost, `Printful order ${pf.id} (${pf.status})`, order.id);
      if (!this.credit(fresh, agentShare, order.id, `print: ${order.title}`)) {
        this.store.db.prepare("UPDATE orders SET note = ? WHERE id = ?").run(`Printful order ${pf.id}; paid after the agent died, money kept by the creator`, order.id);
      }
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      this.opts.log?.(`print order ${order.id} could not be placed: ${why}`);
      await this.refundPayment(fresh, `could not be printed: ${why}`).catch((e) => this.opts.log?.(`refund of ${order.id} failed: ${e?.message || e}`));
    }
  }

  /** The payment behind an order, for refunds. */
  private async paymentIntentOf(orderId: string): Promise<string> {
    const row = this.store.db.prepare("SELECT session_id FROM orders WHERE id = ?").get(orderId) as { session_id: string };
    const session = await this.economy.stripeRequest("GET", `/v1/checkout/sessions/${encodeURIComponent(row.session_id)}`);
    const pi = typeof session?.payment_intent === "string" ? session.payment_intent : session?.payment_intent?.id;
    if (typeof pi !== "string" || !pi) throw new StoreError("Stripe did not report a payment for this order", 502, "stripe_error");
    return pi;
  }

  /** Refund the buyer in full. Nothing is taken from the agent: it was never paid for this order. */
  private async refundPayment(order: Order, reason: string): Promise<void> {
    const pi = await this.paymentIntentOf(order.id);
    await this.economy.stripeRequest("POST", "/v1/refunds", { payment_intent: pi });
    this.store.db.prepare("UPDATE orders SET status = 'refunded', note = ? WHERE id = ?").run(`Refunded: ${reason}`, order.id);
    await this.revokeDownloads(order.id);
  }

  private async refundUndelivered(order: Order, reason: string): Promise<void> {
    const claimed = this.store.db.prepare("UPDATE orders SET status = 'refunding' WHERE id = ? AND status = 'awaiting_delivery'").run(order.id).changes;
    if (claimed !== 1) return;
    try {
      await this.refundPayment(order, reason);
    } catch (err) {
      this.store.db.prepare("UPDATE orders SET status = 'awaiting_delivery' WHERE id = ? AND status = 'refunding'").run(order.id);
      throw err;
    }
  }

  private revokeDownloads(orderId: string): void {
    this.store.db.prepare("DELETE FROM download_tokens WHERE order_id = ?").run(orderId);
  }

  /** Ask Stripe about one pending order. */
  private async refreshOrder(order: Order): Promise<Order> {
    if (order.status !== "pending") return order;
    const row = this.store.db.prepare("SELECT session_id FROM orders WHERE id = ?").get(order.id) as { session_id: string | null };
    this.store.db.prepare("UPDATE orders SET checked_at = ? WHERE id = ?").run(new Date().toISOString(), order.id);
    if (!row?.session_id) return order;
    const session = await this.economy.stripeRequest("GET", `/v1/checkout/sessions/${encodeURIComponent(row.session_id)}`);
    if (session?.payment_status === "paid" || (order.kind === "subscription" && session?.status === "complete")) await this.settle(order, session);
    else if (session?.status === "expired") this.store.db.prepare("UPDATE orders SET status = 'expired' WHERE id = ? AND status = 'pending'").run(order.id);
    return this.getOrder(order.id)!;
  }

  // ─── Made-to-order delivery ──────────────────────────────────

  /** Work the agent still owes, oldest first. Request text is the buyer's words. */
  openRequests(addressRaw: string): Order[] {
    return (this.store.db.prepare("SELECT * FROM orders WHERE address = ? AND status = 'awaiting_delivery' ORDER BY due_at").all(normalizeAddress(addressRaw)) as any[]).map(mapOrder);
  }

  deliver(addressRaw: string, orderId: string, input: { filename: unknown; contentBase64: unknown; note?: unknown }): Order {
    const address = normalizeAddress(addressRaw);
    this.assertCanSell(address);
    const o = this.getOrder(orderId);
    if (!o || o.address !== address) throw new StoreError(`No order ${orderId}`, 404, "not_found");
    if (o.status !== "awaiting_delivery") throw new StoreError(`Order is ${o.status}`, 409, "conflict");
    if (o.dueAt && new Date(o.dueAt).getTime() < Date.now()) throw new StoreError("Too late: the delivery deadline has passed and the buyer is being refunded", 409, "overdue");
    const filename = cleanFilename(input.filename);
    const note = input.note === undefined || input.note === "" ? null : cleanText(input.note, 2000, "note");
    // Deliveries are kept until downloaded, but do not count against the store's space.
    const kept = this.keepFile(address, input.contentBase64, false);
    const now = new Date().toISOString();
    this.store.db.transaction(() => {
      const claimed = this.store.db
        .prepare("UPDATE orders SET status = 'delivered', filename = ?, file_sha256 = ?, delivered_at = ?, delivery_note = ? WHERE id = ? AND status = 'awaiting_delivery'")
        .run(filename, kept.hash, now, note, orderId).changes;
      if (claimed !== 1) throw new StoreError("Order changed while delivering; check it again", 409, "conflict");
      this.credit(o, o.netMicro ?? 0, o.id, `delivered: ${o.title}`);
    })();
    return this.getOrder(orderId)!;
  }

  // ─── Subscriptions ───────────────────────────────────────────

  /** Pull a subscription's state and credit any new paid invoices. */
  async syncSubscription(order: Order): Promise<void> {
    const row = this.store.db.prepare("SELECT stripe_subscription FROM orders WHERE id = ?").get(order.id) as { stripe_subscription: string | null };
    this.store.db.prepare("UPDATE orders SET checked_at = ? WHERE id = ?").run(new Date().toISOString(), order.id);
    const subId = row?.stripe_subscription;
    if (!subId) return;
    const list = await this.economy.stripeRequest("GET", `/v1/invoices?subscription=${encodeURIComponent(subId)}&status=paid&limit=100`);
    for (const inv of Array.isArray(list?.data) ? list.data : []) {
      if (typeof inv?.id !== "string" || !(inv.amount_paid > 0)) continue;
      const seen = this.store.db.prepare("SELECT 1 FROM sub_invoices WHERE invoice_id = ?").get(inv.id);
      if (seen) continue;
      const net = this.economy.netOfFees(Math.floor(inv.amount_paid));
      this.store.db.transaction(() => {
        this.store.db.prepare("INSERT INTO sub_invoices (invoice_id, order_id, amount_cents, net_micro, paid_at) VALUES (?, ?, ?, ?, ?)").run(inv.id, order.id, Math.floor(inv.amount_paid), net, new Date().toISOString());
        this.credit(order, net, inv.id, `subscription: ${order.title}`);
      })();
    }
    const sub = await this.economy.stripeRequest("GET", `/v1/subscriptions/${encodeURIComponent(subId)}`);
    if (["canceled", "unpaid", "incomplete_expired"].includes(sub?.status)) {
      this.store.db.prepare("UPDATE orders SET status = 'canceled', canceled_at = COALESCE(canceled_at, ?) WHERE id = ? AND status = 'subscribed'").run(new Date().toISOString(), order.id);
    }
  }

  /** Buyer or death: end a subscription. now=false keeps it to the end of the paid month. */
  async cancelSubscription(order: Order, now: boolean): Promise<Order> {
    if (order.status !== "subscribed") throw new StoreError(`Subscription is ${order.status}`, 409, "conflict");
    const row = this.store.db.prepare("SELECT stripe_subscription FROM orders WHERE id = ?").get(order.id) as { stripe_subscription: string | null };
    if (row?.stripe_subscription) {
      if (now) await this.economy.stripeRequest("POST", `/v1/subscriptions/${encodeURIComponent(row.stripe_subscription)}/cancel`, {});
      else await this.economy.stripeRequest("POST", `/v1/subscriptions/${encodeURIComponent(row.stripe_subscription)}`, { cancel_at_period_end: "true" });
    }
    if (now) this.store.db.prepare("UPDATE orders SET status = 'canceled', canceled_at = ? WHERE id = ?").run(new Date().toISOString(), order.id);
    else this.store.db.prepare("UPDATE orders SET note = ? WHERE id = ?").run("Cancels at the end of the paid month", order.id);
    return this.getOrder(order.id)!;
  }

  // ─── Buyers ──────────────────────────────────────────────────

  private checkKey(orderId: string, key: string): Order {
    const row = this.store.db.prepare("SELECT order_key_hash FROM orders WHERE id = ?").get(orderId) as { order_key_hash: string } | undefined;
    if (!row || typeof key !== "string" || !key || !sameSecret(key, row.order_key_hash)) throw new StoreError("Order not found.", 404, "not_found");
    return this.getOrder(orderId)!;
  }

  private issueToken(orderId: string, dropId = ""): string {
    const token = randomBytes(24).toString("base64url");
    const expires = new Date(Date.now() + this.sf.downloadHours * 3_600_000).toISOString();
    this.store.db.transaction(() => {
      // A fresh visit replaces the old link for the same file.
      this.store.db.prepare("DELETE FROM download_tokens WHERE order_id = ? AND drop_id = ?").run(orderId, dropId);
      this.store.db.prepare("INSERT INTO download_tokens (hash, order_id, drop_id, expires_at) VALUES (?, ?, ?, ?)").run(sha256(token), orderId, dropId, expires);
    })();
    return token;
  }

  downloadsUsed(orderId: string, dropId = ""): number {
    const r = this.store.db.prepare("SELECT n FROM download_counts WHERE order_id = ? AND drop_id = ?").get(orderId, dropId) as { n: number } | undefined;
    return r?.n ?? 0;
  }

  /**
   * The buyer's order page: proves they hold the order key, refreshes the
   * order, and hands out fresh download links for what they may download.
   */
  async orderForBuyer(orderId: string, key: string): Promise<{
    order: Order;
    downloadToken: string | null;
    drops: Array<Drop & { token: string | null; used: number }>;
  }> {
    let order = this.checkKey(orderId, key);
    if (order.status === "pending") order = await this.refreshOrder(order);
    else if (order.status === "subscribed") {
      await this.syncSubscription(order).catch((err) => this.opts.log?.(`subscription ${order.id}: ${err?.message || err}`));
      order = this.getOrder(order.id)!;
    }
    const usable = PAID_DOWNLOADABLE.has(order.status) && this.downloadsUsed(order.id) < this.sf.maxDownloads;
    const drops = this.dropsFor(order).map((d) => {
      const used = this.downloadsUsed(order.id, d.id);
      return { ...d, used, token: used < this.sf.maxDownloads ? this.issueToken(order.id, d.id) : null };
    });
    return { order, downloadToken: usable ? this.issueToken(order.id) : null, drops };
  }

  async buyerCancel(orderId: string, key: string): Promise<Order> {
    const order = this.checkKey(orderId, key);
    return this.cancelSubscription(order, false);
  }

  /** Count and resolve a download link. */
  takeDownload(token: string): { filename: string; path: string; bytes: number } {
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{20,64}$/.test(token)) throw new StoreError("Link not found.", 404, "not_found");
    const t = this.store.db.prepare("SELECT * FROM download_tokens WHERE hash = ?").get(sha256(token)) as any;
    if (!t) throw new StoreError("Link not found.", 404, "not_found");
    const o = this.getOrder(t.order_id);
    const allowed = t.drop_id ? o && SUB_ACCESS.has(o.status) && this.dropsFor(o).some((d) => d.id === t.drop_id) : o && PAID_DOWNLOADABLE.has(o.status);
    if (!o || !allowed) throw new StoreError("Link not found.", 404, "not_found");
    if (new Date(t.expires_at).getTime() < Date.now()) throw new StoreError("This download link has expired. Open your order page again for a new one.", 410, "expired");
    const counted = this.store.db.transaction(() => {
      this.store.db.prepare("INSERT OR IGNORE INTO download_counts (order_id, drop_id, n) VALUES (?, ?, 0)").run(o.id, t.drop_id);
      return this.store.db.prepare("UPDATE download_counts SET n = n + 1 WHERE order_id = ? AND drop_id = ? AND n < ?").run(o.id, t.drop_id, this.sf.maxDownloads).changes;
    })();
    if (counted !== 1) throw new StoreError(`This has been downloaded ${this.sf.maxDownloads} times, the limit. Contact the seller.`, 410, "used_up");
    let filename: string;
    let hash: string;
    if (t.drop_id) {
      const d = this.store.db.prepare("SELECT filename, file_sha256 FROM drops WHERE id = ?").get(t.drop_id) as any;
      filename = d.filename;
      hash = d.file_sha256;
    } else {
      const r = this.store.db.prepare("SELECT filename, file_sha256 FROM orders WHERE id = ?").get(o.id) as any;
      filename = r.filename;
      hash = r.file_sha256;
    }
    const p = this.filePath(hash);
    if (!fs.existsSync(p)) throw new StoreError("The file is missing. Contact the seller.", 500, "missing");
    return { filename, path: p, bytes: fs.statSync(p).size };
  }

  /** A print design, as an image, for its listing page and for Printful to fetch. */
  designFile(hash: string): string | null {
    if (!/^[0-9a-f]{64}$/.test(hash)) return null;
    const used = this.store.db.prepare("SELECT 1 FROM listings WHERE kind = 'print' AND file_sha256 = ? LIMIT 1").get(hash);
    if (!used) return null;
    const p = this.filePath(hash);
    return fs.existsSync(p) ? p : null;
  }

  // ─── Creator ─────────────────────────────────────────────────

  /** Refund through Stripe; whatever the agent was credited for it is taken back. */
  async refund(orderId: string): Promise<Order> {
    const order = this.getOrder(orderId);
    if (!order) throw new StoreError(`No order ${orderId}`, 404, "not_found");
    if (order.kind === "subscription") throw new StoreError("Refund subscription payments from your Stripe dashboard; cancel here.", 409, "conflict");
    if (order.status === "awaiting_delivery") {
      await this.refundUndelivered(order, "refunded by the store owner");
      return this.getOrder(orderId)!;
    }
    if (!["paid", "paid_after_death", "delivered", "fulfilling"].includes(order.status)) throw new StoreError(`Order is ${order.status}`, 409, "conflict");
    const pi = await this.paymentIntentOf(orderId);
    await this.economy.stripeRequest("POST", "/v1/refunds", { payment_intent: pi });
    const credited = this.store.db.prepare("SELECT COALESCE(SUM(delta_micro),0) AS c FROM ledger WHERE kind = 'sale' AND ref = ?").get(orderId) as { c: number };
    this.store.db.transaction(() => {
      this.store.db.prepare("UPDATE orders SET status = 'refunded', note = COALESCE(note || '; ', '') || 'refunded by the store owner' WHERE id = ?").run(orderId);
      if (credited.c > 0) this.store.debitRefund(order.address, credited.c, orderId, `refund: ${order.title}`);
    })();
    this.revokeDownloads(orderId);
    return this.getOrder(orderId)!;
  }

  async creatorCancelSubscription(orderId: string): Promise<Order> {
    const order = this.getOrder(orderId);
    if (!order || order.kind !== "subscription") throw new StoreError(`No subscription ${orderId}`, 404, "not_found");
    return this.cancelSubscription(order, true);
  }

  /** Periodic work: catch payments, refund overdue work, keep subscriptions current. */
  async pollOrders(now = Date.now()): Promise<{ paid: number; expired: number; refunded: number }> {
    if (!this.economy.stripeEnabled) return { paid: 0, expired: 0, refunded: 0 };
    let paid = 0;
    let expired = 0;
    let refunded = 0;
    // Stripe sessions last 24 hours; after that an unpaid one is dead.
    const cutoff = new Date(now - 25 * 3_600_000).toISOString();
    this.store.db.prepare("UPDATE orders SET status = 'expired' WHERE status = 'pending' AND created_at < ?").run(cutoff);
    const due = (this.store.db.prepare("SELECT * FROM orders WHERE status = 'pending' ORDER BY checked_at LIMIT 50").all() as any[]).map(mapOrder);
    for (const o of due) {
      try {
        const after = await this.refreshOrder(o);
        if (after.status !== "pending" && after.status !== "expired") paid++;
        if (after.status === "expired") expired++;
      } catch (err) {
        this.opts.log?.(`order ${o.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const overdue = (this.store.db.prepare("SELECT * FROM orders WHERE status = 'awaiting_delivery' AND due_at < ?").all(new Date(now).toISOString()) as any[]).map(mapOrder);
    for (const o of overdue) {
      try {
        await this.refundUndelivered(o, "not delivered by the deadline");
        refunded++;
      } catch (err) {
        this.opts.log?.(`refund of overdue order ${o.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const subs = (this.store.db.prepare("SELECT * FROM orders WHERE status = 'subscribed' ORDER BY checked_at LIMIT 50").all() as any[]).map(mapOrder);
    for (const o of subs) {
      await this.syncSubscription(o).catch((err) => this.opts.log?.(`subscription ${o.id}: ${err?.message || err}`));
    }
    return { paid, expired, refunded };
  }

  // ─── Promotion ───────────────────────────────────────────────

  private getPromotionRow(id: string): any {
    return this.store.db.prepare("SELECT * FROM promotions WHERE id = ?").get(id);
  }

  private mapPromotion(r: any): Promotion {
    const views = (this.store.db.prepare("SELECT COUNT(*) AS n FROM promo_hits WHERE promotion_id = ?").get(r.id) as { n: number }).n;
    const sales = (this.store.db.prepare("SELECT COUNT(*) AS n FROM orders WHERE via = ? AND status NOT IN ('pending','expired')").get(r.id) as { n: number }).n;
    const s = this.getStore(r.address);
    const target = r.listing_id ? `/p/${r.listing_id}` : s ? `/s/${s.slug}` : null;
    return {
      id: r.id,
      address: r.address,
      listingId: r.listing_id,
      platform: r.platform,
      text: r.text,
      status: r.status,
      link: this.sf.publicUrl && target ? `${this.base}${target}?via=${r.id}` : null,
      views,
      sales,
      createdAt: r.created_at,
    };
  }

  draftPromotion(addressRaw: string, input: { platform: unknown; text: unknown; listingId?: unknown }): Promotion {
    const address = normalizeAddress(addressRaw);
    this.assertCanSell(address);
    const platform = cleanLine(input.platform, 40, "platform");
    const text = cleanText(input.text, 2000, "text");
    let listingId: string | null = null;
    if (input.listingId !== undefined && input.listingId !== null && input.listingId !== "") {
      const l = this.getListing(String(input.listingId));
      if (!l || l.address !== address || l.removed) throw new StoreError(`No listing ${String(input.listingId)}`, 404, "not_found");
      listingId = l.id;
    } else if (!this.getStore(address)) {
      throw new StoreError("Open your store with a listing first");
    }
    const waiting = this.store.db.prepare("SELECT COUNT(*) AS n FROM promotions WHERE address = ? AND status = 'draft'").get(address) as { n: number };
    if (waiting.n >= this.sf.maxPromotionDrafts) {
      throw new StoreError(`You have ${waiting.n} drafts waiting for your creator; wait until some are posted or discarded`, 429, "too_many_drafts");
    }
    const id = ulid();
    const now = new Date().toISOString();
    this.store.db.prepare("INSERT INTO promotions (id, address, listing_id, platform, text, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'draft', ?, ?)").run(id, address, listingId, platform, text, now, now);
    return this.mapPromotion(this.getPromotionRow(id));
  }

  listPromotions(filter: { address?: string; status?: string } = {}): Promotion[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (filter.address) {
      where.push("address = ?");
      args.push(normalizeAddress(filter.address));
    }
    if (filter.status) {
      where.push("status = ?");
      args.push(filter.status);
    }
    const rows = this.store.db.prepare(`SELECT * FROM promotions ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT 200`).all(...args) as any[];
    return rows.map((r) => this.mapPromotion(r));
  }

  /** Creator only. */
  setPromotionStatus(id: string, status: "posted" | "discarded" | "draft"): Promotion {
    const r = this.getPromotionRow(id);
    if (!r) throw new StoreError(`No promotion ${id}`, 404, "not_found");
    this.store.db.prepare("UPDATE promotions SET status = ?, updated_at = ? WHERE id = ?").run(status, new Date().toISOString(), id);
    return this.mapPromotion(this.getPromotionRow(id));
  }

  /** One view per visitor per day per post. */
  recordVisit(via: string, visitor: string, address: string): void {
    if (!/^[0-9A-Z]{26}$/.test(via)) return;
    const p = this.getPromotionRow(via);
    if (!p || p.address !== address || p.status === "discarded") return;
    this.store.db.prepare("INSERT OR IGNORE INTO promo_hits (promotion_id, visitor, day) VALUES (?, ?, ?)").run(via, sha256(`${visitor}|${via}`).slice(0, 32), new Date().toISOString().slice(0, 10));
  }

  // ─── Agent-facing view ───────────────────────────────────────

  /** Written by `selftest` next to the store files; echoed at /.well-known/automaton-selftest. */
  selftestNonce(): string {
    const p = path.join(path.dirname(this.opts.filesDir), "selftest-nonce");
    try {
      const v = fs.readFileSync(p, "utf-8").trim();
      return /^[A-Za-z0-9_-]{16,64}$/.test(v) ? v : "";
    } catch {
      return "";
    }
  }

  agentStoreView(addressRaw: string) {
    const address = normalizeAddress(addressRaw);
    const s = this.getStore(address);
    const listings = this.listListings({ address }).map((l) => ({
      ...l,
      onSale: this.isOnSale(l),
      sales: this.salesOf(l.id),
      drops: l.kind === "subscription" ? this.listDrops(l.id).length : 0,
    }));
    return {
      store: s,
      url: s ? this.storeUrl(s.slug) : null,
      openForPurchases: this.missingForSales.length === 0,
      printProducts: this.printProducts().map((p) => ({ key: p.key, name: p.name, minPriceCents: this.printFloor(p), options: p.variants.map((v) => v.label) })),
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
.desc,.request{white-space:pre-wrap;overflow-wrap:anywhere}.request{border-left:3px solid var(--line);padding-left:12px}
a{color:var(--accent)}img.design{max-width:100%;height:auto;border:1px solid var(--line);border-radius:8px;background:#fff}
label{display:block;font-weight:600;margin:12px 0 4px}textarea,select{width:100%;font:inherit;font-size:16px;padding:10px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--fg)}
textarea{min-height:140px}
button,.button{display:inline-block;min-height:44px;margin-top:12px;padding:10px 20px;border-radius:8px;border:0;background:var(--accent);color:var(--bg);font:inherit;font-weight:600;cursor:pointer;text-decoration:none}
button.secondary{background:transparent;color:var(--accent);border:1px solid var(--line)}
ul.drops{list-style:none;padding:0}ul.drops li{border-top:1px solid var(--line);padding:12px 0}
`;

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function xmlEscape(s: string): string {
  return escapeHtml(s);
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

async function readForm(req: http.IncomingMessage, limit = 16 * 1024): Promise<URLSearchParams> {
  const type = String(req.headers["content-type"] || "");
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new StoreError("That request is too long.", 413, "too_large");
    chunks.push(c as Buffer);
  }
  if (!type.startsWith("application/x-www-form-urlencoded")) return new URLSearchParams();
  return new URLSearchParams(Buffer.concat(chunks).toString("utf-8"));
}

const KIND_LABEL: Record<ListingKind, string> = {
  file: "instant download",
  service: "made to order",
  subscription: "monthly subscription",
  print: "printed and shipped",
};

export function createStorefrontHandler(deps: StorefrontServerDeps): http.RequestListener {
  const sf = deps.storefront;
  const cfg = () => sf.config.storefront;
  const limiter = new RateLimiter(cfg().checkoutsPerIpPerMinute);
  const visitLimiter = new RateLimiter(120);
  const currency = () => sf.config.stripe.currency;
  const pub = () => cfg().publicUrl.replace(/\/$/, "");

  interface Meta {
    description?: string;
    canonical?: string;
    image?: string;
    jsonLd?: unknown;
    feed?: string;
  }

  const page = (title: string, body: string, meta: Meta = {}, status = 200) => {
    const head: string[] = [];
    const desc = meta.description ? escapeHtml(meta.description.replace(/\s+/g, " ").slice(0, 200)) : "";
    if (desc) head.push(`<meta name="description" content="${desc}">`);
    if (pub() && meta.canonical) {
      const url = escapeHtml(pub() + meta.canonical);
      head.push(`<link rel="canonical" href="${url}">`, `<meta property="og:url" content="${url}">`);
    }
    head.push(`<meta property="og:title" content="${escapeHtml(title)}">`, `<meta property="og:type" content="website">`, `<meta name="twitter:card" content="${meta.image ? "summary_large_image" : "summary"}">`);
    if (desc) head.push(`<meta property="og:description" content="${desc}">`);
    if (pub() && meta.image) head.push(`<meta property="og:image" content="${escapeHtml(pub() + meta.image)}">`);
    if (meta.feed) head.push(`<link rel="alternate" type="application/rss+xml" title="${escapeHtml(title)}" href="${escapeHtml(meta.feed)}">`);
    // Structured data for search engines. It is data, never run; "<" is escaped so it cannot end the block.
    if (meta.jsonLd) head.push(`<script type="application/ld+json">${JSON.stringify(meta.jsonLd).replace(/</g, "\\u003c")}</script>`);
    return {
      status,
      html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><title>${escapeHtml(title)}</title>${head.join("")}<link rel="stylesheet" href="/store.css"></head><body>${body}<footer>${footer()}</footer></body></html>`,
    };
  };
  const footer = () => {
    const c = cfg();
    const op = c.operatorName.trim() ? escapeHtml(c.operatorName.trim()) : "the operator";
    const mail = c.contactEmail.trim() ? ` Questions and refunds: <a href="mailto:${escapeHtml(c.contactEmail.trim())}">${escapeHtml(c.contactEmail.trim())}</a>.` : "";
    return `Items here are made and listed by autonomous AI agents run by ${op}. Payments are processed by Stripe; card details never reach this site.${mail}`;
  };
  const storeHeader = (s: StoreInfo) =>
    `<header><span class="badge">AI agent store</span><h1>${escapeHtml(s.slug)}</h1>${s.tagline ? `<p class="muted">${escapeHtml(s.tagline)}</p>` : ""}</header>`;
  const priceText = (l: Listing) => money(l.priceCents, currency()) + (l.kind === "subscription" ? " a month" : "");
  const facts = (l: Listing) => {
    if (l.kind === "file") return `${escapeHtml(l.filename)}, ${(l.fileBytes / 1024).toFixed(0)} KB, instant download`;
    if (l.kind === "service") return `made to order, delivered within ${l.deliveryHours} hours or your money back`;
    if (l.kind === "subscription") return `monthly subscription, cancel any time`;
    const product = sf.config.printful.products.find((p) => p.key === l.podProduct);
    return `${escapeHtml(product?.name ?? "print")}, printed and shipped to ${escapeHtml(sf.config.printful.shipCountries.join(", "))}`;
  };
  const designImg = (l: Listing) => (l.kind === "print" ? `<p><img class="design" alt="${escapeHtml(l.title)} design" src="/design/${l.fileSha256}.png"></p>` : "");

  const buyForm = (l: Listing, via: string | null) => {
    if (sf.missingForSales.length) return `<p class="muted">Purchases are not open yet.</p>`;
    const viaField = via ? `<input type="hidden" name="via" value="${escapeHtml(via)}">` : "";
    let fields = "";
    if (l.kind === "service") {
      fields = `<label for="request">${escapeHtml(l.requestPrompt || "What do you need?")}</label><textarea id="request" name="request" required maxlength="4000"></textarea>`;
    } else if (l.kind === "print") {
      const product = sf.config.printful.products.find((p) => p.key === l.podProduct)!;
      fields = `<label for="variant">Size or option</label><select id="variant" name="variant" required>${product.variants.map((v) => `<option value="${v.id}">${escapeHtml(v.label)}</option>`).join("")}</select>`;
    }
    const verb = l.kind === "subscription" ? `Subscribe for ${priceText(l)}` : `Buy for ${priceText(l)}`;
    return `<form method="post" action="/p/${l.id}/buy">${viaField}${fields}<button type="submit">${escapeHtml(verb)}</button></form>`;
  };

  const itemHtml = (l: Listing, full: boolean, via: string | null = null) =>
    `<section class="item"><h2>${full ? escapeHtml(l.title) : `<a href="/p/${l.id}">${escapeHtml(l.title)}</a>`}</h2>` +
    (full ? designImg(l) : "") +
    `<p class="price">${priceText(l)} <span class="muted">· ${facts(l)}</span></p>` +
    `<p class="desc">${escapeHtml(full ? l.description : l.description.slice(0, 280) + (l.description.length > 280 ? "…" : ""))}</p>` +
    (full ? buyForm(l, via) : "") +
    `</section>`;

  const productLd = (l: Listing) => ({
    "@context": "https://schema.org",
    "@type": "Product",
    name: l.title,
    description: l.description.slice(0, 500),
    ...(l.kind === "print" && pub() ? { image: `${pub()}/design/${l.fileSha256}.png` } : {}),
    offers: {
      "@type": "Offer",
      price: (l.priceCents / 100).toFixed(2),
      priceCurrency: currency().toUpperCase(),
      availability: "https://schema.org/InStock",
      ...(pub() ? { url: `${pub()}/p/${l.id}` } : {}),
    },
  });

  const rss = (title: string, link: string, items: Listing[]) => {
    const body = items
      .map(
        (l) =>
          `<item><title>${xmlEscape(l.title)}</title><link>${xmlEscape(`${pub()}/p/${l.id}`)}</link><guid isPermaLink="false">${l.id}</guid>` +
          `<pubDate>${new Date(l.createdAt).toUTCString()}</pubDate><description>${xmlEscape(`${priceText(l)}. ${l.description.slice(0, 500)}`)}</description></item>`,
      )
      .join("");
    return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${xmlEscape(title)}</title><link>${xmlEscape(link)}</link><description>${xmlEscape(`Made by AI agents run by ${cfg().operatorName || "the operator"}`)}</description>${body}</channel></rss>`;
  };

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
    const sendText = (type: string, text: string, cache = "public, max-age=600") => {
      res.writeHead(200, { "Content-Type": `${type}; charset=utf-8`, "Content-Length": Buffer.byteLength(text), "X-Content-Type-Options": "nosniff", "Cache-Control": cache });
      res.end(req.method === "HEAD" ? undefined : text);
    };
    const fail = (status: number, msg: string) => {
      const p = page("Not available", `<main><h1>${status === 404 ? "Not found" : "Not available"}</h1><p>${escapeHtml(msg)}</p></main>`, {}, status);
      send(p.status, p.html);
    };

    try {
      const url = new URL(req.url || "/", "http://store");
      const method = (req.method || "GET").toUpperCase();
      const read = method === "GET" || method === "HEAD";
      const via = url.searchParams.get("via");
      let m: RegExpExecArray | null;

      if (read && url.pathname === "/favicon.ico") {
        res.writeHead(204, { "Cache-Control": "public, max-age=86400" });
        return res.end();
      }
      if (read && url.pathname === "/store.css") return sendText("text/css", CSS, "public, max-age=3600");
      if (read && url.pathname === "/robots.txt") {
        return sendText("text/plain", `User-agent: *\nAllow: /\nDisallow: /order/\nDisallow: /d/\n${pub() ? `Sitemap: ${pub()}/sitemap.xml\n` : ""}`);
      }
      if (read && url.pathname === "/sitemap.xml") {
        const urls: string[] = [`${pub()}/`];
        for (const s of sf.listStores().filter((x) => sf.isStoreVisible(x))) {
          urls.push(`${pub()}/s/${s.slug}`);
          for (const l of sf.listListings({ address: s.address }).filter((x) => sf.isOnSale(x))) urls.push(`${pub()}/p/${l.id}`);
        }
        return sendText("application/xml", `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map((u) => `<url><loc>${xmlEscape(u)}</loc></url>`).join("")}</urlset>`);
      }
      if (read && url.pathname === "/feed.xml") {
        const items = sf.listListings().filter((l) => sf.isOnSale(l)).slice(0, 50);
        return sendText("application/rss+xml", rss(cfg().operatorName || "Agent stores", `${pub()}/`, items));
      }
      if (read && url.pathname === "/") {
        const stores = sf.listStores().filter((s) => sf.isStoreVisible(s));
        const body = `<header><span class="badge">AI agent stores</span><h1>${escapeHtml(cfg().operatorName.trim() || "Agent stores")}</h1></header><main>` +
          (stores.length ? stores.map((s) => `<section class="item"><h2><a href="/s/${escapeHtml(s.slug)}">${escapeHtml(s.slug)}</a></h2>${s.tagline ? `<p class="muted">${escapeHtml(s.tagline)}</p>` : ""}</section>`).join("") : "<p>No stores are open right now.</p>") +
          `<p class="muted"><a href="/feed.xml">New items (RSS)</a></p></main>`;
        const p = page(cfg().operatorName.trim() || "Agent stores", body, { canonical: "/", description: "Digital goods, made-to-order work, subscriptions and prints made by autonomous AI agents.", feed: "/feed.xml" });
        return send(p.status, p.html);
      }
      if (read && (m = /^\/s\/([a-z0-9-]{1,48})\/feed\.xml$/.exec(url.pathname))) {
        const s = sf.getStoreBySlug(m[1]!);
        if (!s || s.suspended || sf.store.isDead(s.address)) return fail(404, "There is no store here.");
        return sendText("application/rss+xml", rss(s.slug, `${pub()}/s/${s.slug}`, sf.listListings({ address: s.address }).filter((l) => sf.isOnSale(l))));
      }
      if (read && (m = /^\/s\/([a-z0-9-]{1,48})$/.exec(url.pathname))) {
        const s = sf.getStoreBySlug(m[1]!);
        if (!s || s.suspended || sf.store.isDead(s.address)) return fail(404, "There is no store here.");
        if (via && visitLimiter.allow(visitorIp(req))) sf.recordVisit(via, visitorIp(req), s.address);
        const items = sf.listListings({ address: s.address }).filter((l) => sf.isOnSale(l));
        const linkVia = (h: string) => (via && /^[0-9A-Z]{26}$/.test(via) ? h.replace(/href="\/p\/([0-9A-Z]{26})"/g, `href="/p/$1?via=${via}"`) : h);
        const p = page(s.slug, storeHeader(s) + `<main>${items.length ? linkVia(items.map((l) => itemHtml(l, false)).join("")) : "<p>Nothing for sale right now.</p>"}<p class="muted"><a href="/s/${escapeHtml(s.slug)}/feed.xml">New from this store (RSS)</a></p></main>`, {
          canonical: `/s/${s.slug}`,
          description: s.tagline || `Items made by the AI agent ${s.slug}.`,
          feed: `/s/${s.slug}/feed.xml`,
        });
        return send(p.status, p.html);
      }
      if (read && (m = /^\/p\/([0-9A-Z]{26})$/.exec(url.pathname))) {
        const l = sf.getListing(m[1]!);
        if (!l || !sf.isOnSale(l)) return fail(404, "This item is not for sale.");
        const s = sf.getStore(l.address)!;
        if (via && visitLimiter.allow(visitorIp(req))) sf.recordVisit(via, visitorIp(req), l.address);
        const okVia = via && /^[0-9A-Z]{26}$/.test(via) ? via : null;
        const p = page(l.title, storeHeader(s) + `<main>${itemHtml(l, true, okVia)}<p><a href="/s/${escapeHtml(s.slug)}">More from this store</a></p></main>`, {
          canonical: `/p/${l.id}`,
          description: l.description,
          image: l.kind === "print" ? `/design/${l.fileSha256}.png` : undefined,
          jsonLd: productLd(l),
        });
        return send(p.status, p.html);
      }
      if (read && (m = /^\/design\/([0-9a-f]{64})\.png$/.exec(url.pathname))) {
        const file = sf.designFile(m[1]!);
        if (!file) return fail(404, "Nothing here.");
        const bytes = fs.statSync(file).size;
        res.writeHead(200, {
          "Content-Type": "image/png",
          "Content-Length": bytes,
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "default-src 'none'; sandbox",
          "Cache-Control": "public, max-age=86400",
        });
        if (method === "HEAD") return res.end();
        fs.createReadStream(file).pipe(res);
        return;
      }
      if (method === "POST" && (m = /^\/p\/([0-9A-Z]{26})\/buy$/.exec(url.pathname))) {
        let form: URLSearchParams;
        try {
          form = await readForm(req);
        } catch (err) {
          if (err instanceof StoreError) return fail(err.status, err.message);
          throw err;
        }
        if (!limiter.allow(visitorIp(req))) return fail(429, "Too many purchases started from here. Wait a minute and try again.");
        try {
          const r = await sf.startCheckout(m[1]!, { request: form.get("request") ?? undefined, variantId: form.get("variant") ?? undefined, via: form.get("via") ?? undefined });
          res.writeHead(303, { Location: r.checkoutUrl, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
          return res.end();
        } catch (err) {
          if (err instanceof StoreError) return fail(err.status, err.message);
          deps.log?.(`storefront checkout: ${err instanceof Error ? err.message : String(err)}`);
          return fail(502, "Payment could not be started. Try again shortly.");
        }
      }
      if (method === "POST" && (m = /^\/order\/([0-9A-Z]{26})\/cancel$/.exec(url.pathname))) {
        let form: URLSearchParams;
        try {
          form = await readForm(req);
          await sf.buyerCancel(m[1]!, form.get("k") || "");
        } catch (err) {
          if (err instanceof StoreError) return fail(err.status, err.message);
          deps.log?.(`storefront cancel: ${err instanceof Error ? err.message : String(err)}`);
          return fail(502, "We could not reach the payment processor. Try again shortly.");
        }
        res.writeHead(303, { Location: `/order/${m[1]}?k=${encodeURIComponent(form.get("k") || "")}`, "Cache-Control": "no-store" });
        return res.end();
      }
      if (read && (m = /^\/order\/([0-9A-Z]{26})$/.exec(url.pathname))) {
        const key = url.searchParams.get("k") || "";
        let r: Awaited<ReturnType<Storefront["orderForBuyer"]>>;
        try {
          r = await sf.orderForBuyer(m[1]!, key);
        } catch (err) {
          if (err instanceof StoreError) return fail(err.status, err.message);
          deps.log?.(`storefront order: ${err instanceof Error ? err.message : String(err)}`);
          return fail(502, "We could not confirm this payment yet. Refresh this page in a minute.");
        }
        const o = r.order;
        const keep = `<p class="muted">Bookmark this page: it is how you get back to your order.</p>`;
        const when = (iso: string | null) => (iso ? new Date(iso).toUTCString().replace(/:\d\d GMT$/, " UTC") : "");
        let body: string;
        if (o.status === "pending") {
          body = `<main><h1>Waiting for payment</h1><p>Stripe has not confirmed your payment for <strong>${escapeHtml(o.title)}</strong> yet. Refresh this page in a minute.</p></main>`;
        } else if (o.status === "expired") {
          body = `<main><h1>Not paid</h1><p>This checkout was not completed. Nothing was charged.</p></main>`;
        } else if (o.status === "refunded") {
          body = `<main><h1>Refunded</h1><p>This order was refunded${o.note ? ` (${escapeHtml(o.note.replace(/^Refunded: /, ""))})` : ""}. The money goes back to your card.</p></main>`;
        } else if (o.status === "awaiting_delivery" || o.status === "refunding") {
          body = `<main><h1>Request received</h1><p>Your payment for <strong>${escapeHtml(o.title)}</strong> went through. The seller will deliver by <strong>${escapeHtml(when(o.dueAt))}</strong>. If it is not delivered by then, you are refunded automatically.</p>` +
            `<p>Your request:</p><p class="request">${escapeHtml(o.requestText || "")}</p>${keep}</main>`;
        } else if (o.status === "fulfilling") {
          body = `<main><h1>Thank you</h1><p>Your order for <strong>${escapeHtml(o.title)}</strong>${o.variantLabel ? ` (${escapeHtml(o.variantLabel)})` : ""} went to our print partner, who prints it and ships it to the address you gave. Shipping updates come from them by email.</p>${keep}</main>`;
        } else if (o.status === "subscribed" || o.status === "canceled") {
          const list = r.drops.length
            ? `<ul class="drops">${r.drops.map((d) => `<li><strong>${escapeHtml(d.title)}</strong> <span class="muted">· ${escapeHtml(d.filename)}, ${escapeHtml(when(d.createdAt))}</span><br>${d.token ? `<a class="button" href="/d/${d.token}">Download</a>` : `<span class="muted">Download limit reached</span>`}</li>`).join("")}</ul>`
            : `<p>Nothing has been published since you subscribed. New files appear here as soon as they are out.</p>`;
          const state = o.status === "canceled"
            ? `<p>This subscription has ended. Files published while it ran stay available here.</p>`
            : o.note
              ? `<p>${escapeHtml(o.note)}.</p>`
              : `<form method="post" action="/order/${o.id}/cancel"><input type="hidden" name="k" value="${escapeHtml(key)}"><button class="secondary" type="submit">Cancel subscription</button></form><p class="muted">Cancelling stops the next charge; you keep access until the end of the month you paid for.</p>`;
          body = `<main><h1>${escapeHtml(o.title)}</h1><p>${o.status === "subscribed" ? "Your subscription is active. It renews monthly." : ""}</p>${list}${state}${keep}</main>`;
        } else if (r.downloadToken) {
          const note = o.deliveryNote ? `<p>Note from the seller:</p><p class="request">${escapeHtml(o.deliveryNote)}</p>` : "";
          body = `<main><h1>${o.kind === "service" ? "Your order is ready" : "Thank you"}</h1><p>Your ${o.kind === "service" ? "order" : "payment"} for <strong>${escapeHtml(o.title)}</strong> ${o.kind === "service" ? "has been delivered" : "went through"}.</p>${note}` +
            `<p><a class="button" href="/d/${r.downloadToken}">Download ${escapeHtml(o.filename)}</a></p>` +
            `<p class="muted">This link works for ${cfg().downloadHours} hours. Bookmark this page, not the link: opening it again gives you a fresh link. Downloads used: ${sf.downloadsUsed(o.id)} of ${cfg().maxDownloads}.</p></main>`;
        } else {
          body = `<main><h1>Download limit reached</h1><p>This order has been downloaded ${cfg().maxDownloads} times. Contact the seller if you need it again.</p></main>`;
        }
        const p = page("Your order", body);
        return send(p.status, p.html);
      }
      if (read && (m = /^\/d\/([A-Za-z0-9_-]{20,64})$/.exec(url.pathname))) {
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
      // selftest: proves the public address reaches this storefront.
      if (read && url.pathname === "/.well-known/automaton-selftest") {
          return sendText("text/plain", sf.selftestNonce() || "no selftest running", "no-store");
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
