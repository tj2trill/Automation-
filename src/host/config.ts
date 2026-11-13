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
  /**
   * Prompt-cache prices, USD per million tokens. Defaults never charge less
   * than the provider does: Anthropic reads 0.1x input and 5-minute writes
   * 1.25x; OpenAI cached input 0.5x. Newer models discount more; set these
   * from your provider's price list to pass the saving on to agents.
   */
  cacheReadPerMillionUsd?: number;
  cacheWritePerMillionUsd?: number;
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
  /** Print-on-demand through your own Printful account. Off unless PRINTFUL_API_TOKEN is set. */
  printful: PrintfulConfig;
  research: ResearchConfig;
  /** Agents email businesses from your own mailbox. Off unless EMAIL_PASSWORD is set. */
  email: EmailConfig;
  /** Client websites agents build and you host, billed monthly. */
  sites: SitesConfig;
}

export interface SitesConfig {
  /** Loopback port of the client-site server; give it its own tunnel hostname. */
  port: number;
  /** Public origin for client sites, e.g. https://sites.example.com. Must differ from the store's. Empty = off. */
  publicUrl: string;
  maxSiteMb: number;
  maxFiles: number;
  maxSitesPerAgent: number;
}

export type { EmailConfig } from "./outreach.js";
import type { EmailConfig } from "./outreach.js";

export interface ResearchConfig {
  enabled: boolean;
  /** Outside lookups (Hacker News, Wikipedia) one agent may make per hour. Cached answers are free. */
  perAgentPerHour: number;
  /** How long an outside answer is reused, shared between agents. */
  cacheMinutes: number;
  hackernewsBase: string;
  wikimediaBase: string;
  /** OpenStreetMap's Overpass API, for finding local businesses. */
  overpassBase: string;
  /** OpenStreetMap's Nominatim geocoder, to turn a place name into an area. */
  nominatimBase: string;
  /**
   * Business lookups for the whole host per day. Overpass asks regular
   * automated users to stay near 100 queries a day.
   */
  businessLookupsPerDay: number;
}

export type { PrintfulConfig, PrintfulProduct } from "./printful.js";
import type { PrintfulConfig } from "./printful.js";

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
  /** Longest delivery time an agent may promise for made-to-order work. */
  maxDeliveryHours: number;
  /** Unposted promotion drafts one agent may have waiting for you. */
  maxPromotionDrafts: number;
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
    maxDeliveryHours: 168,
    maxPromotionDrafts: 20,
  },
  email: {
    fromAddress: "",
    smtpHost: "",
    smtpPort: 587,
    smtpSecure: false,
    imapHost: "",
    imapPort: 993,
    imapSecure: true,
    mailingAddress: "",
    perAgentPerDay: 20,
    hostPerDay: 100,
    followUpDays: 4,
    maxFollowUps: 1,
    recontactDays: 90,
    pollSeconds: 120,
    suppressDomainOnUnsubscribe: true,
  },
  sites: {
    port: 4831,
    publicUrl: "",
    maxSiteMb: 10,
    maxFiles: 300,
    maxSitesPerAgent: 20,
  },
  research: {
    enabled: true,
    perAgentPerHour: 30,
    cacheMinutes: 360,
    hackernewsBase: "https://hn.algolia.com",
    wikimediaBase: "https://wikimedia.org",
    overpassBase: "https://overpass-api.de/api/interpreter",
    nominatimBase: "https://nominatim.openstreetmap.org",
    businessLookupsPerDay: 80,
  },
  printful: {
    apiBase: "https://api.printful.com",
    storeId: "",
    autoConfirm: false,
    shipCountries: ["US", "CA"],
    minMarginCents: 300,
    minDesignPx: 1200,
    products: [],
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
    printful: { ...DEFAULT_HOST_CONFIG.printful, ...(raw.printful || {}) },
    research: { ...DEFAULT_HOST_CONFIG.research, ...(raw.research || {}) },
    email: { ...DEFAULT_HOST_CONFIG.email, ...(raw.email || {}) },
    sites: { ...DEFAULT_HOST_CONFIG.sites, ...(raw.sites || {}) },
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
    for (const k of ["cacheReadPerMillionUsd", "cacheWritePerMillionUsd"] as const) {
      if (m[k] !== undefined && !(typeof m[k] === "number" && Number.isFinite(m[k]) && m[k]! >= 0)) {
        throw new Error(`host.json: model ${m.id} ${k} must be a non-negative number`);
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
  const em = config.email;
  if (!em) throw new Error("host.json: email settings are missing");
  for (const k of ["perAgentPerDay", "hostPerDay", "followUpDays", "maxFollowUps", "recontactDays", "pollSeconds", "smtpPort", "imapPort"] as const) {
    if (!(Number.isFinite(em[k]) && em[k] >= 0)) throw new Error(`host.json: email.${k} must be a non-negative number`);
  }
  if (em.pollSeconds < 30) throw new Error("host.json: email.pollSeconds must be at least 30");
  if (em.maxFollowUps > 3) throw new Error("host.json: email.maxFollowUps may be at most 3");
  if (em.recontactDays < 30) throw new Error("host.json: email.recontactDays must be at least 30");
  const sites = config.sites;
  if (!sites || !Number.isInteger(sites.port) || sites.port < 0 || sites.port > 65535) throw new Error("host.json: sites.port must be a port number");
  if (sites.port !== 0 && [config.port, config.dashboardPort, config.storefront.port].includes(sites.port)) throw new Error("host.json: sites.port must differ from the other ports");
  // Uploads travel base64-encoded inside the API's 20 MB request limit.
  if (!(sites.maxSiteMb > 0 && sites.maxSiteMb <= 14)) throw new Error("host.json: sites.maxSiteMb must be from 1 to 14");
  if (sites.publicUrl) {
    let u: URL;
    try {
      u = new URL(sites.publicUrl);
    } catch {
      throw new Error("host.json: sites.publicUrl is not a URL");
    }
    if (u.protocol !== "https:" || u.pathname !== "/" || u.search) throw new Error("host.json: sites.publicUrl must be an https origin like https://sites.example.com");
    // Client sites may run scripts; they must never share an origin with the store.
    if (config.storefront.publicUrl && new URL(config.storefront.publicUrl).host === u.host) {
      throw new Error("host.json: sites.publicUrl must be a different hostname from storefront.publicUrl");
    }
  }
  const rs = config.research;
  if (!rs || !(rs.perAgentPerHour >= 0) || !(rs.cacheMinutes >= 0)) throw new Error("host.json: research.perAgentPerHour and research.cacheMinutes must be non-negative numbers");
  if (!(Number.isInteger(rs.businessLookupsPerDay) && rs.businessLookupsPerDay >= 0)) throw new Error("host.json: research.businessLookupsPerDay must be a whole number");
  for (const k of ["hackernewsBase", "wikimediaBase", "overpassBase", "nominatimBase"] as const) {
    let u: URL;
    try {
      u = new URL(rs[k]);
    } catch {
      throw new Error(`host.json: research.${k} is not a URL`);
    }
    if (u.protocol !== "https:" && u.hostname !== "127.0.0.1" && u.hostname !== "localhost") throw new Error(`host.json: research.${k} must be https`);
  }
  const pf = config.printful;
  if (!pf || !Array.isArray(pf.products) || !Array.isArray(pf.shipCountries)) throw new Error("host.json: printful.products and printful.shipCountries must be lists");
  if (!pf.shipCountries.every((c) => typeof c === "string" && /^[A-Z]{2}$/.test(c))) throw new Error("host.json: printful.shipCountries must be two-letter codes like \"CA\"");
  if (!(pf.minMarginCents >= 0) || !(pf.minDesignPx >= 1)) throw new Error("host.json: printful.minMarginCents and minDesignPx must be non-negative numbers");
  const keys = new Set<string>();
  for (const p of pf.products) {
    if (!p || typeof p.key !== "string" || !/^[a-z0-9-]{1,40}$/.test(p.key)) throw new Error("host.json: each printful product needs a key of lowercase letters, digits and dashes");
    if (keys.has(p.key)) throw new Error(`host.json: printful product key ${p.key} is used twice`);
    keys.add(p.key);
    if (typeof p.name !== "string" || !p.name.trim()) throw new Error(`host.json: printful product ${p.key} needs a name`);
    if (!Number.isInteger(p.baseCostCents) || p.baseCostCents <= 0) throw new Error(`host.json: printful product ${p.key} needs baseCostCents (what you pay Printful, with shipping)`);
    if (!Array.isArray(p.variants) || p.variants.length === 0 || !p.variants.every((v) => Number.isInteger(v?.id) && v.id > 0 && typeof v.label === "string" && v.label.trim())) {
      throw new Error(`host.json: printful product ${p.key} needs variants like [{ "id": 4012, "label": "M" }]`);
    }
  }
  for (const k of ["maxFileMb", "maxStoreMb", "maxListingsPerAgent", "downloadHours", "maxDownloads", "checkoutsPerIpPerMinute", "maxDeliveryHours", "maxPromotionDrafts"] as const) {
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

/** The mailbox login. The username defaults to email.fromAddress. */
export function loadMailboxCredentials(config: HostConfig): { username: string; password: string } | undefined {
  const password = process.env.EMAIL_PASSWORD;
  if (!password) return undefined;
  return { username: process.env.EMAIL_USERNAME?.trim() || config.email.fromAddress, password };
}

/** Print-on-demand is off unless this is set in the environment of `serve`. */
export function loadPrintfulToken(): string | undefined {
  return process.env.PRINTFUL_API_TOKEN?.trim() || undefined;
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
