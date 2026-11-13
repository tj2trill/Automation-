/**
 * Host Control Plane — Printful client (print-on-demand)
 *
 * The creator's own Printful account prints and ships physical goods that
 * agents design. Only the host talks to Printful; the API token never
 * reaches an agent. Agents can choose only from products the creator listed
 * in host.json, at prices that cover the creator's cost plus a margin.
 *
 * Uses Printful's v1 REST API (https://developers.printful.com/docs/):
 *   POST /orders            create an order (draft, or confirmed with ?confirm=true)
 *   GET  /stores            check the token
 *   GET  /products/variant/{id}   check a variant exists
 * Responses are wrapped as { code, result } and errors as
 * { code, error: { message } } or { code, result: "message" }.
 * `selftest --printful` checks these against your real account.
 */

import { MICRO_PER_CENT } from "./store.js";
import type { FetchLike } from "./economy.js";

export interface PrintfulProduct {
  /** What agents pass to create_listing, e.g. "poster-18x24". */
  key: string;
  name: string;
  /** What the creator pays Printful per item including typical shipping, in cents. */
  baseCostCents: number;
  /** Sizes or colours the buyer chooses between. ids are Printful catalog variant ids. */
  variants: Array<{ id: number; label: string }>;
}

export interface PrintfulConfig {
  apiBase: string;
  /** Needed when the token is an account-level token with several stores. */
  storeId: string;
  /** false (default): orders arrive in Printful as drafts that you confirm. true: sent to print at once. */
  autoConfirm: boolean;
  /** Two-letter country codes Stripe collects shipping addresses for. */
  shipCountries: string[];
  /** Agents must price at least this far above baseCostCents. */
  minMarginCents: number;
  /** Smallest design accepted, in pixels on each side. */
  minDesignPx: number;
  products: PrintfulProduct[];
}

export class PrintfulError extends Error {
  constructor(message: string, public readonly status = 502) {
    super(message);
    this.name = "PrintfulError";
  }
}

export interface PrintfulRecipient {
  name: string;
  address1: string;
  address2?: string;
  city: string;
  state_code?: string;
  country_code: string;
  zip: string;
  email?: string;
}

export class PrintfulClient {
  constructor(
    private readonly cfg: PrintfulConfig,
    private readonly token: string,
    private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init) as any,
  ) {}

  private async call(method: "GET" | "POST", path: string, body?: unknown): Promise<any> {
    const base = new URL(this.cfg.apiBase);
    const loopback = base.hostname === "127.0.0.1" || base.hostname === "localhost";
    if (base.protocol !== "https:" && !loopback) throw new PrintfulError("printful.apiBase must be https", 500);
    const headers: Record<string, string> = { Authorization: `Bearer ${this.token}` };
    if (this.cfg.storeId) headers["X-PF-Store-Id"] = this.cfg.storeId;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await this.fetchImpl(new URL(path, base).toString(), { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || (typeof json?.code === "number" && json.code >= 400)) {
      const msg = json?.error?.message || (typeof json?.result === "string" ? json.result : "") || `HTTP ${res.status}`;
      throw new PrintfulError(`Printful refused the request: ${String(msg).slice(0, 300)}`);
    }
    return json?.result;
  }

  /**
   * Place an order for one item. Returns Printful's order id, its status,
   * and what it will cost the creator, in micro-dollars.
   */
  async createOrder(input: { externalId: string; recipient: PrintfulRecipient; variantId: number; fileUrl: string }): Promise<{ id: string; status: string; costMicro: number }> {
    const q = this.cfg.autoConfirm ? "?confirm=true" : "";
    const result = await this.call("POST", `/orders${q}`, {
      // Printful limits external_id to 32 characters; a ulid is 26.
      external_id: input.externalId,
      recipient: input.recipient,
      items: [{ variant_id: input.variantId, quantity: 1, files: [{ url: input.fileUrl }] }],
    });
    const total = Number(result?.costs?.total);
    if (!result?.id) throw new PrintfulError("Printful did not return an order id");
    return {
      id: String(result.id),
      status: String(result.status ?? "unknown"),
      // Unknown cost is treated as the configured base cost by the caller.
      costMicro: Number.isFinite(total) ? Math.round(total * 100 * MICRO_PER_CENT) : NaN,
    };
  }

  async verifyToken(): Promise<string> {
    const result = await this.call("GET", "/stores");
    const stores = Array.isArray(result) ? result : [];
    return stores.length ? stores.map((s: any) => `${s.name ?? "store"} (${s.id})`).join(", ") : "token accepted";
  }

  async variant(id: number): Promise<string> {
    const result = await this.call("GET", `/products/variant/${encodeURIComponent(String(id))}`);
    return String(result?.variant?.name ?? result?.product?.title ?? `variant ${id}`);
  }
}

/** Width and height from a PNG's header, or null if it is not a PNG. */
export function pngSize(bytes: Buffer): { width: number; height: number } | null {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || !sig.every((b, i) => bytes[i] === b)) return null;
  if (bytes.toString("latin1", 12, 16) !== "IHDR") return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/** Stripe's shipping details have moved between API versions; accept both shapes. */
export function recipientFromSession(session: any): PrintfulRecipient | null {
  const ship = session?.shipping_details ?? session?.collected_information?.shipping_details ?? session?.shipping;
  const addr = ship?.address;
  if (!addr?.line1 || !addr?.city || !addr?.country || !addr?.postal_code) return null;
  return {
    name: String(ship.name || session?.customer_details?.name || "Customer").slice(0, 100),
    address1: String(addr.line1),
    ...(addr.line2 ? { address2: String(addr.line2) } : {}),
    city: String(addr.city),
    ...(addr.state ? { state_code: String(addr.state) } : {}),
    country_code: String(addr.country),
    zip: String(addr.postal_code),
    ...(session?.customer_details?.email ? { email: String(session.customer_details.email) } : {}),
  };
}
