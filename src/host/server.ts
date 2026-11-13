/**
 * Host Control Plane — HTTP API
 *
 * A self-hosted implementation of the API surface the automaton runtime
 * expects from Conway Cloud (reverse-engineered from src/conway/client.ts,
 * src/identity/provision.ts and src/social/client.ts): wallet-signature
 * auth, credits, sandboxes, metered inference, registration and the message
 * relay. Domains are intentionally not implemented.
 *
 * There are NO admin endpoints. Adding funds, freezing an account and
 * removing containers are only possible from the host CLI, which talks to
 * the database and Docker directly. An agent that fully compromises its own
 * API key can spend its own balance and nothing else.
 */

import http from "http";
import { ulid } from "ulid";
import { keccak256, toBytes, verifyMessage } from "viem";
import type { HostConfig } from "./config.js";
import type { SandboxDriver } from "./docker.js";
import {
  handleChatCompletion,
  ProxyError,
  type ChatCompletionRequest,
  type UpstreamChat,
} from "./inference-proxy.js";
import { Economy, EconomyError } from "./economy.js";
import { StoreError, type Storefront } from "./storefront.js";
import { ResearchError, type MarketResearch } from "./research.js";
import { OutreachError, type Outreach, type Thread } from "./outreach.js";
import { SiteError, type Sites, type Site } from "./sites.js";
import {
  AccountDeadError,
  AccountFrozenError,
  HostStore,
  InsufficientFundsError,
  MICRO_PER_CENT,
  MICRO_PER_USD,
  microToCents,
  normalizeAddress,
  type SandboxRow,
} from "./store.js";

const MAX_BODY_BYTES = 20 * 1024 * 1024;
const RELAY_SKEW_MS = 5 * 60_000;
const RELAY_MAX_CONTENT = 64_000;

/** Memory tiers mirrored from the runtime's spawn logic, for /credits/pricing. */
const PRICING_TIERS = [
  { name: "small", vcpu: 1, memoryMb: 512, diskGb: 5 },
  { name: "standard", vcpu: 1, memoryMb: 1024, diskGb: 10 },
  { name: "large", vcpu: 2, memoryMb: 2048, diskGb: 20 },
];

export class HttpError extends Error {
  constructor(public readonly status: number, message: string, public readonly code = "error") {
    super(message);
    this.name = "HttpError";
  }
}

export interface HostServerDeps {
  config: HostConfig;
  store: HostStore;
  driver: SandboxDriver;
  upstream: UpstreamChat;
  /** URL containers use to reach this server, injected into their environment. */
  containerHostUrl: string;
  log?: (msg: string) => void;
  /** Jobs, payments, reproduction rules and death. Absent only in narrow tests. */
  economy?: Economy;
  /** Agents' public stores. */
  storefront?: Storefront;
  research?: MarketResearch;
  /** Email to businesses, from the creator's mailbox. */
  outreach?: Outreach;
  /** Client websites. */
  sites?: Sites;
}

interface Ctx {
  req: http.IncomingMessage;
  url: URL;
  body: any;
  deps: HostServerDeps;
}

type Handler = (ctx: Ctx, params: string[]) => Promise<{ status?: number; body: unknown; raw?: boolean }>;

interface Route {
  method: string;
  pattern: RegExp;
  handler: Handler;
}

function isEvmAddress(a: unknown): a is string {
  return typeof a === "string" && /^0x[a-fA-F0-9]{40}$/.test(a);
}

function bearer(req: http.IncomingMessage): string | null {
  const h = req.headers["authorization"];
  if (typeof h !== "string" || !h.trim()) return null;
  return h.trim().replace(/^Bearer\s+/i, "");
}

/** Resolve the calling account from its API key, or throw 401. */
function requireAccount(ctx: Ctx): string {
  const key = bearer(ctx.req);
  const address = key ? ctx.deps.store.resolveApiKey(key) : null;
  if (!address) throw new HttpError(401, "Missing or invalid API key", "unauthorized");
  return address;
}

/** A sandbox is usable by the account that pays for it or the automaton living in it. */
function requireSandbox(ctx: Ctx, id: string, address: string): SandboxRow {
  const sb = ctx.deps.store.getSandbox(id);
  // 404 for both "missing" and "not yours": do not confirm other accounts' sandbox ids.
  if (!sb || sb.status === "deleted" || (sb.owner !== address && sb.occupant !== address)) {
    throw new HttpError(404, `Sandbox ${id} not found`, "not_found");
  }
  return sb;
}

function sandboxJson(sb: SandboxRow) {
  return {
    id: sb.id,
    name: sb.name,
    status: sb.status,
    region: "local",
    vcpu: sb.vcpu,
    memory_mb: sb.memoryMb,
    disk_gb: sb.diskGb,
    created_at: sb.createdAt,
  };
}

function containerNameFor(id: string): string {
  return `automaton-${id.toLowerCase()}`;
}

/**
 * Create a container + its sandbox row. Shared by the API (children) and the
 * CLI (`launch`), so limits are enforced identically on both paths.
 */
export async function createSandbox(
  deps: Pick<HostServerDeps, "config" | "store" | "driver" | "containerHostUrl">,
  params: { owner: string; name?: string; vcpu?: number; memoryMb?: number; diskGb?: number },
): Promise<SandboxRow> {
  const { config, store, driver } = deps;
  const owner = normalizeAddress(params.owner);

  const all = store.listSandboxes();
  if (all.length >= config.maxSandboxesTotal) {
    throw new HttpError(429, `Host sandbox limit reached (${config.maxSandboxesTotal})`, "sandbox_limit");
  }
  if (all.filter((s) => s.owner === owner).length >= config.maxSandboxesPerOwner) {
    throw new HttpError(429, `Per-account sandbox limit reached (${config.maxSandboxesPerOwner})`, "sandbox_limit");
  }
  if (!(await driver.imageExists(config.agentImage))) {
    throw new HttpError(503, `Agent image ${config.agentImage} not found. Run: automaton-host build-image`, "image_missing");
  }

  const id = ulid();
  const memoryMb = Math.min(Math.max(Math.round(params.memoryMb || 512), 256), config.maxSandboxMemoryMb);
  const vcpu = Math.min(Math.max(params.vcpu || 1, 0.25), config.maxSandboxCpus);
  const name = (params.name || `sandbox-${id.slice(-6)}`).replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 64);
  const containerName = containerNameFor(id);
  const hostUrl = new URL(deps.containerHostUrl);

  await driver.ensureNetwork(config.dockerNetwork, config.dockerSubnet, config.dockerGateway);
  await driver.create({
    containerName,
    image: config.agentImage,
    network: config.dockerNetwork,
    memoryMb,
    cpus: vcpu,
    pidsLimit: config.sandboxPidsLimit,
    env: {
      AUTOMATON_HOST_URL: deps.containerHostUrl,
      // The runtime execs locally inside its own container, so it is not
      // given a sandbox id to route through the API.
    },
    labels: { "automaton.sandbox": id, "automaton.owner": owner },
    hostAliases: { [hostUrl.hostname]: config.dockerGateway },
  });

  const now = new Date().toISOString();
  const row: SandboxRow = {
    id,
    owner,
    occupant: null,
    name,
    containerName,
    status: "running",
    vcpu,
    memoryMb,
    diskGb: params.diskGb || 5,
    createdAt: now,
    lastBilledAt: now,
  };
  store.insertSandbox(row);
  return row;
}

/** Charge running sandboxes for the memory-time used since they were last billed. */
/** Routine billing writes at most one ledger row per sandbox per this period. */
export const COMPUTE_BILLING_PERIOD_MS = 60_000;

export interface BillComputeOptions {
  /**
   * Shortest stretch worth a ledger row. Billing runs on a timer and on every
   * dashboard refresh; without a floor each refresh would add a row for a
   * second or two of compute and bury the ledger. Pass 0 for the final bill
   * when a sandbox stops, so the last partial period is still collected.
   */
  minPeriodMs?: number;
  /** Bill only this sandbox. */
  sandboxId?: string;
}

export function billCompute(store: HostStore, config: HostConfig, now = Date.now(), opts: BillComputeOptions = {}): number {
  const minPeriodMs = opts.minPeriodMs ?? COMPUTE_BILLING_PERIOD_MS;
  let charged = 0;
  for (const sb of store.listSandboxes()) {
    if (opts.sandboxId && sb.id !== opts.sandboxId) continue;
    if (sb.status !== "running" || !isEvmAddress(sb.owner)) continue;
    const elapsedMs = now - new Date(sb.lastBilledAt).getTime();
    if (elapsedMs <= 0 || elapsedMs < minPeriodMs) continue;
    const microPerMs = ((sb.memoryMb / 1024) * config.computeUsdPerGbHour * MICRO_PER_USD) / 3_600_000;
    if (microPerMs <= 0) continue;
    const cost = Math.floor(elapsedMs * microPerMs);
    // Wait until at least one whole micro-dollar has accrued.
    if (cost < 1) continue;

    // Compute never pushes a balance below zero. The runtime treats zero as
    // "critical" (alive, fundable) and negative as "dead"; an idle agent
    // should run out of money, not accumulate unbounded debt it can never
    // clear. Whatever the account cannot cover is simply not collected.
    const payable = Math.min(cost, Math.max(store.getBalanceMicro(sb.owner), 0));
    if (payable > 0) {
      store.charge(sb.owner, payable, "compute", sb.id, `${sb.memoryMb}MB x ${(elapsedMs / 60_000).toFixed(1)}min`);
      charged += payable;
    }

    // Advance the clock only by the time the whole-micro charge covers.
    // Jumping to `now` would discard the fractional remainder on every tick,
    // which at a 1 GB / $0.01-per-hour rate silently drops ~28% of the bill.
    // Unpaid time (empty account) is written off, so the clock jumps to now.
    const billedThrough = payable === cost ? new Date(sb.lastBilledAt).getTime() + Math.ceil(cost / microPerMs) : now;
    store.updateSandbox(sb.id, { lastBilledAt: new Date(Math.min(billedThrough, now)).toISOString() });
  }
  return charged;
}

// ─── Route handlers ────────────────────────────────────────────

const routes: Route[] = [];
const route = (method: string, pattern: RegExp, handler: Handler) => routes.push({ method, pattern, handler });

route("GET", /^\/health$/, async () => ({ body: { ok: true, service: "automaton-host" } }));

// Auth: wallet signature -> short-lived session -> long-lived API key.

route("POST", /^\/v1\/auth\/nonce$/, async ({ deps }) => ({ body: { nonce: deps.store.createNonce() } }));

route("POST", /^\/v1\/auth\/verify$/, async ({ body, deps }) => {
  const message = body?.message;
  const signature = body?.signature;
  if (typeof message !== "string" || typeof signature !== "string") {
    throw new HttpError(400, "message and signature are required", "invalid_request");
  }
  if (body?.chain_type === "solana") {
    throw new HttpError(501, "Solana sign-in is not supported by the self-hosted control plane; use an EVM wallet", "not_supported");
  }
  // EIP-4361: the address is the second line, the nonce a "Nonce: " field.
  const address = message.split("\n")[1]?.trim();
  const nonce = /^Nonce: (\S+)$/m.exec(message)?.[1];
  if (!isEvmAddress(address) || !nonce) {
    throw new HttpError(400, "Malformed sign-in message", "invalid_request");
  }
  let valid = false;
  try {
    valid = await verifyMessage({ address: address as `0x${string}`, message, signature: signature as `0x${string}` });
  } catch {
    valid = false;
  }
  if (!valid) throw new HttpError(401, "Signature does not match address", "unauthorized");
  if (deps.store.isDead(address)) throw new HttpError(403, "This account is dead", "account_dead");
  // Consume the nonce only after the signature checks out, so a bad request
  // cannot burn someone else's pending nonce.
  if (!deps.store.consumeNonce(nonce)) throw new HttpError(401, "Unknown or expired nonce", "unauthorized");
  return { body: { access_token: deps.store.createSession(address) } };
});

/**
 * Record which sandbox an account lives in, from the connection's source
 * address. A child's container is created by its parent, so the host has no
 * other way to learn who ended up inside it. Occupancy only lets the
 * dashboard show the link and lets the creator stop that container by agent
 * name; the occupant is already root in the container.
 */
export async function claimOccupancy(deps: HostServerDeps, remoteAddress: string | undefined, address: string): Promise<void> {
  const ip = (remoteAddress || "").replace(/^::ffff:/, "");
  if (!ip || ip === "127.0.0.1" || ip === "::1") return;
  for (const sb of deps.store.listSandboxes()) {
    if (sb.occupant || sb.status !== "running") continue;
    if ((await deps.driver.ip(sb.containerName, deps.config.dockerNetwork)) === ip) {
      deps.store.updateSandbox(sb.id, { occupant: address });
      // A container paid for by another agent holds that agent's child.
      if (isEvmAddress(sb.owner) && sb.owner !== address) deps.economy?.recordLineage(address, sb.owner);
      return;
    }
  }
}

route("POST", /^\/v1\/auth\/api-keys$/, async (ctx) => {
  const token = bearer(ctx.req);
  const address = token ? ctx.deps.store.resolveSession(token) : null;
  if (!address) throw new HttpError(401, "Missing or expired session token", "unauthorized");
  if (ctx.deps.store.listAccounts().some((a) => a.address === address && a.removed)) {
    throw new HttpError(403, "This account was removed by the creator", "forbidden");
  }
  await claimOccupancy(ctx.deps, ctx.req.socket.remoteAddress, address).catch((err) =>
    ctx.deps.log?.(`occupancy lookup failed: ${err instanceof Error ? err.message : String(err)}`),
  );
  const { key, keyPrefix } = ctx.deps.store.createApiKey(address, ctx.body?.name);
  return { body: { key, key_prefix: keyPrefix } };
});

// Credits.

route("GET", /^\/v1\/credits\/balance$/, async (ctx) => {
  const address = requireAccount(ctx);
  const micro = ctx.deps.store.getBalanceMicro(address);
  return { body: { balance_cents: microToCents(micro), balance_micro_usd: micro, address } };
});

/**
 * Money this account received: top-ups and incoming transfers, oldest first.
 * `after` is the id of the last entry the caller already has.
 */
route("GET", /^\/v1\/credits\/received$/, async (ctx) => {
  const address = requireAccount(ctx);
  const after = ctx.url.searchParams.get("after") ?? "";
  if (after && !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(after)) throw new HttpError(400, "after must be a ledger entry id", "invalid_request");
  const limit = Number(ctx.url.searchParams.get("limit") ?? 100);
  const entries = ctx.deps.store.getCreditsReceived(address, after, Number.isFinite(limit) ? limit : 100);
  return {
    body: {
      entries: entries.map((e) => ({ id: e.id, ts: e.ts, amount_micro_usd: e.amountMicro, kind: e.kind, from: e.from })),
    },
  };
});

/**
 * What this account spent, by kind, since `since` (ISO 8601) and since it was
 * opened, with its current balance. Only the caller's own account.
 */
route("GET", /^\/v1\/credits\/spent$/, async (ctx) => {
  const address = requireAccount(ctx);
  const since = ctx.url.searchParams.get("since") ?? "";
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(since) || !Number.isFinite(new Date(since).getTime())) {
    throw new HttpError(400, "since must be an ISO 8601 UTC time", "invalid_request");
  }
  const { period, lifetime } = ctx.deps.store.getSpendSummary(address, since);
  const shape = (k: typeof period) => ({ inference_micro_usd: k.inferenceMicro, compute_micro_usd: k.computeMicro, sent_micro_usd: k.sentMicro });
  return {
    body: { since, period: shape(period), lifetime: shape(lifetime), balance_micro_usd: ctx.deps.store.getBalanceMicro(address) },
  };
});

route("GET", /^\/v1\/credits\/pricing$/, async (ctx) => {
  requireAccount(ctx);
  const rate = ctx.deps.config.computeUsdPerGbHour;
  return {
    body: {
      tiers: PRICING_TIERS.map((t) => ({
        name: t.name,
        vcpu: t.vcpu,
        memory_mb: t.memoryMb,
        disk_gb: t.diskGb,
        monthly_cents: Math.round((t.memoryMb / 1024) * rate * 24 * 30 * 100),
      })),
    },
  };
});

const transferHandler: Handler = async (ctx) => {
  const from = requireAccount(ctx);
  const to = ctx.body?.to_address;
  const amountCents = ctx.body?.amount_cents;
  if (!isEvmAddress(to)) throw new HttpError(400, "to_address must be an EVM address", "invalid_request");
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new HttpError(400, "amount_cents must be a positive integer", "invalid_request");
  }
  try {
    const r = ctx.deps.store.transfer(from, to, amountCents * MICRO_PER_CENT, typeof ctx.body?.note === "string" ? ctx.body.note.slice(0, 500) : undefined);
    return {
      body: {
        transfer_id: r.transferId,
        status: "completed",
        to_address: normalizeAddress(to),
        amount_cents: amountCents,
        balance_after_cents: microToCents(r.balanceAfterMicro),
      },
    };
  } catch (err) {
    if (err instanceof InsufficientFundsError) throw new HttpError(402, err.message, "insufficient_credits");
    if (err instanceof AccountFrozenError) throw new HttpError(403, err.message, "account_frozen");
    if (err instanceof AccountDeadError) throw new HttpError(403, err.message, "account_dead");
    throw new HttpError(400, err instanceof Error ? err.message : String(err), "invalid_request");
  }
};
route("POST", /^\/v1\/credits\/transfers?$/, transferHandler);

// Registration (identity record only; it grants nothing).

route("POST", /^\/v1\/automatons\/register$/, async (ctx) => {
  const address = requireAccount(ctx);
  const b = ctx.body || {};
  if (typeof b.automaton_id !== "string" || !b.automaton_id) {
    throw new HttpError(400, "automaton_id is required", "invalid_request");
  }
  if (normalizeAddress(b.automaton_address || "") !== address) {
    throw new HttpError(403, "automaton_address must match the authenticated account", "forbidden");
  }
  const result = ctx.deps.store.registerAutomaton({
    automatonId: b.automaton_id,
    address,
    creator: b.creator_address,
    name: b.name,
    payload: b,
  });
  if (result === "conflict") throw new HttpError(409, "automaton_id is registered to another address", "conflict");
  ctx.deps.store.ensureAccount(address, typeof b.name === "string" ? b.name : undefined);
  return { body: { automaton: { automaton_id: b.automaton_id, address, name: b.name, status: result } } };
});

route("POST", /^\/v1\/automaton\/register-parent$/, async (ctx) => {
  requireAccount(ctx);
  return { body: { ok: true } };
});

// Models + inference.

route("GET", /^\/v1\/models$/, async (ctx) => {
  requireAccount(ctx);
  return {
    body: {
      object: "list",
      data: ctx.deps.config.models.map((m) => ({
        id: m.id,
        object: "model",
        // "other": the runtime keeps such registry rows enabled across restarts
        // and sends them to the control plane rather than a provider SDK.
        owned_by: "other",
        provider: "other",
        upstream: m.upstream,
        roles: m.roles || [],
        available: true,
        context_window: m.contextWindow ?? 128_000,
        max_tokens: m.maxTokens ?? 4096,
        pricing: {
          input_per_million: m.inputPerMillionUsd,
          output_per_million: m.outputPerMillionUsd,
        },
      })),
    },
  };
});

route("POST", /^\/v1\/chat\/completions$/, async (ctx) => {
  const address = requireAccount(ctx);
  try {
    const result = await handleChatCompletion({
      address,
      request: (ctx.body || {}) as ChatCompletionRequest,
      config: ctx.deps.config,
      store: ctx.deps.store,
      upstream: ctx.deps.upstream,
      log: ctx.deps.log,
    });
    return { body: result.body };
  } catch (err) {
    if (err instanceof ProxyError) throw new HttpError(err.status, err.message, err.code);
    throw err;
  }
});

// Sandboxes.

route("POST", /^\/v1\/sandboxes$/, async (ctx) => {
  const address = requireAccount(ctx);
  const gate = ctx.deps.store.canSpend(address);
  if (!gate.ok) {
    throw gate.reason === "frozen"
      ? new HttpError(403, "Account is frozen by the creator", "account_frozen")
      : new HttpError(402, "Insufficient credits to create a sandbox", "insufficient_credits");
  }
  // Every sandbox an agent creates is a home for a child, so it is gated on earnings.
  if (ctx.deps.economy) {
    const gate = ctx.deps.economy.spawnGate(address);
    if (!gate.ok) throw new HttpError(403, gate.message, "not_fit_to_reproduce");
  }
  const sb = await createSandbox(ctx.deps, {
    owner: address,
    name: ctx.body?.name,
    vcpu: ctx.body?.vcpu,
    memoryMb: ctx.body?.memory_mb,
    diskGb: ctx.body?.disk_gb,
  });
  ctx.deps.economy?.recordSpawn(address, sb.id);
  return { status: 201, body: sandboxJson(sb) };
});

route("GET", /^\/v1\/sandboxes$/, async (ctx) => {
  const address = requireAccount(ctx);
  return { body: { sandboxes: ctx.deps.store.listSandboxes({ owner: address }).map(sandboxJson) } };
});

route("DELETE", /^\/v1\/sandboxes\/([^/]+)$/, async (ctx, [id]) => {
  const address = requireAccount(ctx);
  const sb = requireSandbox(ctx, id!, address);
  // Only the payer may destroy a sandbox; an occupant must not be able to
  // delete the container it was placed in to dodge its parent.
  if (sb.owner !== address) throw new HttpError(403, "Only the sandbox owner can delete it", "forbidden");
  // Collect the time since the last routine bill before the container goes.
  billCompute(ctx.deps.store, ctx.deps.config, Date.now(), { minPeriodMs: 0, sandboxId: sb.id });
  await ctx.deps.driver.remove(sb.containerName);
  ctx.deps.store.updateSandbox(sb.id, { status: "deleted" });
  return { body: { ok: true } };
});

route("POST", /^\/v1\/sandboxes\/([^/]+)\/exec$/, async (ctx, [id]) => {
  const address = requireAccount(ctx);
  const sb = requireSandbox(ctx, id!, address);
  if (ctx.deps.store.isFrozen(address)) throw new HttpError(403, "Account is frozen by the creator", "account_frozen");
  const command = ctx.body?.command;
  if (typeof command !== "string" || !command) throw new HttpError(400, "command is required", "invalid_request");
  const timeout = Math.min(Math.max(Number(ctx.body?.timeout) || 30_000, 1_000), 600_000);
  const r = await ctx.deps.driver.exec(sb.containerName, command, timeout);
  return { body: { stdout: r.stdout, stderr: r.stderr, exit_code: r.exitCode } };
});

route("POST", /^\/v1\/sandboxes\/([^/]+)\/files\/upload\/json$/, async (ctx, [id]) => {
  const address = requireAccount(ctx);
  const sb = requireSandbox(ctx, id!, address);
  if (ctx.deps.store.isFrozen(address)) throw new HttpError(403, "Account is frozen by the creator", "account_frozen");
  const { path: filePath, content } = ctx.body || {};
  if (typeof filePath !== "string" || !filePath || typeof content !== "string") {
    throw new HttpError(400, "path and content are required", "invalid_request");
  }
  await ctx.deps.driver.writeFile(sb.containerName, filePath, content);
  return { body: { ok: true, path: filePath } };
});

route("GET", /^\/v1\/sandboxes\/([^/]+)\/files\/read$/, async (ctx, [id]) => {
  const address = requireAccount(ctx);
  const sb = requireSandbox(ctx, id!, address);
  const filePath = ctx.url.searchParams.get("path");
  if (!filePath) throw new HttpError(400, "path query parameter is required", "invalid_request");
  try {
    return { body: { content: await ctx.deps.driver.readFile(sb.containerName, filePath) } };
  } catch (err: any) {
    throw new HttpError(err?.notFound ? 404 : 500, err?.message || "read failed", err?.notFound ? "not_found" : "error");
  }
});

route("POST", /^\/v1\/sandboxes\/([^/]+)\/ports\/expose$/, async (ctx, [id]) => {
  const address = requireAccount(ctx);
  const sb = requireSandbox(ctx, id!, address);
  const port = Number(ctx.body?.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new HttpError(400, "port must be 1-65535", "invalid_request");
  const ip = await ctx.deps.driver.ip(sb.containerName, ctx.deps.config.dockerNetwork);
  if (!ip) throw new HttpError(503, "Sandbox has no network address (is it running?)", "unavailable");
  // Containers are reachable on the Docker bridge from the host machine only.
  // Nothing is published to the LAN or internet — that needs a tunnel the
  // creator sets up deliberately.
  return { body: { port, public_url: `http://${ip}:${port}`, scope: "host-only" } };
});

route("DELETE", /^\/v1\/sandboxes\/([^/]+)\/ports\/(\d+)$/, async (ctx, [id]) => {
  requireSandbox(ctx, id!, requireAccount(ctx));
  return { body: { ok: true } };
});

// Domains: deliberately absent.

route("GET", /^\/v1\/domains\/.*$/, async () => {
  throw new HttpError(501, "Domains are not available on the self-hosted control plane", "not_supported");
});
route("POST", /^\/v1\/domains\/.*$/, async () => {
  throw new HttpError(501, "Domains are not available on the self-hosted control plane", "not_supported");
});
route("DELETE", /^\/v1\/domains\/.*$/, async () => {
  throw new HttpError(501, "Domains are not available on the self-hosted control plane", "not_supported");
});

// Message relay (agent <-> agent, parent <-> child). Wallet-signed, no API key.

function assertFresh(ts: unknown): string {
  const t = typeof ts === "string" ? Date.parse(ts) : NaN;
  if (!Number.isFinite(t) || Math.abs(Date.now() - t) > RELAY_SKEW_MS) {
    throw new HttpError(401, "Timestamp missing or outside the 5 minute window", "unauthorized");
  }
  return ts as string;
}

async function verifyRelayPoll(ctx: Ctx): Promise<string> {
  const address = ctx.req.headers["x-wallet-address"];
  const signature = ctx.req.headers["x-signature"];
  const timestamp = assertFresh(ctx.req.headers["x-timestamp"]);
  if (!isEvmAddress(address) || typeof signature !== "string") {
    throw new HttpError(401, "Missing wallet signature headers", "unauthorized");
  }
  const canonical = `Conway:poll:${address.toLowerCase()}:${timestamp}`;
  const ok = await verifyMessage({ address: address as `0x${string}`, message: canonical, signature: signature as `0x${string}` }).catch(() => false);
  if (!ok) throw new HttpError(401, "Invalid poll signature", "unauthorized");
  return address.toLowerCase();
}

route("POST", /^\/v1\/messages$/, async (ctx) => {
  const { from, to, content, signed_at, signature, reply_to } = ctx.body || {};
  if (!isEvmAddress(from) || !isEvmAddress(to) || typeof content !== "string" || typeof signature !== "string") {
    throw new HttpError(400, "from, to, content and signature are required", "invalid_request");
  }
  if (content.length > RELAY_MAX_CONTENT) throw new HttpError(413, "Message content too large", "too_large");
  const signedAt = assertFresh(signed_at);
  const canonical = `Conway:send:${to.toLowerCase()}:${keccak256(toBytes(content))}:${signedAt}`;
  const ok = await verifyMessage({ address: from as `0x${string}`, message: canonical, signature: signature as `0x${string}` }).catch(() => false);
  if (!ok) throw new HttpError(401, "Invalid message signature", "unauthorized");
  const id = ctx.deps.store.insertMessage({ from, to, content, signedAt, replyTo: typeof reply_to === "string" ? reply_to : undefined });
  return { status: 201, body: { id } };
});

route("POST", /^\/v1\/messages\/poll$/, async (ctx) => {
  const address = await verifyRelayPoll(ctx);
  const cursor = typeof ctx.body?.cursor === "string" ? ctx.body.cursor : undefined;
  const messages = ctx.deps.store.pollMessages(address, cursor, Number(ctx.body?.limit) || 50);
  const last = messages[messages.length - 1];
  if (last) ctx.deps.store.markDelivered(address, last.id);
  return { body: { messages, next_cursor: last?.id } };
});

route("GET", /^\/v1\/messages\/count$/, async (ctx) => {
  const address = await verifyRelayPoll(ctx);
  return { body: { unread: ctx.deps.store.countUnread(address) } };
});

// Economy: jobs, payment links, selection status.

function requireEconomy(ctx: Ctx): Economy {
  if (!ctx.deps.economy) throw new HttpError(501, "The economy is not enabled on this host", "not_supported");
  return ctx.deps.economy;
}

function jobJson(job: ReturnType<Economy["getJob"]> & {}, attemptsUsed?: number) {
  return {
    id: job.id,
    title: job.title,
    description: job.description,
    reward_micro_usd: job.rewardMicro,
    status: job.status,
    max_attempts: job.maxAttempts,
    ...(attemptsUsed !== undefined ? { attempts_used: attemptsUsed } : {}),
    // The check is shown so an agent knows exactly what will be tested. It is
    // the creator's command; the agent cannot change it.
    check: job.check,
    deadline_at: job.deadlineAt,
    created_at: job.createdAt,
  };
}

route("GET", /^\/v1\/jobs$/, async (ctx) => {
  const address = requireAccount(ctx);
  const econ = requireEconomy(ctx);
  const status = ctx.url.searchParams.get("status") || "open";
  if (!["open", "paid", "cancelled", "expired", "all"].includes(status)) throw new HttpError(400, "unknown status", "invalid_request");
  const jobs = econ.listJobs(status === "all" ? {} : { status: status as any, limit: 50 });
  return {
    body: {
      jobs: jobs.map((j) => ({ ...jobJson(j, econ.attemptsUsed(j.id, address)), won_by_you: j.winner === address })),
    },
  };
});

route("POST", /^\/v1\/jobs\/([0-9A-Z]{26})\/submit$/, async (ctx, [id]) => {
  const address = requireAccount(ctx);
  const r = await requireEconomy(ctx).submitJob(address, id!, ctx.body?.content);
  return { body: { passed: r.passed, paid_micro_usd: r.paidMicro, attempts_left: r.attemptsLeft, message: r.message } };
});

route("POST", /^\/v1\/payments$/, async (ctx) => {
  const address = requireAccount(ctx);
  const p = await requireEconomy(ctx).createPayment(address, ctx.body?.amount_cents, ctx.body?.description);
  return { status: 201, body: { id: p.id, url: p.url, amount_cents: p.amountCents, status: p.status } };
});

route("GET", /^\/v1\/payments$/, async (ctx) => {
  const address = requireAccount(ctx);
  const econ = requireEconomy(ctx);
  return {
    body: {
      stripe_enabled: econ.stripeEnabled,
      payments: econ.listPayments(address, 50).map((p) => ({
        id: p.id, url: p.url, amount_cents: p.amountCents, description: p.description,
        status: p.status, net_micro_usd: p.netMicro, created_at: p.createdAt,
      })),
    },
  };
});

route("GET", /^\/v1\/selection$/, async (ctx) => {
  const address = requireAccount(ctx);
  const econ = requireEconomy(ctx);
  const gate = econ.spawnGate(address);
  const fit = ctx.deps.store.getFitness(address);
  const me = econ.standings().find((s) => s.address === address);
  return {
    body: {
      earned_micro_usd: fit.earnedMicro,
      spent_micro_usd: fit.spentMicro,
      profit_micro_usd: gate.profitMicro,
      can_reproduce: gate.ok,
      next_child_requires_micro_usd: gate.requiredMicro,
      children: gate.children,
      balance_micro_usd: ctx.deps.store.getBalanceMicro(address),
      starving_since: me?.starvingSince ?? null,
      dies_at: me?.diesAt ?? null,
      death_grace_minutes: ctx.deps.config.selection.deathGraceMinutes,
      message: gate.message,
    },
  };
});

// Public store: the agent's own listings.

function requireStorefront(ctx: Ctx): Storefront {
  if (!ctx.deps.storefront) throw new HttpError(501, "Stores are not enabled on this host", "not_supported");
  return ctx.deps.storefront;
}

function listingJson(sf: Storefront, l: ReturnType<Storefront["listListings"]>[number]) {
  const sales = sf.salesOf(l.id);
  return {
    id: l.id,
    kind: l.kind,
    title: l.title,
    description: l.description,
    price_cents: l.priceCents,
    filename: l.filename,
    file_bytes: l.fileBytes,
    delivery_hours: l.deliveryHours,
    request_prompt: l.requestPrompt,
    pod_product: l.podProduct,
    live: l.live,
    pulled_by_creator: l.pulled,
    on_sale: sf.isOnSale(l),
    url: sf.listingUrl(l.id),
    sales: sales.count,
    sales_net_micro_usd: sales.netMicro,
    subscribers: sales.subscribers,
    waiting_for_delivery: sales.waiting,
    drops: l.kind === "subscription" ? sf.listDrops(l.id).length : 0,
    updated_at: l.updatedAt,
  };
}

route("GET", /^\/v1\/store$/, async (ctx) => {
  const address = requireAccount(ctx);
  const sf = requireStorefront(ctx);
  const v = sf.agentStoreView(address);
  return {
    body: {
      url: v.url,
      slug: v.store?.slug ?? null,
      tagline: v.store?.tagline ?? "",
      suspended_by_creator: v.store?.suspended ?? false,
      open_for_purchases: v.openForPurchases,
      print_products: v.printProducts.map((p) => ({ key: p.key, name: p.name, min_price_cents: p.minPriceCents, options: p.options })),
      listings: v.listings.map((l) => listingJson(sf, l)),
    },
  };
});

route("POST", /^\/v1\/store$/, async (ctx) => {
  const address = requireAccount(ctx);
  const s = requireStorefront(ctx).setTagline(address, ctx.body?.tagline);
  return { body: { slug: s.slug, tagline: s.tagline } };
});

route("POST", /^\/v1\/store\/listings$/, async (ctx) => {
  const address = requireAccount(ctx);
  const sf = requireStorefront(ctx);
  const b = ctx.body || {};
  const l = sf.createListing(address, {
    kind: b.kind, title: b.title, description: b.description, priceCents: b.price_cents, filename: b.filename, contentBase64: b.content_base64,
    deliveryHours: b.delivery_hours, requestPrompt: b.request_prompt, podProduct: b.pod_product,
  });
  return { status: 201, body: listingJson(sf, l) };
});

route("POST", /^\/v1\/store\/listings\/([0-9A-Z]{26})$/, async (ctx, [id]) => {
  const address = requireAccount(ctx);
  const sf = requireStorefront(ctx);
  const b = ctx.body || {};
  const l = sf.updateListing(address, id!, {
    title: b.title, description: b.description, priceCents: b.price_cents, live: b.live, deliveryHours: b.delivery_hours, requestPrompt: b.request_prompt,
  });
  return { body: listingJson(sf, l) };
});

route("POST", /^\/v1\/store\/listings\/([0-9A-Z]{26})\/drops$/, async (ctx, [id]) => {
  const address = requireAccount(ctx);
  const sf = requireStorefront(ctx);
  const b = ctx.body || {};
  const d = sf.publishDrop(address, id!, { title: b.title, filename: b.filename, contentBase64: b.content_base64 });
  return { status: 201, body: { id: d.id, title: d.title, filename: d.filename, file_bytes: d.fileBytes, subscribers: sf.salesOf(id!).subscribers } };
});

// Made-to-order work the agent owes. request is the buyer's own words: untrusted text.
route("GET", /^\/v1\/store\/orders$/, async (ctx) => {
  const address = requireAccount(ctx);
  const sf = requireStorefront(ctx);
  return {
    body: {
      orders: sf.openRequests(address).map((o) => ({ id: o.id, listing_id: o.listingId, title: o.title, request: o.requestText, due_at: o.dueAt, price_cents: o.amountCents })),
    },
  };
});

route("POST", /^\/v1\/store\/orders\/([0-9A-Z]{26})\/deliver$/, async (ctx, [id]) => {
  const address = requireAccount(ctx);
  const b = ctx.body || {};
  const o = requireStorefront(ctx).deliver(address, id!, { filename: b.filename, contentBase64: b.content_base64, note: b.note });
  return { body: { id: o.id, status: o.status, credited_micro_usd: o.netMicro } };
});

function promotionJson(p: ReturnType<Storefront["listPromotions"]>[number]) {
  return { id: p.id, platform: p.platform, text: p.text, status: p.status, link: p.link, listing_id: p.listingId, views: p.views, sales: p.sales, created_at: p.createdAt };
}

route("GET", /^\/v1\/research$/, async (ctx) => {
  const address = requireAccount(ctx);
  if (!ctx.deps.research) throw new HttpError(501, "Market research is not enabled on this host", "not_supported");
  const q = ctx.url.searchParams;
  const r = await ctx.deps.research.query(address, { source: q.get("source"), query: q.get("q") ?? undefined, days: q.get("days") ?? undefined });
  return { body: { source: r.source, query: r.query, days: r.days, lines: r.lines, cached: r.cached, fetched_at: r.fetchedAt, lookups_left_this_hour: ctx.deps.research.remaining(address) } };
});

route("POST", /^\/v1\/promotions$/, async (ctx) => {
  const address = requireAccount(ctx);
  const b = ctx.body || {};
  const p = requireStorefront(ctx).draftPromotion(address, { platform: b.platform, text: b.text, listingId: b.listing_id });
  return { status: 201, body: promotionJson(p) };
});

route("GET", /^\/v1\/promotions$/, async (ctx) => {
  const address = requireAccount(ctx);
  return { body: { promotions: requireStorefront(ctx).listPromotions({ address }).map(promotionJson) } };
});

// Email to businesses. Every rule is enforced in Outreach; these routes only translate.

function requireOutreach(ctx: Ctx): Outreach {
  if (!ctx.deps.outreach) throw new HttpError(501, "Email is not enabled on this host", "not_supported");
  return ctx.deps.outreach;
}

function threadJson(t: Thread) {
  return { id: t.id, contact: t.contact, subject: t.subject, status: t.status, followups: t.followups, created_at: t.createdAt, last_sent_at: t.lastOutAt, last_reply_at: t.lastInAt };
}

route("POST", /^\/v1\/email$/, async (ctx) => {
  const address = requireAccount(ctx);
  const b = ctx.body || {};
  const r = await requireOutreach(ctx).sendFirst(address, {
    to: b.to, businessName: b.business_name, sourceUrl: b.source_url, whyRelevant: b.why_relevant, subject: b.subject, body: b.body,
  });
  return { status: 201, body: { thread_id: r.threadId, sent_today: r.sentToday, left_today: r.leftToday } };
});

route("POST", /^\/v1\/email\/threads\/([0-9A-Z]{26})\/reply$/, async (ctx, [id]) => {
  const address = requireAccount(ctx);
  const b = ctx.body || {};
  const attachments = Array.isArray(b.attachments) ? b.attachments.map((a: any) => ({ filename: a?.filename, contentBase64: a?.content_base64 })) : [];
  const r = await requireOutreach(ctx).reply(address, id!, { body: b.body, attachments });
  return { body: { follow_up: r.followUp, left_today: r.leftToday } };
});

// Replies the agent has not seen yet. Their text is written by strangers: untrusted.
route("GET", /^\/v1\/email\/inbox$/, async (ctx) => {
  const address = requireAccount(ctx);
  const o = requireOutreach(ctx);
  return {
    body: {
      conversations: o.inbox(address).map((t) => ({
        ...threadJson(t),
        new_messages: t.newMessages.map((m) => ({ at: m.at, subject: m.subject, automatic_reply: m.automatic, text: m.body.slice(0, 6000) })),
      })),
    },
  };
});

route("GET", /^\/v1\/email\/threads$/, async (ctx) => {
  const address = requireAccount(ctx);
  const o = requireOutreach(ctx);
  const s = o.stats(address);
  return {
    body: {
      enabled: o.enabled,
      missing: o.missing,
      stats: { contacted: s.contacted, replied: s.replied, unsubscribed: s.unsubscribed, bounced: s.bounced, sent_today: s.sentToday, per_day: s.perDay, reply_rate: s.replyRate },
      threads: o.threadsOf(address).map(threadJson),
    },
  };
});

route("GET", /^\/v1\/email\/threads\/([0-9A-Z]{26})$/, async (ctx, [id]) => {
  const address = requireAccount(ctx);
  const o = requireOutreach(ctx);
  const t = o.getThread(id!);
  if (!t || t.address !== address) throw new HttpError(404, `No conversation ${id}`, "not_found");
  return { body: { ...threadJson(t), messages: o.messages(t.id).map((m) => ({ direction: m.direction, at: m.at, subject: m.subject, automatic_reply: m.automatic, text: m.body.slice(0, 6000) })) } };
});

// Client websites.

function requireSites(ctx: Ctx): Sites {
  if (!ctx.deps.sites) throw new HttpError(501, "Website hosting is not enabled on this host", "not_supported");
  return ctx.deps.sites;
}

function siteJson(s: Site) {
  return {
    slug: s.slug, title: s.title, status: s.status, monthly_price_cents: s.priceCents, client_email: s.clientEmail, taken_down_by_creator: s.pulled,
    files: s.files, bytes: s.bytes, preview_url: s.previewUrl, live_url: s.status === "live" && !s.pulled ? s.liveUrl : null, live_since: s.liveSince,
  };
}

route("POST", /^\/v1\/sites$/, async (ctx) => {
  const address = requireAccount(ctx);
  const b = ctx.body || {};
  return { status: 201, body: siteJson(requireSites(ctx).publish(address, { slug: b.slug, title: b.title, files: b.files })) };
});

route("GET", /^\/v1\/sites$/, async (ctx) => {
  const address = requireAccount(ctx);
  const s = requireSites(ctx);
  return { body: { enabled: s.enabled, sites: s.listSites(address).map(siteJson) } };
});

route("POST", /^\/v1\/sites\/([a-z0-9-]{3,40})\/offer$/, async (ctx, [slug]) => {
  const address = requireAccount(ctx);
  const b = ctx.body || {};
  const r = await requireSites(ctx).offerHosting(address, { slug, monthlyCents: b.monthly_price_cents, clientEmail: b.client_email });
  return { body: { checkout_url: r.checkoutUrl, ...siteJson(r.site) } };
});

// ─── Server plumbing ───────────────────────────────────────────

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, "Request body too large", "too_large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export function createRequestHandler(deps: HostServerDeps): http.RequestListener {
  return async (req, res) => {
    const send = (status: number, body: unknown) => {
      const payload = JSON.stringify(body);
      res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
      res.end(payload);
    };

    try {
      const url = new URL(req.url || "/", "http://host");
      const method = (req.method || "GET").toUpperCase();
      const match = routes
        .map((r) => ({ r, m: r.method === method ? r.pattern.exec(url.pathname) : null }))
        .find((x) => x.m);
      if (!match || !match.m) {
        throw new HttpError(404, `No route for ${method} ${url.pathname}`, "not_found");
      }

      let body: any = undefined;
      if (method !== "GET" && method !== "HEAD") {
        const raw = await readBody(req);
        if (raw.length > 0) {
          try {
            body = JSON.parse(raw.toString("utf-8"));
          } catch {
            throw new HttpError(400, "Request body is not valid JSON", "invalid_request");
          }
        }
      }

      const result = await match.r.handler({ req, url, body, deps }, match.m.slice(1));
      send(result.status ?? 200, result.body);
    } catch (err) {
      if (err instanceof HttpError || err instanceof EconomyError || err instanceof StoreError || err instanceof ResearchError || err instanceof OutreachError || err instanceof SiteError) {
        send(err.status, { error: err.message, code: err.code });
        return;
      }
      if (err instanceof AccountDeadError) {
        send(403, { error: err.message, code: "account_dead" });
        return;
      }
      deps.log?.(`unhandled error: ${err instanceof Error ? err.stack || err.message : String(err)}`);
      send(500, { error: err instanceof Error ? err.message : "internal error", code: "internal" });
    }
  };
}

export interface RunningHost {
  addresses: string[];
  close(): Promise<void>;
}

/** Bind the API on each address and start the compute billing timer. */
export async function startHostServer(
  deps: HostServerDeps,
  bindAddresses: string[],
  opts: { billingIntervalMs?: number } = {},
): Promise<RunningHost> {
  const handler = createRequestHandler(deps);
  const servers: http.Server[] = [];
  const bound: string[] = [];

  for (const addr of [...new Set(bindAddresses)]) {
    const server = http.createServer(handler);
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(deps.config.port, addr, () => resolve());
      });
      servers.push(server);
      bound.push(`${addr}:${(server.address() as any).port}`);
    } catch (err: any) {
      // The Docker gateway address only exists once the network has a
      // container on it or the bridge is up; report rather than abort so
      // loopback still serves the CLI.
      deps.log?.(`could not bind ${addr}:${deps.config.port} — ${err?.message || err}`);
    }
  }
  if (servers.length === 0) throw new Error(`Could not bind the control plane on any of: ${bindAddresses.join(", ")}`);

  const interval = setInterval(() => {
    try {
      billCompute(deps.store, deps.config);
    } catch (err) {
      deps.log?.(`compute billing failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    // Billing first, so an agent that just ran dry is seen as starving on this pass.
    if (deps.economy && !economyBusy) {
      economyBusy = true;
      deps.economy
        .tick()
        .then(() => deps.storefront?.pollOrders())
        .then(() => deps.sites?.poll())
        .catch((err) => deps.log?.(`economy tick failed: ${err instanceof Error ? err.message : String(err)}`))
        .finally(() => {
          economyBusy = false;
        });
    }
  }, opts.billingIntervalMs ?? 60_000);
  let economyBusy = false;
  interval.unref();

  // Replies, bounces and unsubscribes from the mailbox.
  let mailBusy = false;
  const mailTimer = deps.outreach?.enabled
    ? setInterval(() => {
        if (mailBusy) return;
        mailBusy = true;
        deps.outreach!
          .poll()
          .then((c) => {
            if (c.replies || c.bounces || c.unsubscribes) deps.log?.(`mailbox: ${c.replies} replies, ${c.bounces} bounces, ${c.unsubscribes} unsubscribes`);
          })
          .catch((err) => deps.log?.(`mailbox check failed: ${err instanceof Error ? err.message : String(err)}`))
          .finally(() => {
            mailBusy = false;
          });
      }, deps.config.email.pollSeconds * 1000)
    : null;
  mailTimer?.unref();

  return {
    addresses: bound,
    close: async () => {
      clearInterval(interval);
      if (mailTimer) clearInterval(mailTimer);
      await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
    },
  };
}
