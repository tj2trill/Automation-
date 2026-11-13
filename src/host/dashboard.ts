/**
 * Host Control Plane — Creator dashboard server
 *
 * Serves the dashboard page and the admin API behind it. This is the only
 * HTTP surface that can add money or stop agents, so it is locked down in
 * layers, each closing a different route in:
 *
 *  - Bound to 127.0.0.1 by default: agent containers reach the host through
 *    the Docker gateway address, never loopback, so they cannot connect at
 *    all. If the creator opens it to a phone (`automaton-host phone`), any
 *    connection whose source is on the agent network is refused instead.
 *  - Host header must be a loopback name: stops DNS rebinding, where a web
 *    page an agent publishes resolves its own domain to 127.0.0.1.
 *  - Admin token in a custom header: a web page in the creator's browser can
 *    send requests to loopback, but cannot read the token or set this header
 *    cross-origin, so it cannot forge a "fund" or "remove".
 *  - Strict CSP and text-only rendering in the page: agent names, log lines
 *    and messages are agent-controlled text and must never run as script.
 */

import { randomBytes, timingSafeEqual } from "crypto";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { AdminError, type HostAdmin } from "./admin.js";
import { getHostDir } from "./config.js";

const ASSET_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "dashboard");
const ASSETS: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.css": { file: "app.css", type: "text/css; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/manifest.webmanifest": { file: "manifest.webmanifest", type: "application/manifest+json" },
  "/icon-180.png": { file: "icon-180.png", type: "image/png" },
  "/icon-192.png": { file: "icon-192.png", type: "image/png" },
  "/icon-512.png": { file: "icon-512.png", type: "image/png" },
  "/apple-touch-icon.png": { file: "icon-180.png", type: "image/png" },
};
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const MAX_BODY = 256 * 1024;

export function loadOrCreateDashboardToken(): string {
  const p = path.join(getHostDir(), "dashboard-token");
  if (fs.existsSync(p)) {
    const t = fs.readFileSync(p, "utf-8").trim();
    if (t.length >= 32) return t;
  }
  fs.mkdirSync(getHostDir(), { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString("hex");
  fs.writeFileSync(p, token, { mode: 0o600 });
  return token;
}

/** The token rides in the URL fragment, which browsers never send to a server or in a Referer. */
export function dashboardUrl(port: number, token: string): string {
  return `http://127.0.0.1:${port}/#token=${token}`;
}

/** Link for another device (a phone) that reaches this machine at `host`. */
export function phoneDashboardUrl(host: string, port: number, token: string): string {
  return `http://${host}:${port}/#token=${token}`;
}

function ipv4ToInt(ip: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((n) => n > 255)) return null;
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

/** True if `ip` (IPv4, optionally IPv4-mapped IPv6) lies inside `cidr`. */
export function ipInCidr(ip: string | undefined, cidr: string): boolean {
  if (!ip) return false;
  const addr = ipv4ToInt(ip.replace(/^::ffff:/i, ""));
  const [base, bitsRaw] = cidr.split("/");
  const baseInt = ipv4ToInt(base || "");
  const bits = Number(bitsRaw);
  if (addr === null || baseInt === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (addr & mask) === (baseInt & mask);
}

export interface PhoneAddress {
  address: string;
  iface: string;
  /** "vpn": Tailscale/CGNAT range, encrypted between devices. "lan": home network, plain HTTP. */
  kind: "vpn" | "lan";
}

/**
 * Private addresses of this machine a phone could reach: VPN (100.64.0.0/10,
 * which Tailscale uses) first, then home-network ranges. Public addresses and
 * the agent network are never offered.
 */
export function listPhoneAddresses(
  dockerSubnet: string,
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(),
): PhoneAddress[] {
  const found: PhoneAddress[] = [];
  for (const [iface, infos] of Object.entries(interfaces)) {
    for (const info of infos || []) {
      if (info.internal || info.family !== "IPv4") continue;
      // Container bridges are private ranges too, but no phone lives on them.
      if (/^(docker|br-|veth|virbr|cni|podman)/.test(iface)) continue;
      if (ipInCidr(info.address, dockerSubnet) || ipInCidr(info.address, "172.17.0.0/16")) continue;
      if (ipInCidr(info.address, "100.64.0.0/10")) found.push({ address: info.address, iface, kind: "vpn" });
      else if (["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"].some((c) => ipInCidr(info.address, c)))
        found.push({ address: info.address, iface, kind: "lan" });
    }
  }
  return found.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "vpn" ? -1 : 1));
}

function tokenMatches(given: unknown, expected: string): boolean {
  if (typeof given !== "string") return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Accept a request only if its Host header names this server: a loopback
 * name, or a name the creator listed (their private VPN hostname, used to
 * open the dashboard from a phone). Anything else is a DNS-rebinding attempt.
 */
export function isAllowedHost(hostHeader: string | undefined, port: number, extraHosts: string[] = []): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.toLowerCase();
  if ([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(host)) return true;
  return extraHosts.some((h) => {
    const allowed = h.trim().toLowerCase();
    // A listed name matches with or without a port (a TLS proxy forwards the bare name).
    return allowed !== "" && (host === allowed || host === `${allowed}:${port}`);
  });
}

function readJson(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new AdminError("Request body too large", 413));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new AdminError("Request body is not valid JSON"));
      }
    });
    req.on("error", reject);
  });
}

export interface DashboardDeps {
  admin: HostAdmin;
  token: string;
  port: number;
  /** Extra Host names to accept, e.g. a Tailscale name. Loopback names always work. */
  allowedHosts?: string[];
  /** Extra addresses to listen on besides 127.0.0.1 (a private VPN address). */
  bindAddresses?: string[];
  /** The agent network. Connections from it are refused whatever address they arrive on. */
  agentSubnet?: string;
  log?: (msg: string) => void;
}

type ApiHandler = (admin: HostAdmin, params: string[], query: URLSearchParams, body: any) => Promise<unknown> | unknown;

const api: Array<{ method: string; pattern: RegExp; handler: ApiHandler }> = [
  { method: "GET", pattern: /^\/api\/overview$/, handler: (a) => a.overview() },
  {
    method: "GET",
    pattern: /^\/api\/ledger$/,
    handler: (a, _p, q) => ({ entries: a.ledger(q.get("agent") || undefined, Number(q.get("limit")) || 60) }),
  },
  {
    method: "GET",
    pattern: /^\/api\/logs$/,
    handler: async (a, _p, q) => ({ text: await a.logs(q.get("agent") || "", Number(q.get("lines")) || 120) }),
  },
  {
    method: "POST",
    pattern: /^\/api\/launch$/,
    handler: (a, _p, _q, b) =>
      a.launch({
        name: String(b?.name ?? ""),
        genesisPrompt: String(b?.genesisPrompt ?? ""),
        creatorMessage: b?.creatorMessage ? String(b.creatorMessage) : undefined,
        fundUsd: b?.fundUsd === undefined || b?.fundUsd === "" ? undefined : Number(b.fundUsd),
        memoryMb: b?.memoryMb ? Number(b.memoryMb) : undefined,
      }),
  },
  { method: "POST", pattern: /^\/api\/agents\/(0x[a-fA-F0-9]{40})\/fund$/, handler: (a, [addr], _q, b) => a.fund(addr!, b?.usd) },
  { method: "POST", pattern: /^\/api\/agents\/(0x[a-fA-F0-9]{40})\/freeze$/, handler: (a, [addr]) => a.setFrozen(addr!, true) },
  { method: "POST", pattern: /^\/api\/agents\/(0x[a-fA-F0-9]{40})\/unfreeze$/, handler: (a, [addr]) => a.setFrozen(addr!, false) },
  { method: "POST", pattern: /^\/api\/agents\/(0x[a-fA-F0-9]{40})\/stop$/, handler: (a, [addr]) => a.kill(addr!) },
  { method: "POST", pattern: /^\/api\/agents\/(0x[a-fA-F0-9]{40})\/start$/, handler: (a, [addr]) => a.start(addr!) },
  { method: "POST", pattern: /^\/api\/agents\/(0x[a-fA-F0-9]{40})\/remove$/, handler: (a, [addr]) => a.remove(addr!) },
  { method: "POST", pattern: /^\/api\/agents\/(0x[a-fA-F0-9]{40})\/message$/, handler: (a, [addr], _q, b) => a.send(addr!, b?.content) },
  { method: "POST", pattern: /^\/api\/sandboxes\/([0-9A-Z]{26})\/remove$/, handler: (a, [id]) => a.removeSandbox(id!) },
  { method: "GET", pattern: /^\/api\/jobs$/, handler: (a) => ({ jobs: a.jobs() }) },
  { method: "POST", pattern: /^\/api\/jobs$/, handler: (a, _p, _q, b) => a.postJob(b) },
  { method: "POST", pattern: /^\/api\/jobs\/([0-9A-Z]{26})\/cancel$/, handler: (a, [id]) => a.cancelJob(id!) },
  { method: "GET", pattern: /^\/api\/payments$/, handler: (a) => ({ payments: a.payments(), stripeEnabled: a.economy.stripeEnabled }) },
  { method: "POST", pattern: /^\/api\/payments\/check$/, handler: (a) => a.checkPayments() },
  { method: "GET", pattern: /^\/api\/stores$/, handler: (a) => a.stores() },
  { method: "POST", pattern: /^\/api\/listings\/([0-9A-Z]{26})\/pull$/, handler: (a, [id]) => a.pullListing(id!, true) },
  { method: "POST", pattern: /^\/api\/listings\/([0-9A-Z]{26})\/restore$/, handler: (a, [id]) => a.pullListing(id!, false) },
  { method: "POST", pattern: /^\/api\/stores\/(0x[a-fA-F0-9]{40})\/suspend$/, handler: (a, [addr]) => a.suspendStore(addr!, true) },
  { method: "POST", pattern: /^\/api\/stores\/(0x[a-fA-F0-9]{40})\/resume$/, handler: (a, [addr]) => a.suspendStore(addr!, false) },
  { method: "POST", pattern: /^\/api\/orders\/([0-9A-Z]{26})\/refund$/, handler: (a, [id]) => a.refundOrder(id!) },
  { method: "POST", pattern: /^\/api\/orders\/([0-9A-Z]{26})\/cancel-subscription$/, handler: (a, [id]) => a.cancelSubscription(id!) },
  { method: "POST", pattern: /^\/api\/promotions\/([0-9A-Z]{26})\/(posted|discarded|draft)$/, handler: (a, [id, st]) => a.setPromotionStatus(id!, st as "posted" | "discarded" | "draft") },
];

export function createDashboardHandler(deps: DashboardDeps, boundPort: () => number): http.RequestListener {
  return async (req, res) => {
    const sendJson = (status: number, body: unknown) => {
      const payload = JSON.stringify(body);
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(payload),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(payload);
    };

    try {
      // Once the dashboard listens beyond loopback (phone access), a container
      // can route to that address through the host. Its packets still carry a
      // source address on the agent network, so refuse them here.
      const agentSubnet = deps.agentSubnet ?? deps.admin.config.dockerSubnet;
      if (agentSubnet && ipInCidr(req.socket.remoteAddress, agentSubnet)) {
        return sendJson(403, { error: "The dashboard is not available from agent containers." });
      }
      if (!isAllowedHost(req.headers.host, boundPort(), deps.allowedHosts)) {
        return sendJson(403, {
          error: "This address is not on the dashboard's allowed list. Add it to dashboardAllowedHosts in host.json.",
        });
      }
      const url = new URL(req.url || "/", "http://127.0.0.1");
      const method = (req.method || "GET").toUpperCase();

      const asset = method === "GET" ? ASSETS[url.pathname] : undefined;
      if (asset) {
        const content = fs.readFileSync(path.join(ASSET_DIR, asset.file));
        res.writeHead(200, {
          "Content-Type": asset.type,
          "Content-Length": content.length,
          "Content-Security-Policy": CSP,
          "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "no-referrer",
          "Cache-Control": "no-store",
        });
        return res.end(content);
      }

      if (!url.pathname.startsWith("/api/")) return sendJson(404, { error: "Not found" });
      if (!tokenMatches(req.headers["x-admin-token"], deps.token)) {
        return sendJson(401, { error: "Missing or wrong admin token. Open the link printed by `automaton-host dashboard`." });
      }

      for (const route of api) {
        if (route.method !== method) continue;
        const m = route.pattern.exec(url.pathname);
        if (!m) continue;
        const body = method === "POST" ? await readJson(req) : undefined;
        return sendJson(200, await route.handler(deps.admin, m.slice(1), url.searchParams, body));
      }
      return sendJson(404, { error: `No route for ${method} ${url.pathname}` });
    } catch (err) {
      if (err instanceof AdminError) return sendJson(err.status, { error: err.message });
      deps.log?.(`dashboard error: ${err instanceof Error ? err.stack || err.message : String(err)}`);
      return sendJson(500, { error: err instanceof Error ? err.message : "Internal error" });
    }
  };
}

export async function startDashboardServer(
  deps: DashboardDeps,
): Promise<{ port: number; addresses: string[]; close(): Promise<void> }> {
  const forbidden = new Set(["0.0.0.0", "::", deps.admin.config.dockerGateway]);
  const extra = (deps.bindAddresses || []).filter((addr) => {
    // Never listen where agent containers can connect. The wildcard address
    // includes the Docker gateway, so it is refused along with the gateway.
    if (forbidden.has(addr)) {
      deps.log?.(`dashboard: refusing to listen on ${addr} (reachable from agent containers)`);
      return false;
    }
    return true;
  });

  let port = deps.port;
  const handler = createDashboardHandler(deps, () => port);
  const servers: http.Server[] = [];
  const addresses: string[] = [];

  const first = http.createServer(handler);
  await new Promise<void>((resolve, reject) => {
    first.once("error", reject);
    first.listen(deps.port, "127.0.0.1", () => resolve());
  });
  port = (first.address() as { port: number }).port;
  servers.push(first);
  addresses.push(`127.0.0.1:${port}`);

  for (const addr of [...new Set(extra)]) {
    const server = http.createServer(handler);
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, addr, () => resolve());
      });
      servers.push(server);
      addresses.push(`${addr}:${port}`);
    } catch (err: any) {
      deps.log?.(`dashboard: could not listen on ${addr}:${port} — ${err?.message || err}`);
    }
  }

  return {
    port,
    addresses,
    close: async () => {
      await Promise.all(servers.map((srv) => new Promise<void>((r) => srv.close(() => r()))));
    },
  };
}
