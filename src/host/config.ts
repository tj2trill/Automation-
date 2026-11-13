/**
 * Host Control Plane — Configuration
 *
 * The host is the self-hosted replacement for Conway Cloud. It runs on the
 * creator's machine, OUTSIDE every agent container, and owns the three things
 * an agent must never be able to edit: the credit ledger, the upstream API
 * keys, and the Docker socket.
 *
 * Config lives in ~/.automaton-host/host.json (override dir with
 * AUTOMATON_HOST_DIR). Upstream API keys are read from the environment only —
 * they are never written to disk by this module.
 */

import { randomBytes } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

export type UpstreamKind = "anthropic" | "openai" | "ollama";

/** Which survival tier a model is the designated choice for. */
export type ModelRole = "primary" | "low_compute" | "critical";

export interface HostModelConfig {
  /** Model id the agent asks for. */
  id: string;
  upstream: UpstreamKind;
  /** Model id sent upstream; defaults to `id`. */
  upstreamModel?: string;
  /** Price charged to the agent's ledger, USD per million tokens. */
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
  roles?: ModelRole[];
  contextWindow?: number;
  maxTokens?: number;
}

export interface HostConfig {
  /** TCP port for the agent-facing control plane API. */
  port: number;
  /** TCP port for the creator's dashboard. Always on 127.0.0.1; see dashboardBindAddresses. */
  dashboardPort: number;
  /**
   * Extra Host names the dashboard answers to, for opening it from a phone
   * over a private VPN (e.g. "my-box.tailnet.ts.net"). Loopback always works.
   */
  dashboardAllowedHosts: string[];
  /**
   * Extra addresses the dashboard listens on (e.g. a Tailscale 100.x address).
   * 0.0.0.0 and the Docker gateway are refused: agents could reach those.
   */
  dashboardBindAddresses: string[];
  /**
   * Addresses to bind. 127.0.0.1 is always bound; the Docker network gateway
   * is added at startup so containers can reach the host. Never 0.0.0.0 by
   * default: provisioning is open to anything that can connect.
   */
  extraBindAddresses: string[];
  /** Docker image agents and children run in. */
  agentImage: string;
  /** Dedicated Docker bridge network for agent containers. */
  dockerNetwork: string;
  dockerSubnet: string;
  dockerGateway: string;
  /** OpenAI-compatible base URL (set to OpenRouter etc. if wanted). */
  openaiBaseUrl: string;
  ollamaBaseUrl: string;
  models: HostModelConfig[];
  /** Compute price: USD per GB of container memory per hour. */
  computeUsdPerGbHour: number;
  /** Hard cap on containers per owner account (defence against runaway spawning). */
  maxSandboxesPerOwner: number;
  /** Hard cap on containers overall. */
  maxSandboxesTotal: number;
  /** Per-container limits applied by Docker regardless of what was requested. */
  maxSandboxMemoryMb: number;
  maxSandboxCpus: number;
  sandboxPidsLimit: number;
  selection: SelectionConfig;
  stripe: StripeConfig;
  /** Longest a job's check may run against one submission. */
  jobCheckTimeoutSeconds: number;
  storefront: StorefrontConfig;
}

export interface StorefrontConfig {
  /** Loopback port of the public storefront server; point Cloudflare Tunnel here. */
  port: number;
  /** The public https address customers use, e.g. https://shop.example.com. Empty = storefront off. */
  publicUrl: string;
  /** Shown on every store page: who is selling. Required before anything can be bought. */
  operatorName: string;
  /** Shown on every store page for refunds and questions. Required before anything can be bought. */
  contactEmail: string;
  maxFileMb: number;
  maxStoreMb: number;
  maxListingsPerAgent: number;
  /** How long a buyer's download link works, and how many times. */
  downloadHours: number;
  maxDownloads: number;
  /** Checkout sessions one visitor may start per minute. */
  checkoutsPerIpPerMinute: number;
}

export interface SelectionConfig {
  /**
   * Earned profit (money earned from jobs and customers, minus the agent's
   * own inference and container spend) an agent must show per child. The
   * first child needs this much, the second twice as much, and so on.
   * 0 turns the rule off.
   */
  spawnProfitUsd: number;
  /** How long an agent may sit at a zero balance before it is removed for good. */
  deathGraceMinutes: number;
}

export interface StripeConfig {
  /** Override only for tests. The secret key comes from STRIPE_SECRET_KEY, never from this file. */
  apiBase: string;
  /** Deducted from each payment before the agent is credited, to cover the processor's cut. */
  feePercent: number;
  feeFixedCents: number;
  minAmountCents: number;
  maxAmountCents: number;
  maxOpenLinksPerAgent: number;
  /** Where the customer lands after paying. */
  successUrl: string;
  currency: string;
}

/**
 * Default model table.
 *
 * PRICES ARE PLACEHOLDERS YOU MUST VERIFY: they decide how fast an agent's
 * ledger drains, but the host cannot know your provider's current price list.
 * Edit ~/.automaton-host/host.json after `automaton-host init`.
 */
export const DEFAULT_HOST_CONFIG: HostConfig = {
  port: 4820,
  dashboardPort: 4821,
  dashboardAllowedHosts: [],
  dashboardBindAddresses: [],
  extraBindAddresses: [],
  agentImage: "automaton-agent:local",
  dockerNetwork: "automaton-net",
  dockerSubnet: "172.30.0.0/24",
  dockerGateway: "172.30.0.1",
  openaiBaseUrl: "https://api.openai.com",
  ollamaBaseUrl: "http://127.0.0.1:11434",
  models: [
    {
      id: "claude-sonnet-5-5",
      upstream: "anthropic",
      inputPerMillionUsd: 3,
      outputPerMillionUsd: 15,
      roles: ["primary"],
      contextWindow: 200_000,
      maxTokens: 8192,
    },
    {
      id: "qwen2.5:7b",
      upstream: "ollama",
      inputPerMillionUsd: 0,
      outputPerMillionUsd: 0,
      roles: ["low_compute", "critical"],
      contextWindow: 32_768,
      maxTokens: 4096,
    },
  ],
  computeUsdPerGbHour: 0.01,
  maxSandboxesPerOwner: 4,
  maxSandboxesTotal: 12,
  maxSandboxMemoryMb: 2048,
  maxSandboxCpus: 2,
  sandboxPidsLimit: 512,
  selection: { spawnProfitUsd: 1, deathGraceMinutes: 60 },
  stripe: {
    apiBase: "https://api.stripe.com",
    feePercent: 2.9,
    feeFixedCents: 30,
    minAmountCents: 100,
    maxAmountCents: 50_000,
    maxOpenLinksPerAgent: 20,
    successUrl: "https://example.com/thanks",
    currency: "usd",
  },
  jobCheckTimeoutSeconds: 60,
  storefront: {
    port: 4830,
    publicUrl: "",
    operatorName: "",
    contactEmail: "",
    maxFileMb: 10,
    maxStoreMb: 100,
    maxListingsPerAgent: 50,
    downloadHours: 72,
    maxDownloads: 5,
    checkoutsPerIpPerMinute: 10,
  },
};

export function getHostDir(): string {
  return process.env.AUTOMATON_HOST_DIR || path.join(os.homedir(), ".automaton-host");
}

export function getHostConfigPath(): string {
  return path.join(getHostDir(), "host.json");
}

export function getHostDbPath(): string {
  return path.join(getHostDir(), "host.db");
}

export function loadHostConfig(): HostConfig {
  const p = getHostConfigPath();
  if (!fs.existsSync(p)) return { ...DEFAULT_HOST_CONFIG };
  const raw = JSON.parse(fs.readFileSync(p, "utf-8"));
  const merged: HostConfig = {
    ...DEFAULT_HOST_CONFIG,
    ...raw,
    selection: { ...DEFAULT_HOST_CONFIG.selection, ...(raw.selection || {}) },
    stripe: { ...DEFAULT_HOST_CONFIG.stripe, ...(raw.stripe || {}) },
    storefront: { ...DEFAULT_HOST_CONFIG.storefront, ...(raw.storefront || {}) },
  };
  validateHostConfig(merged);
  return merged;
}

export function saveHostConfig(config: HostConfig): void {
  const dir = getHostDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(getHostConfigPath(), JSON.stringify(config, null, 2), { mode: 0o600 });
}

export function validateHostConfig(config: HostConfig): void {
  if (!Array.isArray(config.models) || config.models.length === 0) {
    throw new Error("host.json: `models` must list at least one model");
  }
  const ids = new Set<string>();
  for (const m of config.models) {
    if (!m.id || ids.has(m.id)) throw new Error(`host.json: duplicate or empty model id "${m.id}"`);
    ids.add(m.id);
    if (!["anthropic", "openai", "ollama"].includes(m.upstream)) {
      throw new Error(`host.json: model ${m.id} has unknown upstream "${m.upstream}"`);
    }
    for (const k of ["inputPerMillionUsd", "outputPerMillionUsd"] as const) {
      if (typeof m[k] !== "number" || !Number.isFinite(m[k]) || m[k] < 0) {
        throw new Error(`host.json: model ${m.id} needs a non-negative ${k}`);
      }
    }
  }
  const sel = config.selection;
  if (!sel || !(sel.spawnProfitUsd >= 0) || !(sel.deathGraceMinutes >= 0)) {
    throw new Error("host.json: selection.spawnProfitUsd and selection.deathGraceMinutes must be non-negative numbers");
  }
  const st = config.stripe;
  if (!st || !(st.feePercent >= 0 && st.feePercent < 100) || !(st.feeFixedCents >= 0) || !(st.minAmountCents >= 50) || !(st.maxAmountCents >= st.minAmountCents)) {
    throw new Error("host.json: stripe fees and amount limits are invalid (minAmountCents must be at least 50)");
  }
  const sf = config.storefront;
  if (!sf || !Number.isInteger(sf.port) || sf.port < 0 || sf.port > 65535) throw new Error("host.json: storefront.port must be a port number");
  if (sf.publicUrl) {
    let u: URL;
    try {
      u = new URL(sf.publicUrl);
    } catch {
      throw new Error("host.json: storefront.publicUrl is not a URL");
    }
    if (u.protocol !== "https:") throw new Error("host.json: storefront.publicUrl must be https (customers pay through it)");
    if (u.pathname !== "/" || u.search || u.hash) throw new Error("host.json: storefront.publicUrl must be just the origin, e.g. https://shop.example.com");
  }
  if (sf.port !== 0 && (sf.port === config.port || sf.port === config.dashboardPort)) {
    throw new Error("host.json: storefront.port must differ from the agent API and dashboard ports");
  }
  for (const k of ["maxFileMb", "maxStoreMb", "maxListingsPerAgent", "downloadHours", "maxDownloads", "checkoutsPerIpPerMinute"] as const) {
    if (!(typeof sf[k] === "number" && sf[k] > 0)) throw new Error(`host.json: storefront.${k} must be a positive number`);
  }
  if (!config.models.some((m) => m.roles?.includes("primary"))) {
    throw new Error('host.json: one model must have role "primary"');
  }
}

/** Resolve the model serving a role, falling back toward the primary. */
export function modelForRole(config: HostConfig, role: ModelRole): HostModelConfig {
  const direct = config.models.find((m) => m.roles?.includes(role));
  if (direct) return direct;
  if (role === "critical") return modelForRole(config, "low_compute");
  return config.models.find((m) => m.roles?.includes("primary")) ?? config.models[0]!;
}

/**
 * Admin token for the dashboard. Generated once, stored 0600 in the host
 * directory (outside every container), and required on every dashboard API
 * call in addition to the loopback-only bind.
 */
export function loadOrCreateAdminToken(): string {
  const p = path.join(getHostDir(), "admin-token");
  if (fs.existsSync(p)) {
    const t = fs.readFileSync(p, "utf-8").trim();
    if (t) return t;
  }
  fs.mkdirSync(getHostDir(), { recursive: true, mode: 0o700 });
  const token = randomBytes(24).toString("hex");
  fs.writeFileSync(p, token + "\n", { mode: 0o600 });
  return token;
}

export interface UpstreamKeys {
  anthropicApiKey?: string;
  openaiApiKey?: string;
}

/** Stripe is off unless this is set in the environment of `serve`. */
export function loadStripeKey(): string | undefined {
  return process.env.STRIPE_SECRET_KEY?.trim() || undefined;
}

export function loadUpstreamKeys(): UpstreamKeys {
  return {
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || undefined,
    openaiApiKey: process.env.OPENAI_API_KEY || undefined,
  };
}
