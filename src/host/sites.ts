/**
 * Host Control Plane — Client websites
 *
 * An agent builds a website for a client (a business it emailed, say),
 * shows them a preview link, and sends them a monthly hosting checkout. Once
 * the client pays, the site is live at <sites.publicUrl>/<slug>/ for as long
 * as the Stripe subscription runs; the agent is credited each paid month.
 *
 * Client sites can contain scripts, so they are served by a separate server
 * on a separate public hostname from the store: nothing a client site runs
 * can reach store pages, and the store never runs agent code. The creator
 * can take any site down.
 */

import { createHash, randomBytes } from "crypto";
import fs from "fs";
import http from "http";
import path from "path";
import type { HostConfig } from "./config.js";
import type { Economy } from "./economy.js";
import { AccountDeadError, normalizeAddress, type HostStore } from "./store.js";

export class SiteError extends Error {
  constructor(message: string, public readonly status = 400, public readonly code = "invalid_request") {
    super(message);
    this.name = "SiteError";
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sites (
  slug                TEXT PRIMARY KEY,
  address             TEXT NOT NULL,
  title               TEXT NOT NULL,
  status              TEXT NOT NULL,
  preview_hash        TEXT NOT NULL,
  preview_token       TEXT NOT NULL,
  price_cents         INTEGER,
  client_email        TEXT,
  session_id          TEXT,
  stripe_subscription TEXT,
  pulled              INTEGER NOT NULL DEFAULT 0,
  bytes               INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  live_since          TEXT,
  checked_at          TEXT
);
CREATE TABLE IF NOT EXISTS site_files (
  slug   TEXT NOT NULL,
  path   TEXT NOT NULL,
  sha    TEXT NOT NULL,
  bytes  INTEGER NOT NULL,
  PRIMARY KEY (slug, path)
);
CREATE TABLE IF NOT EXISTS site_invoices (
  invoice_id  TEXT PRIMARY KEY,
  slug        TEXT NOT NULL,
  net_micro   INTEGER NOT NULL,
  at          TEXT NOT NULL
);
`;

export type SiteStatus = "draft" | "awaiting_payment" | "live" | "ended";

export interface Site {
  slug: string;
  address: string;
  title: string;
  status: SiteStatus;
  priceCents: number | null;
  clientEmail: string | null;
  pulled: boolean;
  bytes: number;
  files: number;
  createdAt: string;
  liveSince: string | null;
  previewUrl: string | null;
  liveUrl: string | null;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".pdf": "application/pdf",
  ".webmanifest": "application/manifest+json",
};

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;
const RESERVED = new Set(["preview", "api", "admin", "www", "static", "assets", "health", "favicon.ico", "robots.txt"]);

/** A safe relative path inside a site, or an error. */
export function sitePath(p: unknown): string {
  const raw = typeof p === "string" ? p.replace(/\\/g, "/").replace(/^\/+/, "") : "";
  const parts = raw.split("/").filter((x) => x !== "" && x !== ".");
  if (!parts.length || parts.some((x) => x === ".." || x.startsWith(".") || !/^[A-Za-z0-9._-]{1,100}$/.test(x))) {
    throw new SiteError(`Bad file path: ${String(p).slice(0, 80)}`);
  }
  const joined = parts.join("/");
  if (joined.length > 200) throw new SiteError("File paths may be at most 200 characters");
  if (!TYPES[path.extname(joined).toLowerCase()]) throw new SiteError(`Files of type ${path.extname(joined) || "(none)"} are not served: ${joined}`);
  return joined;
}

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

export class Sites {
  constructor(
    readonly config: HostConfig,
    readonly store: HostStore,
    readonly economy: Economy,
    private readonly opts: { filesDir: string; log?: (m: string) => void },
  ) {
    this.store.db.exec(SCHEMA);
    fs.mkdirSync(opts.filesDir, { recursive: true, mode: 0o700 });
  }

  get base(): string {
    return this.config.sites.publicUrl.replace(/\/$/, "");
  }

  get enabled(): boolean {
    return Boolean(this.config.sites.publicUrl);
  }

  private row(slug: string): any {
    return this.store.db.prepare("SELECT * FROM sites WHERE slug = ?").get(slug);
  }

  private map(r: any): Site {
    const files = (this.store.db.prepare("SELECT COUNT(*) AS n FROM site_files WHERE slug = ?").get(r.slug) as { n: number }).n;
    return {
      slug: r.slug,
      address: r.address,
      title: r.title,
      status: r.status,
      priceCents: r.price_cents,
      clientEmail: r.client_email,
      pulled: r.pulled === 1,
      bytes: r.bytes,
      files,
      createdAt: r.created_at,
      liveSince: r.live_since,
      previewUrl: this.enabled ? `${this.base}/preview/${r.preview_token}/` : null,
      liveUrl: this.enabled ? `${this.base}/${r.slug}/` : null,
    };
  }

  getSite(slug: string): Site | null {
    const r = this.row(slug);
    return r ? this.map(r) : null;
  }

  listSites(addressRaw?: string): Site[] {
    const rows = addressRaw
      ? this.store.db.prepare("SELECT * FROM sites WHERE address = ? ORDER BY created_at DESC").all(normalizeAddress(addressRaw))
      : this.store.db.prepare("SELECT * FROM sites ORDER BY created_at DESC").all();
    return (rows as any[]).map((r) => this.map(r));
  }

  private assertAgent(address: string): void {
    if (!this.enabled) throw new SiteError("Website hosting is not set up on this host (sites.publicUrl)", 503, "sites_disabled");
    if (this.store.isDead(address)) throw new SiteError("This account is dead", 403, "account_dead");
    if (this.store.isFrozen(address)) throw new SiteError("Account is frozen by the creator", 403, "account_frozen");
  }

  /** Create a site or replace all of its files. */
  publish(addressRaw: string, input: { slug: unknown; title: unknown; files: unknown }): Site {
    const address = normalizeAddress(addressRaw);
    this.assertAgent(address);
    const slug = typeof input.slug === "string" ? input.slug.trim().toLowerCase() : "";
    if (!SLUG_RE.test(slug) || RESERVED.has(slug)) throw new SiteError("slug must be 3 to 40 lowercase letters, digits and dashes, e.g. joes-plumbing");
    const title = typeof input.title === "string" ? input.title.replace(/\s+/g, " ").trim() : "";
    if (!title || title.length > 100) throw new SiteError("title must be 1 to 100 characters");
    if (!Array.isArray(input.files) || input.files.length === 0) throw new SiteError("files must be a list of { path, content_base64 }");
    if (input.files.length > this.config.sites.maxFiles) throw new SiteError(`A site may have at most ${this.config.sites.maxFiles} files`);
    const files = new Map<string, Buffer>();
    let total = 0;
    for (const f of input.files as any[]) {
      const p = sitePath(f?.path);
      if (typeof f?.content_base64 !== "string" || !/^[A-Za-z0-9+/=\s]*$/.test(f.content_base64)) throw new SiteError(`${p}: content_base64 must be base64`);
      const b = Buffer.from(f.content_base64, "base64");
      total += b.length;
      files.set(p, b);
    }
    if (!files.has("index.html")) throw new SiteError("A site needs an index.html at its top level");
    if (total > this.config.sites.maxSiteMb * 1024 * 1024) throw new SiteError(`A site may be at most ${this.config.sites.maxSiteMb} MB`, 413, "too_large");

    const existing = this.row(slug);
    if (existing && existing.address !== address) throw new SiteError(`The name ${slug} is taken`, 409, "taken");
    if (!existing) {
      const n = (this.store.db.prepare("SELECT COUNT(*) AS n FROM sites WHERE address = ? AND status != 'ended'").get(address) as { n: number }).n;
      if (n >= this.config.sites.maxSitesPerAgent) throw new SiteError(`At most ${this.config.sites.maxSitesPerAgent} sites per agent`, 429, "too_many_sites");
    }
    for (const [, b] of files) {
      const h = sha(b);
      const target = path.join(this.opts.filesDir, h);
      if (!fs.existsSync(target)) fs.writeFileSync(target, b, { mode: 0o600 });
    }
    const now = new Date().toISOString();
    this.store.db.transaction(() => {
      if (!existing) {
        const token = randomBytes(18).toString("base64url");
        this.store.db
          .prepare("INSERT INTO sites (slug, address, title, status, preview_hash, preview_token, bytes, created_at, updated_at) VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?)")
          .run(slug, address, title, sha(token), token, total, now, now);
      } else {
        this.store.db.prepare("UPDATE sites SET title = ?, bytes = ?, updated_at = ? WHERE slug = ?").run(title, total, now, slug);
      }
      this.store.db.prepare("DELETE FROM site_files WHERE slug = ?").run(slug);
      const ins = this.store.db.prepare("INSERT INTO site_files (slug, path, sha, bytes) VALUES (?, ?, ?, ?)");
      for (const [p, b] of files) ins.run(slug, p, sha(b), b.length);
    })();
    return this.getSite(slug)!;
  }

  /** A monthly hosting checkout for the client. The site goes live once they pay. */
  async offerHosting(addressRaw: string, input: { slug: unknown; monthlyCents: unknown; clientEmail?: unknown }): Promise<{ checkoutUrl: string; site: Site }> {
    const address = normalizeAddress(addressRaw);
    this.assertAgent(address);
    const slug = String(input.slug ?? "");
    const r = this.row(slug);
    if (!r || r.address !== address) throw new SiteError(`No site ${slug}`, 404, "not_found");
    if (r.status === "live") throw new SiteError("This site is already live and paid for", 409, "conflict");
    const cents = Number(input.monthlyCents);
    const { minAmountCents, maxAmountCents } = this.config.stripe;
    if (!Number.isInteger(cents) || cents < minAmountCents || cents > maxAmountCents) throw new SiteError(`monthly_price_cents must be a whole number from ${minAmountCents} to ${maxAmountCents}`);
    const clientEmail = typeof input.clientEmail === "string" && input.clientEmail.trim() ? input.clientEmail.trim().toLowerCase() : null;
    if (clientEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clientEmail)) throw new SiteError("client_email is not an email address");
    if (!this.economy.stripeEnabled) throw new SiteError("Payments are not set up on this host", 503, "stripe_disabled");
    const fields: Record<string, string | number> = {
      mode: "subscription",
      success_url: `${this.base}/${slug}/`,
      cancel_url: `${this.base}/preview/${r.preview_token}/`,
      client_reference_id: `site:${slug}`,
      "line_items[0][quantity]": 1,
      "line_items[0][price_data][currency]": this.config.stripe.currency,
      "line_items[0][price_data][unit_amount]": cents,
      "line_items[0][price_data][recurring][interval]": "month",
      "line_items[0][price_data][product_data][name]": `Website hosting: ${r.title}`.slice(0, 200),
      "metadata[automaton_address]": address,
      "metadata[automaton_site]": slug,
    };
    if (clientEmail) fields.customer_email = clientEmail;
    const session = await this.economy.stripeRequest("POST", "/v1/checkout/sessions", fields);
    if (typeof session?.id !== "string" || typeof session?.url !== "string") throw new SiteError("Payment could not be started", 502, "stripe_error");
    this.store.db.prepare("UPDATE sites SET status = 'awaiting_payment', price_cents = ?, client_email = ?, session_id = ?, updated_at = ? WHERE slug = ?").run(cents, clientEmail, session.id, new Date().toISOString(), slug);
    return { checkoutUrl: session.url, site: this.getSite(slug)! };
  }

  /** Creator only. A pulled site is offline whatever its payment status. */
  setPulled(slug: string, pulled: boolean): Site {
    if (!this.row(slug)) throw new SiteError(`No site ${slug}`, 404, "not_found");
    this.store.db.prepare("UPDATE sites SET pulled = ? WHERE slug = ?").run(pulled ? 1 : 0, slug);
    return this.getSite(slug)!;
  }

  /** Activate paid sites, credit monthly invoices, and end sites whose subscription ended. */
  async poll(): Promise<{ activated: number; ended: number }> {
    let activated = 0;
    let ended = 0;
    if (!this.economy.stripeEnabled) return { activated, ended };
    const waiting = this.store.db.prepare("SELECT * FROM sites WHERE status = 'awaiting_payment' AND session_id IS NOT NULL ORDER BY checked_at LIMIT 50").all() as any[];
    for (const r of waiting) {
      try {
        const s = await this.economy.stripeRequest("GET", `/v1/checkout/sessions/${encodeURIComponent(r.session_id)}`);
        this.store.db.prepare("UPDATE sites SET checked_at = ? WHERE slug = ?").run(new Date().toISOString(), r.slug);
        if (s?.status === "complete" || s?.payment_status === "paid") {
          const sub = typeof s.subscription === "string" ? s.subscription : s.subscription?.id;
          this.store.db.prepare("UPDATE sites SET status = 'live', stripe_subscription = ?, live_since = ? WHERE slug = ? AND status = 'awaiting_payment'").run(sub ?? null, new Date().toISOString(), r.slug);
          activated++;
        } else if (s?.status === "expired") {
          this.store.db.prepare("UPDATE sites SET status = 'draft', session_id = NULL WHERE slug = ?").run(r.slug);
        }
      } catch (err) {
        this.opts.log?.(`site ${r.slug}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const live = this.store.db.prepare("SELECT * FROM sites WHERE status = 'live' AND stripe_subscription IS NOT NULL ORDER BY checked_at LIMIT 50").all() as any[];
    for (const r of live) {
      try {
        this.store.db.prepare("UPDATE sites SET checked_at = ? WHERE slug = ?").run(new Date().toISOString(), r.slug);
        const list = await this.economy.stripeRequest("GET", `/v1/invoices?subscription=${encodeURIComponent(r.stripe_subscription)}&status=paid&limit=100`);
        for (const inv of Array.isArray(list?.data) ? list.data : []) {
          if (typeof inv?.id !== "string" || !(inv.amount_paid > 0)) continue;
          if (this.store.db.prepare("SELECT 1 FROM site_invoices WHERE invoice_id = ?").get(inv.id)) continue;
          const net = this.economy.netOfFees(Math.floor(inv.amount_paid));
          this.store.db.transaction(() => {
            this.store.db.prepare("INSERT INTO site_invoices (invoice_id, slug, net_micro, at) VALUES (?, ?, ?, ?)").run(inv.id, r.slug, net, new Date().toISOString());
            try {
              if (net > 0) this.store.credit(r.address, net, "sale", inv.id, `website hosting: ${r.title}`);
            } catch (err) {
              if (!(err instanceof AccountDeadError)) throw err;
            }
          })();
        }
        const sub = await this.economy.stripeRequest("GET", `/v1/subscriptions/${encodeURIComponent(r.stripe_subscription)}`);
        if (["canceled", "unpaid", "incomplete_expired"].includes(sub?.status)) {
          this.store.db.prepare("UPDATE sites SET status = 'ended' WHERE slug = ?").run(r.slug);
          ended++;
        }
      } catch (err) {
        this.opts.log?.(`site ${r.slug}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { activated, ended };
  }

  /** A dead agent's clients keep their sites to the end of the month they paid for, then the sites end. */
  async closeAgent(addressRaw: string): Promise<void> {
    const rows = this.store.db.prepare("SELECT * FROM sites WHERE address = ? AND status = 'live' AND stripe_subscription IS NOT NULL").all(normalizeAddress(addressRaw)) as any[];
    for (const r of rows) {
      await this.economy
        .stripeRequest("POST", `/v1/subscriptions/${encodeURIComponent(r.stripe_subscription)}`, { cancel_at_period_end: "true" })
        .catch((err) => this.opts.log?.(`site ${r.slug}: ${err?.message || err}`));
    }
    this.store.db.prepare("UPDATE sites SET status = 'ended' WHERE address = ? AND status IN ('draft','awaiting_payment')").run(normalizeAddress(addressRaw));
  }

  /** The file to serve for a request path, or null. */
  resolve(urlPath: string): { file: string; type: string } | null {
    let m = /^\/preview\/([A-Za-z0-9_-]{20,40})(\/.*)?$/.exec(urlPath);
    let r: any;
    let rest: string;
    if (m) {
      r = this.store.db.prepare("SELECT * FROM sites WHERE preview_hash = ?").get(sha(m[1]!));
      if (!r || r.pulled || r.status === "ended") return null;
      rest = m[2] ?? "/";
    } else {
      m = /^\/([a-z0-9-]{3,40})(\/.*)?$/.exec(urlPath);
      if (!m) return null;
      r = this.row(m[1]!);
      if (!r || r.pulled || r.status !== "live") return null;
      rest = m[2] ?? "/";
    }
    let rel = decodeURIComponent(rest).replace(/^\/+/, "");
    if (rel === "" || rel.endsWith("/")) rel += "index.html";
    let p: string;
    try {
      p = sitePath(rel);
    } catch {
      return null;
    }
    const f = this.store.db.prepare("SELECT sha FROM site_files WHERE slug = ? AND path = ?").get(r.slug, p) as { sha: string } | undefined;
    if (!f) return null;
    return { file: path.join(this.opts.filesDir, f.sha), type: TYPES[path.extname(p).toLowerCase()]! };
  }
}

/** Client sites. Loopback only; give it its own Cloudflare Tunnel hostname. */
export async function startSitesServer(sites: Sites, log?: (m: string) => void): Promise<{ port: number; close(): Promise<void> }> {
  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url || "/", "http://sites");
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { Allow: "GET, HEAD" });
        return res.end();
      }
      // A bare slug: send the browser to the folder so relative links work.
      if (/^\/[a-z0-9-]{3,40}$/.test(url.pathname) || /^\/preview\/[A-Za-z0-9_-]{20,40}$/.test(url.pathname)) {
        res.writeHead(301, { Location: `${url.pathname}/` });
        return res.end();
      }
      const hit = sites.resolve(url.pathname);
      if (!hit || !fs.existsSync(hit.file)) {
        const body = "<!doctype html><meta charset=utf-8><title>Not found</title><p>This site is not active.</p>";
        res.writeHead(404, { "Content-Type": "text/html; charset=utf-8", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" });
        return res.end(body);
      }
      const preview = url.pathname.startsWith("/preview/");
      res.writeHead(200, {
        "Content-Type": hit.type,
        "Content-Length": fs.statSync(hit.file).size,
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "strict-origin-when-cross-origin",
        // Previews are private links: keep them out of search engines.
        ...(preview ? { "X-Robots-Tag": "noindex, nofollow", "Cache-Control": "no-store" } : { "Cache-Control": "public, max-age=300" }),
      });
      if (req.method === "HEAD") return res.end();
      fs.createReadStream(hit.file).pipe(res);
    } catch (err) {
      log?.(`sites error: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(sites.config.sites.port, "127.0.0.1", () => resolve());
  });
  return { port: (server.address() as { port: number }).port, close: () => new Promise<void>((r) => server.close(() => r())) };
}
