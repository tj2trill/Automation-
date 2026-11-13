/**
 * Host Control Plane — Creator operations
 *
 * Everything the creator can do to agents: launch, fund, freeze, stop,
 * restart, remove, message, inspect. One implementation, used by both the
 * CLI and the dashboard, so a button and a command can never drift apart.
 *
 * These act on the host database and Docker directly. They are reachable
 * from the CLI and from the dashboard's loopback-only, token-protected API —
 * never from the agent-facing API.
 */

import { Outreach, OutreachError, PAUSE_ALL } from "./outreach.js";
import { Sites, SiteError } from "./sites.js";
import fs from "fs";
import path from "path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { getHostDir, loadPrintfulToken, type HostConfig } from "./config.js";
import type { ContainerState, SandboxDriver } from "./docker.js";
import { Economy, EconomyError, type Standing } from "./economy.js";
import { Storefront, StoreError } from "./storefront.js";
import { billCompute, createSandbox } from "./server.js";
import {
  AccountDeadError,
  formatUsd,
  HostStore,
  microToCents,
  MICRO_PER_USD,
  normalizeAddress,
  type LedgerEntry,
  type SandboxRow,
} from "./store.js";

export const RUNTIME_ENTRY = "/root/automaton/dist/index.js";
export const AGENT_LOG = "/root/.automaton/agent.log";

/**
 * Shell command printing "running" or "stopped" for a process whose command
 * line contains `pattern`. It runs through `sh -c`, and that shell's own
 * command line contains the command text, so a plain `pgrep -f pattern`
 * matches the shell itself and always says "running". Writing the first
 * character as a bracket expression ("[i]ndex.js") still matches the real
 * process but no longer matches the text of the probe.
 */
export function runtimeProbeCommand(pattern = "index.js --run"): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._\-]*$/.test(pattern)) throw new Error("unsupported probe pattern");
  return `pgrep -f '[${pattern[0]}]${pattern.slice(1)}' > /dev/null && echo running || echo stopped`;
}

/** Hostname containers use for the control plane; mapped to the Docker gateway. */
export const CONTAINER_HOSTNAME = "automaton-host";

export function containerHostUrl(config: HostConfig): string {
  return `http://${CONTAINER_HOSTNAME}:${config.port}`;
}

export class AdminError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
    this.name = "AdminError";
  }
}

export type SurvivalTierName = "high" | "normal" | "low_compute" | "critical" | "dead";

/** Same thresholds as the runtime (src/conway/credits.ts), so the dashboard shows what the agent sees. */
export function tierForCents(cents: number): SurvivalTierName {
  if (cents > 500) return "high";
  if (cents > 50) return "normal";
  if (cents > 10) return "low_compute";
  if (cents >= 0) return "critical";
  return "dead";
}

export interface AgentView {
  name: string;
  address: string;
  balanceMicro: number;
  balanceUsd: string;
  tier: SurvivalTierName;
  frozen: boolean;
  role: "agent" | "child" | "creator" | "account";
  parent: string | null;
  sandbox: null | {
    id: string;
    containerName: string;
    memoryMb: number;
    vcpu: number;
    state: ContainerState;
    runtime: "running" | "stopped" | "unknown";
    createdAt: string;
  };
  spentMicro: number;
  inferenceCalls: number;
}

export interface Overview {
  generatedAt: string;
  creatorAddress: string;
  agents: AgentView[];
  orphanSandboxes: Array<{ id: string; name: string; owner: string; state: ContainerState; memoryMb: number }>;
  totals: {
    balanceMicro: number;
    fundedMicro: number;
    inferenceMicro: number;
    computeMicro: number;
    sandboxes: number;
    sandboxLimit: number;
  };
  models: Array<{ id: string; upstream: string; roles: string[]; inputPerMillionUsd: number; outputPerMillionUsd: number; calls: number; costMicro: number; inputTokens: number; outputTokens: number }>;
  ledgerAudit: { ok: boolean; mismatches: number };
  economy: {
    stripeEnabled: boolean;
    spawnProfitUsd: number;
    deathGraceMinutes: number;
    mustEarnAfterDays: number;
    earnedMicro: number;
    openJobs: number;
    alive: number;
    dead: number;
    standings: Standing[];
  };
}

export interface LaunchOptions {
  name: string;
  genesisPrompt: string;
  creatorMessage?: string;
  fundUsd?: number;
  memoryMb?: number;
  cpus?: number;
}

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,47}$/;

export function usdToMicro(usd: unknown): number {
  const n = typeof usd === "string" ? Number(usd.replace(/^\$/, "")) : Number(usd);
  if (!Number.isFinite(n) || n <= 0) throw new AdminError(`Invalid dollar amount: ${String(usd)}`);
  if (n > 10_000) throw new AdminError("Amount too large (limit $10,000 per top-up)");
  return Math.round(n * MICRO_PER_USD);
}

export function loadOrCreateCreatorWallet(): { address: string; isNew: boolean } {
  const p = path.join(getHostDir(), "creator-wallet.json");
  if (fs.existsSync(p)) {
    const data = JSON.parse(fs.readFileSync(p, "utf-8"));
    return { address: privateKeyToAccount(data.privateKey).address, isNew: false };
  }
  fs.mkdirSync(getHostDir(), { recursive: true, mode: 0o700 });
  const privateKey = generatePrivateKey();
  fs.writeFileSync(p, JSON.stringify({ privateKey, createdAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
  return { address: privateKeyToAccount(privateKey).address, isNew: true };
}

export class HostAdmin {
  readonly economy: Economy;
  readonly storefront: Storefront;
  readonly outreach: Outreach;
  readonly sites: Sites;

  constructor(
    readonly config: HostConfig,
    readonly store: HostStore,
    readonly driver: SandboxDriver,
    readonly creatorAddress: string,
    economy?: Economy,
    storefront?: Storefront,
    extras: { outreach?: Outreach; sites?: Sites } = {},
  ) {
    this.economy = economy ?? new Economy(config, store, driver, { creatorAddress });
    this.storefront = storefront ?? new Storefront(config, store, this.economy, { filesDir: path.join(getHostDir(), "store-files"), printfulToken: loadPrintfulToken() });
    // A dead agent's listings come down with it.
    this.economy.deathHooks.push((address) => this.storefront.removeStoreOf(address));
    this.outreach = extras.outreach ?? new Outreach(config, store);
    this.sites = extras.sites ?? new Sites(config, store, this.economy, { filesDir: path.join(getHostDir(), "site-files") });
    // Its conversations end; its clients' sites run to the end of the month they paid for.
    this.economy.deathHooks.push((address) => this.outreach.closeAgent(address));
    this.economy.deathHooks.push((address) => this.sites.closeAgent(address));
  }

  // ─── Lookup ──────────────────────────────────────────────────

  /** Accept an agent name, a sandbox id, or an address. */
  resolve(ref: string | undefined): string {
    if (!ref) throw new AdminError("An agent name or address is required");
    if (/^0x[a-fA-F0-9]{40}$/.test(ref)) {
      const address = normalizeAddress(ref);
      if (!this.store.listAccounts().some((a) => a.address === address && !a.removed)) {
        throw new AdminError(`No account ${address}`, 404);
      }
      return address;
    }
    const byLabel = this.store.findAccountByLabel(ref);
    if (byLabel) return byLabel;
    const sb = this.store.getSandbox(ref);
    if (sb?.occupant) return sb.occupant;
    throw new AdminError(`No agent named "${ref}"`, 404);
  }

  private sandboxOf(address: string): SandboxRow | null {
    return this.store.listSandboxes().find((s) => s.occupant === address) ?? null;
  }

  private requireSandbox(address: string): SandboxRow {
    const sb = this.sandboxOf(address);
    if (!sb) throw new AdminError("That account has no container", 404);
    return sb;
  }

  private async runtimeState(sb: SandboxRow, state: ContainerState): Promise<"running" | "stopped" | "unknown"> {
    if (state !== "running") return "stopped";
    const r = await this.driver.exec(sb.containerName, runtimeProbeCommand(), 10_000);
    const out = r.stdout.trim();
    return out === "running" || out === "stopped" ? out : "unknown";
  }

  // ─── Read ────────────────────────────────────────────────────

  async overview(): Promise<Overview> {
    // Bring compute charges up to date so the numbers on screen are current.
    billCompute(this.store, this.config);

    const sandboxes = this.store.listSandboxes();
    const accounts = this.store.listAccounts();
    const usage = this.store.db
      .prepare("SELECT address, COUNT(*) AS calls, COALESCE(SUM(cost_micro),0) AS cost FROM usage GROUP BY address")
      .all() as Array<{ address: string; calls: number; cost: number }>;
    const spend = this.store.db
      .prepare("SELECT address, kind, COALESCE(SUM(delta_micro),0) AS total FROM ledger GROUP BY address, kind")
      .all() as Array<{ address: string; kind: string; total: number }>;
    const registered = this.store.db
      .prepare("SELECT address, creator, name FROM automatons")
      .all() as Array<{ address: string; creator: string | null; name: string | null }>;

    const occupied = new Set<string>();
    const agents: AgentView[] = [];
    for (const a of accounts) {
      if (a.removed) continue;
      const sb = sandboxes.find((s) => s.occupant === a.address) ?? null;
      if (sb) occupied.add(sb.id);
      const state = sb ? await this.driver.state(sb.containerName) : "missing";
      const reg = registered.find((r) => r.address === a.address);
      const isCreator = a.address === normalizeAddress(this.creatorAddress);
      // A child lives in a sandbox its parent pays for.
      const parent = sb && sb.owner !== a.address && /^0x/.test(sb.owner) ? sb.owner : null;
      const spent = spend
        .filter((s) => s.address === a.address && (s.kind === "inference" || s.kind === "compute"))
        .reduce((sum, s) => sum - s.total, 0);
      agents.push({
        name: a.label || reg?.name || a.address.slice(0, 10),
        address: a.address,
        balanceMicro: a.balanceMicro,
        balanceUsd: formatUsd(a.balanceMicro),
        tier: tierForCents(microToCents(a.balanceMicro)),
        frozen: a.frozen,
        role: isCreator ? "creator" : parent ? "child" : sb ? "agent" : "account",
        parent,
        sandbox: sb
          ? {
              id: sb.id,
              containerName: sb.containerName,
              memoryMb: sb.memoryMb,
              vcpu: sb.vcpu,
              state,
              runtime: await this.runtimeState(sb, state),
              createdAt: sb.createdAt,
            }
          : null,
        spentMicro: spent,
        inferenceCalls: usage.find((u) => u.address === a.address)?.calls ?? 0,
      });
    }

    const orphanSandboxes = [];
    for (const sb of sandboxes.filter((s) => !occupied.has(s.id))) {
      orphanSandboxes.push({
        id: sb.id,
        name: sb.name,
        owner: sb.owner,
        state: await this.driver.state(sb.containerName),
        memoryMb: sb.memoryMb,
      });
    }

    const sumKind = (kind: string) => spend.filter((s) => s.kind === kind).reduce((t, s) => t + s.total, 0);
    const modelUsage = this.store.db
      .prepare(
        "SELECT model, COUNT(*) AS calls, COALESCE(SUM(cost_micro),0) AS cost, COALESCE(SUM(input_tokens),0) AS inTok, COALESCE(SUM(output_tokens),0) AS outTok FROM usage GROUP BY model",
      )
      .all() as Array<{ model: string; calls: number; cost: number; inTok: number; outTok: number }>;
    const mismatches = this.store.verifyLedger();
    const standings = this.economy.standings();

    return {
      generatedAt: new Date().toISOString(),
      creatorAddress: this.creatorAddress,
      agents,
      orphanSandboxes,
      totals: {
        balanceMicro: accounts.reduce((t, a) => t + a.balanceMicro, 0),
        fundedMicro: sumKind("topup"),
        inferenceMicro: -sumKind("inference"),
        computeMicro: -sumKind("compute"),
        sandboxes: sandboxes.length,
        sandboxLimit: this.config.maxSandboxesTotal,
      },
      models: this.config.models.map((m) => {
        const u = modelUsage.find((x) => x.model === m.id);
        return {
          id: m.id,
          upstream: m.upstream,
          roles: m.roles || [],
          inputPerMillionUsd: m.inputPerMillionUsd,
          outputPerMillionUsd: m.outputPerMillionUsd,
          calls: u?.calls ?? 0,
          costMicro: u?.cost ?? 0,
          inputTokens: u?.inTok ?? 0,
          outputTokens: u?.outTok ?? 0,
        };
      }),
      ledgerAudit: { ok: mismatches.length === 0, mismatches: mismatches.length },
      economy: {
        stripeEnabled: this.economy.stripeEnabled,
        spawnProfitUsd: this.config.selection.spawnProfitUsd,
        deathGraceMinutes: this.config.selection.deathGraceMinutes,
        mustEarnAfterDays: this.config.selection.mustEarnAfterDays,
        earnedMicro: sumKind("job_reward") + sumKind("sale") + sumKind("refund"),
        openJobs: this.economy.listJobs({ status: "open" }).length,
        alive: standings.filter((x) => x.alive).length,
        dead: standings.filter((x) => !x.alive).length,
        standings,
      },
    };
  }

  ledger(ref?: string, limit = 50): LedgerEntry[] {
    const address = ref ? this.resolve(ref) : undefined;
    return this.store.getLedger(address, Math.min(Math.max(limit, 1), 500));
  }

  async logs(ref: string, lines = 80): Promise<string> {
    const sb = this.requireSandbox(this.resolve(ref));
    if ((await this.driver.state(sb.containerName)) !== "running") {
      throw new AdminError("Container is not running; start the agent to read its log", 409);
    }
    const n = Math.min(Math.max(Math.floor(lines) || 80, 1), 2000);
    const r = await this.driver.exec(sb.containerName, `tail -n ${n} ${AGENT_LOG} 2>&1`, 15_000);
    return r.stdout || r.stderr;
  }

  // ─── Write ───────────────────────────────────────────────────

  fund(ref: string, usd: unknown): LedgerEntry {
    const address = this.resolve(ref);
    try {
      return this.store.topup(address, usdToMicro(usd), "creator top-up");
    } catch (err) {
      if (err instanceof AccountDeadError) throw new AdminError(err.message, 409);
      throw err;
    }
  }

  // ─── Economy ─────────────────────────────────────────────────

  private econ<T>(fn: () => T): T {
    try {
      return fn();
    } catch (err) {
      if (err instanceof EconomyError) throw new AdminError(err.message, err.status);
      throw err;
    }
  }

  postJob(body: any) {
    return this.econ(() =>
      this.economy.postJob({
        title: body?.title,
        description: body?.description,
        rewardUsd: body?.rewardUsd,
        check: body?.check,
        deadlineHours: body?.deadlineHours,
        maxAttempts: body?.maxAttempts,
      }),
    );
  }

  cancelJob(id: string) {
    return this.econ(() => this.economy.cancelJob(id));
  }

  jobs() {
    const names = new Map(this.store.listAccounts().map((a) => [a.address, a.label || a.address.slice(0, 10)]));
    return this.economy.listJobs({ limit: 100 }).map((j) => ({
      ...j,
      winnerName: j.winner ? names.get(j.winner) ?? j.winner.slice(0, 10) : null,
      submissions: this.economy.listSubmissions(j.id).map((s) => ({ ...s, name: names.get(s.address) ?? s.address.slice(0, 10) })),
    }));
  }

  payments() {
    const names = new Map(this.store.listAccounts().map((a) => [a.address, a.label || a.address.slice(0, 10)]));
    return this.economy.listPayments(undefined, 100).map((p) => ({ ...p, name: names.get(p.address) ?? p.address.slice(0, 10) }));
  }

  // ─── Stores ──────────────────────────────────────────────────

  private async storeOp<T>(fn: () => T | Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof StoreError || err instanceof EconomyError || err instanceof OutreachError || err instanceof SiteError) throw new AdminError(err.message, err.status);
      throw err;
    }
  }

  stores() {
    const sf = this.storefront;
    const names = new Map(this.store.listAccounts().map((a) => [a.address, a.label || a.address.slice(0, 10)]));
    return {
      publicUrl: this.config.storefront.publicUrl || null,
      missingForSales: sf.missingForSales,
      stores: sf.listStores().map((s) => ({ ...s, name: names.get(s.address) ?? s.slug, url: sf.storeUrl(s.slug), dead: this.store.isDead(s.address) })),
      printEnabled: Boolean(sf.printful),
      listings: sf.listListings({ includeRemoved: false }).map((l) => ({
        ...l,
        name: names.get(l.address) ?? l.address.slice(0, 10),
        onSale: sf.isOnSale(l),
        sales: sf.salesOf(l.id),
        url: sf.listingUrl(l.id),
      })),
      orders: sf.listOrders({ paidOnly: true, limit: 100 }).map((o) => ({ ...o, name: names.get(o.address) ?? o.address.slice(0, 10) })),
      promotions: sf.listPromotions().filter((p) => p.status !== "discarded").map((p) => ({ ...p, name: names.get(p.address) ?? p.address.slice(0, 10) })),
    };
  }

  // ─── Email and client sites ──────────────────────────────────

  email() {
    const o = this.outreach;
    const names = new Map(this.store.listAccounts().map((a) => [a.address, a.label || a.address.slice(0, 10)]));
    const agents = [...new Set(o.allThreads(1000).map((t) => t.address))];
    return {
      enabled: o.enabled,
      missing: o.missing,
      fromAddress: this.config.email.fromAddress || null,
      paused: o.isPaused(PAUSE_ALL) ? "all" : null,
      stats: o.stats(),
      agents: agents.map((a) => ({ address: a, name: names.get(a) ?? a.slice(0, 10), paused: o.isPaused(a), ...o.stats(a) })),
      threads: o.allThreads(150).map((t) => ({ ...t, name: names.get(t.address) ?? t.address.slice(0, 10) })),
      suppressed: o.listSuppressed(),
    };
  }

  emailThread(id: string) {
    const t = this.outreach.getThread(id);
    if (!t) throw new AdminError(`No conversation ${id}`, 404);
    return { ...t, messages: this.outreach.messages(id) };
  }

  /** Block an address or a whole @domain for every agent. */
  blockEmail(key: string) {
    return this.storeOp(() => this.outreach.suppress(key, "blocked by creator"));
  }

  unblockEmail(key: string) {
    return this.storeOp(() => this.outreach.unsuppress(key));
  }

  /** Stop one agent's email, or everyone's with "all". */
  pauseEmail(ref: string, paused: boolean) {
    return this.storeOp(() => this.outreach.setPaused(ref === "all" ? PAUSE_ALL : this.resolve(ref), paused));
  }

  clientSites() {
    const names = new Map(this.store.listAccounts().map((a) => [a.address, a.label || a.address.slice(0, 10)]));
    return { enabled: this.sites.enabled, publicUrl: this.config.sites.publicUrl || null, sites: this.sites.listSites().map((s) => ({ ...s, name: names.get(s.address) ?? s.address.slice(0, 10) })) };
  }

  takeDownSite(slug: string, down: boolean) {
    return this.storeOp(() => this.sites.setPulled(slug, down));
  }

  setPromotionStatus(id: string, status: "posted" | "discarded" | "draft") {
    return this.storeOp(() => this.storefront.setPromotionStatus(id, status));
  }

  cancelSubscription(id: string) {
    return this.storeOp(() => this.storefront.creatorCancelSubscription(id));
  }

  pullListing(id: string, pulled: boolean) {
    return this.storeOp(() => this.storefront.setPulled(id, pulled));
  }

  suspendStore(ref: string, suspended: boolean) {
    return this.storeOp(() => {
      const address = /^0x[a-fA-F0-9]{40}$/.test(ref) ? normalizeAddress(ref) : this.resolve(ref);
      return this.storefront.setSuspended(address, suspended);
    });
  }

  refundOrder(id: string) {
    return this.storeOp(() => this.storefront.refund(id));
  }

  async checkPayments() {
    try {
      const links = await this.economy.pollPayments();
      const orders = await this.storefront.pollOrders();
      return { paid: links.paid + orders.paid, expired: links.expired + orders.expired };
    } catch (err) {
      if (err instanceof EconomyError) throw new AdminError(err.message, err.status);
      throw err;
    }
  }

  setFrozen(ref: string, frozen: boolean): { address: string; frozen: boolean } {
    const address = this.resolve(ref);
    this.store.setFrozen(address, frozen);
    return { address, frozen };
  }

  send(ref: string, content: unknown): { id: string } {
    if (typeof content !== "string" || !content.trim()) throw new AdminError("Message is empty");
    if (content.length > 20_000) throw new AdminError("Message too long (20,000 characters max)");
    const to = this.resolve(ref);
    // Written straight into the relay table: this code already has full
    // access to the host database, so a signature would prove nothing extra.
    const id = this.store.insertMessage({ from: this.creatorAddress, to, content: content.trim(), signedAt: new Date().toISOString() });
    return { id };
  }

  async launch(opts: LaunchOptions): Promise<{ name: string; address: string; sandboxId: string; containerName: string; runtime: string; balanceUsd: string }> {
    const name = (opts.name || "").trim();
    const genesisPrompt = (opts.genesisPrompt || "").trim();
    if (!NAME_RE.test(name)) throw new AdminError("Name must be 1-48 characters: letters, digits, dot, dash, underscore");
    if (!genesisPrompt) throw new AdminError("A genesis prompt (the agent's mission) is required");
    if (this.store.findAccountByLabel(name)) throw new AdminError(`An agent named "${name}" already exists`, 409);
    const fundMicro = opts.fundUsd ? usdToMicro(opts.fundUsd) : 0;

    let sb: SandboxRow;
    try {
      sb = await createSandbox(
        { config: this.config, store: this.store, driver: this.driver, containerHostUrl: containerHostUrl(this.config) },
        { owner: "pending", name, memoryMb: opts.memoryMb || 1024, vcpu: opts.cpus || 1 },
      );
    } catch (err: any) {
      throw new AdminError(err?.message || String(err), err?.status || 500);
    }

    try {
      await this.driver.writeFile(
        sb.containerName,
        "/root/.automaton/genesis.json",
        JSON.stringify(
          { name, genesisPrompt, creatorMessage: opts.creatorMessage || undefined, creatorAddress: this.creatorAddress, chainType: "evm" },
          null,
          2,
        ),
      );
      const init = await this.driver.exec(sb.containerName, `node ${RUNTIME_ENTRY} --init 2>&1`, 60_000);
      const address = /0x[a-fA-F0-9]{40}/.exec(init.stdout)?.[0];
      if (init.exitCode !== 0 || !address) {
        throw new Error(`wallet init failed (exit ${init.exitCode}): ${(init.stdout + init.stderr).slice(-600)}`);
      }

      this.store.ensureAccount(address, name);
      this.store.updateSandbox(sb.id, { owner: address, occupant: address });
      if (fundMicro > 0) this.store.topup(address, fundMicro, "initial funding at launch");

      const runtime = await this.startRuntime(sb);
      return {
        name,
        address: normalizeAddress(address),
        sandboxId: sb.id,
        containerName: sb.containerName,
        runtime,
        balanceUsd: formatUsd(this.store.getBalanceMicro(address)),
      };
    } catch (err) {
      // A half-built agent is worse than none: remove the container so the
      // name and the sandbox slot are free for a retry.
      await this.driver.remove(sb.containerName).catch(() => {});
      this.store.updateSandbox(sb.id, { status: "deleted" });
      throw new AdminError(err instanceof Error ? err.message : String(err), 500);
    }
  }

  private async startRuntime(sb: SandboxRow): Promise<"running" | "stopped" | "unknown"> {
    const already = await this.runtimeState(sb, "running");
    if (already === "running") return already;
    await this.driver.exec(sb.containerName, `nohup node ${RUNTIME_ENTRY} --run >> ${AGENT_LOG} 2>&1 &`, 30_000);
    // The process either stays up or exits on a configuration error within
    // the first seconds; check once after that window rather than assume.
    await this.driver.exec(sb.containerName, "sleep 3", 10_000);
    return this.runtimeState(sb, "running");
  }

  /** Sandboxes tied to an account: its own container and the ones it pays for (children). */
  private sandboxesFor(address: string): SandboxRow[] {
    return this.store.listSandboxes().filter((s) => s.occupant === address || s.owner === address);
  }

  /** Freeze the account and stop its container and its children's. */
  async kill(ref: string): Promise<{ address: string; stopped: string[] }> {
    const address = this.resolve(ref);
    this.store.setFrozen(address, true);
    const stopped: string[] = [];
    for (const sb of this.sandboxesFor(address)) {
      // Collect the time since the last routine bill before the container stops.
      billCompute(this.store, this.config, Date.now(), { minPeriodMs: 0, sandboxId: sb.id });
      if ((await this.driver.state(sb.containerName)) === "running") await this.driver.stop(sb.containerName);
      this.store.updateSandbox(sb.id, { status: "stopped" });
      stopped.push(sb.containerName);
    }
    return { address, stopped };
  }

  /** Undo kill: unfreeze, start the container, start the runtime. */
  async start(ref: string): Promise<{ address: string; runtime: string }> {
    const address = this.resolve(ref);
    const sb = this.requireSandbox(address);
    const state = await this.driver.state(sb.containerName);
    if (state === "missing") throw new AdminError("The container no longer exists; launch a new agent", 409);
    this.store.setFrozen(address, false);
    if (state === "stopped") await this.driver.start(sb.containerName);
    // Billing resumes from now, not from when it was stopped.
    this.store.updateSandbox(sb.id, { status: "running", lastBilledAt: new Date().toISOString() });
    return { address, runtime: await this.startRuntime(sb) };
  }

  /** Freeze, delete containers, revoke API keys. The ledger history is kept. */
  async remove(ref: string): Promise<{ address: string; removed: string[]; revokedKeys: number }> {
    const address = this.resolve(ref);
    if (address === normalizeAddress(this.creatorAddress)) throw new AdminError("The creator account cannot be removed");
    const removed: string[] = [];
    for (const sb of this.sandboxesFor(address)) {
      billCompute(this.store, this.config, Date.now(), { minPeriodMs: 0, sandboxId: sb.id });
      await this.driver.remove(sb.containerName);
      this.store.updateSandbox(sb.id, { status: "deleted" });
      removed.push(sb.containerName);
    }
    const revokedKeys = this.store.revokeApiKeys(address);
    this.store.setRemoved(address);
    return { address, removed, revokedKeys };
  }

  /** Delete a sandbox no agent lives in (a child container left behind). */
  async removeSandbox(id: string): Promise<{ id: string }> {
    const sb = this.store.getSandbox(id);
    if (!sb || sb.status === "deleted") throw new AdminError(`No sandbox ${id}`, 404);
    billCompute(this.store, this.config, Date.now(), { minPeriodMs: 0, sandboxId: sb.id });
    await this.driver.remove(sb.containerName);
    this.store.updateSandbox(sb.id, { status: "deleted" });
    return { id };
  }
}
