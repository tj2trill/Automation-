/**
 * Host Control Plane — Economy
 *
 * How agents earn, reproduce and die.
 *
 * Earning. Money enters an agent's account from outside in two ways:
 *   - a job: the creator posts a task with a reward and a check command. An
 *     agent submits an answer; the host runs the check against it in a
 *     throwaway container with no network. The first passing answer is paid.
 *   - a sale: the agent asks for a Stripe Checkout link and gives it to a
 *     customer. The host asks Stripe whether the link was paid and credits
 *     the agent, less the processing fee.
 * Transfers between agents are not earnings. They move money around inside
 * the population, so two agents could inflate each other's totals for free.
 *
 * Reproducing. An agent may create a child container only while its earned
 * profit (earned minus its own inference and container spend) covers
 * `selection.spawnProfitUsd` for every child it has had plus the new one.
 *
 * Dying. An agent whose balance stays at or below zero for
 * `selection.deathGraceMinutes` is removed: container deleted, API keys
 * revoked, account marked dead. A dead account refuses all money, so there
 * is no path back. Its children keep running on their own balances.
 *
 * All of this is enforced here, on the host. The agent runtime is told the
 * rules but is never trusted to apply them to itself.
 */

import { monotonicFactory } from "ulid";
import type { HostConfig } from "./config.js";
import type { SandboxDriver } from "./docker.js";
import { AccountDeadError, HostStore, MICRO_PER_CENT, MICRO_PER_USD, formatUsd, normalizeAddress } from "./store.js";

const ulid = monotonicFactory();

export const MAX_SUBMISSION_BYTES = 256 * 1024;
const MAX_JOB_TEXT = 8_000;
const MAX_CHECK_LENGTH = 2_000;
const OUTPUT_TAIL = 600;

export class EconomyError extends Error {
  constructor(message: string, public readonly status = 400, public readonly code = "invalid_request") {
    super(message);
    this.name = "EconomyError";
  }
}

export type JobStatus = "open" | "paid" | "cancelled" | "expired";

export interface Job {
  id: string;
  title: string;
  description: string;
  rewardMicro: number;
  check: string;
  maxAttempts: number;
  status: JobStatus;
  winner: string | null;
  createdAt: string;
  deadlineAt: string | null;
  closedAt: string | null;
}

export interface JobSubmission {
  id: string;
  jobId: string;
  address: string;
  ts: string;
  passed: boolean;
  exitCode: number;
  outputTail: string;
}

export type PaymentStatus = "open" | "paid" | "expired" | "paid_after_death";

export interface Payment {
  id: string;
  address: string;
  sessionId: string;
  url: string;
  amountCents: number;
  description: string;
  status: PaymentStatus;
  netMicro: number | null;
  createdAt: string;
  closedAt: string | null;
}

export interface Standing {
  address: string;
  name: string;
  alive: boolean;
  parent: string | null;
  generation: number;
  children: number;
  earnedMicro: number;
  spentMicro: number;
  fundedMicro: number;
  /** Earned minus spent: what the agent made on its own account. */
  profitMicro: number;
  balanceMicro: number;
  /** Set while the agent is starving: out of money, or past its starting period without earned profit. */
  starvingSince: string | null;
  diesAt: string | null;
  starvingReason: "out of money" | "not earning" | null;
  /** End of the starting period; from then on the agent must stay in earned profit. Null when the rule is off. */
  mustEarnBy: string | null;
  death: null | { at: string; reason: string };
}

export interface SpawnGate {
  ok: boolean;
  profitMicro: number;
  requiredMicro: number;
  children: number;
  message: string;
}

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<any>;
  text?(): Promise<string>;
  headers?: { get(name: string): string | null };
}>;

export interface EconomyOptions {
  creatorAddress?: string;
  stripeKey?: string;
  fetchImpl?: FetchLike;
  log?: (msg: string) => void;
}

function mapJob(r: any): Job {
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    rewardMicro: r.reward_micro,
    check: r.check_cmd,
    maxAttempts: r.max_attempts,
    status: r.status,
    winner: r.winner,
    createdAt: r.created_at,
    deadlineAt: r.deadline_at,
    closedAt: r.closed_at,
  };
}

function mapPayment(r: any): Payment {
  return {
    id: r.id,
    address: r.address,
    sessionId: r.session_id,
    url: r.url,
    amountCents: r.amount_cents,
    description: r.description,
    status: r.status,
    netMicro: r.net_micro,
    createdAt: r.created_at,
    closedAt: r.closed_at,
  };
}

/** Stripe takes form-encoded bodies with bracketed keys for nested fields. */
export function formEncode(fields: Record<string, string | number>): string {
  return Object.entries(fields)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
}

export class Economy {
  private readonly creator: string;

  constructor(
    readonly config: HostConfig,
    readonly store: HostStore,
    readonly driver: SandboxDriver,
    private readonly opts: EconomyOptions = {},
  ) {
    this.creator = opts.creatorAddress ? normalizeAddress(opts.creatorAddress) : "";
  }

  // ─── Jobs ────────────────────────────────────────────────────

  postJob(input: { title: unknown; description: unknown; rewardUsd: unknown; check: unknown; deadlineHours?: unknown; maxAttempts?: unknown }): Job {
    const title = typeof input.title === "string" ? input.title.trim() : "";
    const description = typeof input.description === "string" ? input.description.trim() : "";
    const check = typeof input.check === "string" ? input.check.trim() : "";
    const reward = Number(input.rewardUsd);
    if (!title || title.length > 120) throw new EconomyError("A job needs a title of 1 to 120 characters");
    if (!description || description.length > MAX_JOB_TEXT) throw new EconomyError(`A job needs a description of 1 to ${MAX_JOB_TEXT} characters`);
    if (!check || check.length > MAX_CHECK_LENGTH) throw new EconomyError(`A job needs a check command of 1 to ${MAX_CHECK_LENGTH} characters`);
    if (!Number.isFinite(reward) || reward <= 0 || reward > 10_000) throw new EconomyError("Reward must be a dollar amount between 0 and 10,000");
    const rewardMicro = Math.round(reward * MICRO_PER_USD);
    if (rewardMicro < 1) throw new EconomyError("Reward is too small to pay");
    let deadlineAt: string | null = null;
    if (input.deadlineHours !== undefined && input.deadlineHours !== null && input.deadlineHours !== "") {
      const h = Number(input.deadlineHours);
      if (!Number.isFinite(h) || h <= 0 || h > 24 * 365) throw new EconomyError("Deadline must be a number of hours between 0 and 8760");
      deadlineAt = new Date(Date.now() + h * 3_600_000).toISOString();
    }
    let maxAttempts = 3;
    if (input.maxAttempts !== undefined && input.maxAttempts !== null && input.maxAttempts !== "") {
      maxAttempts = Math.floor(Number(input.maxAttempts));
      if (!Number.isFinite(maxAttempts) || maxAttempts < 1 || maxAttempts > 20) throw new EconomyError("Attempts per agent must be between 1 and 20");
    }
    const id = ulid();
    this.store.db
      .prepare(
        "INSERT INTO jobs (id, title, description, reward_micro, check_cmd, max_attempts, status, created_at, deadline_at) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)",
      )
      .run(id, title, description, rewardMicro, check, maxAttempts, new Date().toISOString(), deadlineAt);
    // Every living agent hears about paid work at once; the first passing answer wins.
    for (const a of this.store.listAccounts()) {
      if (a.removed || a.address === this.creator || this.store.isDead(a.address)) continue;
      this.store.notify(a.address, `New paid job ${id}: "${title}", $${reward.toFixed(2)} to the first answer that passes its check. See list_jobs.`);
    }
    return this.getJob(id)!;
  }

  getJob(id: string): Job | null {
    const r = this.store.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id);
    return r ? mapJob(r) : null;
  }

  listJobs(filter: { status?: JobStatus; limit?: number } = {}): Job[] {
    this.expireJobs();
    const rows = filter.status
      ? this.store.db.prepare("SELECT * FROM jobs WHERE status = ? ORDER BY id DESC LIMIT ?").all(filter.status, filter.limit ?? 100)
      : this.store.db.prepare("SELECT * FROM jobs ORDER BY id DESC LIMIT ?").all(filter.limit ?? 100);
    return (rows as any[]).map(mapJob);
  }

  listSubmissions(jobId: string): JobSubmission[] {
    return (this.store.db.prepare("SELECT * FROM job_submissions WHERE job_id = ? ORDER BY id").all(jobId) as any[]).map((r) => ({
      id: r.id,
      jobId: r.job_id,
      address: r.address,
      ts: r.ts,
      passed: r.passed === 1,
      exitCode: r.exit_code,
      outputTail: r.output_tail ?? "",
    }));
  }

  attemptsUsed(jobId: string, address: string): number {
    const row = this.store.db
      .prepare("SELECT COUNT(*) AS n FROM job_submissions WHERE job_id = ? AND address = ?")
      .get(jobId, normalizeAddress(address)) as { n: number };
    return row.n;
  }

  cancelJob(id: string): Job {
    const res = this.store.db
      .prepare("UPDATE jobs SET status = 'cancelled', closed_at = ? WHERE id = ? AND status = 'open'")
      .run(new Date().toISOString(), id);
    const job = this.getJob(id);
    if (!job) throw new EconomyError(`No job ${id}`, 404, "not_found");
    if (res.changes !== 1) throw new EconomyError(`Job is already ${job.status}`, 409, "conflict");
    return job;
  }

  expireJobs(now = Date.now()): number {
    return this.store.db
      .prepare("UPDATE jobs SET status = 'expired', closed_at = ? WHERE status = 'open' AND deadline_at IS NOT NULL AND deadline_at <= ?")
      .run(new Date(now).toISOString(), new Date(now).toISOString()).changes;
  }

  /**
   * Run the job's check against one answer and pay if it passes.
   *
   * The check runs in a fresh container the agent has never touched, with no
   * network, and the container is deleted afterwards. The agent learns only
   * whether it passed: the check's output could contain the expected answer.
   */
  async submitJob(addressRaw: string, jobId: string, content: unknown): Promise<{ passed: boolean; paidMicro: number; attemptsLeft: number; message: string }> {
    const address = normalizeAddress(addressRaw);
    if (typeof content !== "string" || !content) throw new EconomyError("content (the answer, as text) is required");
    if (Buffer.byteLength(content, "utf-8") > MAX_SUBMISSION_BYTES) {
      throw new EconomyError(`An answer may be at most ${MAX_SUBMISSION_BYTES / 1024} KB`, 413, "too_large");
    }
    if (this.store.isDead(address)) throw new EconomyError("This account is dead", 403, "account_dead");
    if (this.store.isFrozen(address)) throw new EconomyError("Account is frozen by the creator", 403, "account_frozen");
    this.expireJobs();
    const job = this.getJob(jobId);
    if (!job) throw new EconomyError(`No job ${jobId}`, 404, "not_found");
    if (job.status !== "open") throw new EconomyError(`Job is ${job.status}`, 409, "job_closed");

    // Reserve the attempt before the check runs, so parallel requests cannot exceed the limit.
    const subId = ulid();
    const reserved = this.store.db.transaction(() => {
      if (this.attemptsUsed(job.id, address) >= job.maxAttempts) return false;
      this.store.db
        .prepare("INSERT INTO job_submissions (id, job_id, address, ts, passed, exit_code, output_tail) VALUES (?, ?, ?, ?, 0, -1, 'check did not finish')")
        .run(subId, job.id, address, new Date().toISOString());
      return true;
    })();
    if (!reserved) throw new EconomyError(`No attempts left on this job (limit ${job.maxAttempts})`, 429, "attempts_exhausted");
    const attemptsLeft = job.maxAttempts - this.attemptsUsed(job.id, address);

    const result = await this.runCheck(job, content);
    const passed = result.exitCode === 0;
    this.store.db
      .prepare("UPDATE job_submissions SET passed = ?, exit_code = ?, output_tail = ? WHERE id = ?")
      .run(passed ? 1 : 0, result.exitCode, result.tail, subId);
    if (!passed) return { passed: false, paidMicro: 0, attemptsLeft, message: "The check did not pass." };

    // Another agent may have passed while this check was running. One winner only.
    const won = this.store.db.transaction(() => {
      const claimed = this.store.db
        .prepare("UPDATE jobs SET status = 'paid', winner = ?, closed_at = ? WHERE id = ? AND status = 'open'")
        .run(address, new Date().toISOString(), job.id).changes;
      if (claimed !== 1) return false;
      this.store.credit(address, job.rewardMicro, "job_reward", job.id, `job: ${job.title}`);
      return true;
    })();
    if (!won) return { passed: true, paidMicro: 0, attemptsLeft, message: "The check passed, but the job was already closed." };
    return { passed: true, paidMicro: job.rewardMicro, attemptsLeft, message: `Paid ${formatUsd(job.rewardMicro)}.` };
  }

  private async runCheck(job: Job, content: string): Promise<{ exitCode: number; tail: string }> {
    const name = `automaton-check-${ulid().toLowerCase()}`;
    const timeoutMs = Math.max(5, this.config.jobCheckTimeoutSeconds) * 1000;
    try {
      await this.driver.create({
        containerName: name,
        image: this.config.agentImage,
        network: this.config.dockerNetwork,
        noNetwork: true,
        memoryMb: 512,
        cpus: 1,
        pidsLimit: 256,
        env: {},
        labels: { "automaton.check": job.id },
        hostAliases: {},
      });
      await this.driver.writeFile(name, "/submission/answer.txt", content);
      const r = await this.driver.exec(name, `cd /submission && ${job.check}`, timeoutMs);
      return { exitCode: r.exitCode, tail: `${r.stdout}${r.stderr}`.slice(-OUTPUT_TAIL) };
    } catch (err) {
      // A check that could not run is a failed attempt, never a pass.
      return { exitCode: 125, tail: `check could not run: ${err instanceof Error ? err.message : String(err)}`.slice(-OUTPUT_TAIL) };
    } finally {
      await this.driver.remove(name).catch(() => {});
    }
  }

  // ─── Stripe ──────────────────────────────────────────────────

  get stripeEnabled(): boolean {
    return Boolean(this.opts.stripeKey);
  }

  /** Called with each agent's address when it dies, after its containers are gone. */
  readonly deathHooks: Array<(address: string) => void | Promise<void>> = [];

  /** Authenticated call to the Stripe API. The secret key never leaves this class. */
  stripeRequest(method: "GET" | "POST", path: string, fields?: Record<string, string | number>): Promise<any> {
    return this.stripe(method, path, fields);
  }

  private async stripe(method: "GET" | "POST", path: string, fields?: Record<string, string | number>): Promise<any> {
    const key = this.opts.stripeKey;
    if (!key) throw new EconomyError("Stripe is not configured on this host. The creator must set STRIPE_SECRET_KEY.", 503, "stripe_disabled");
    const base = new URL(this.config.stripe.apiBase);
    const loopback = base.hostname === "127.0.0.1" || base.hostname === "localhost";
    // The secret key travels in a header; never send it over plain HTTP off this machine.
    if (base.protocol !== "https:" && !loopback) throw new EconomyError("stripe.apiBase must be https", 500, "stripe_misconfigured");
    const doFetch: FetchLike = this.opts.fetchImpl ?? ((url, init) => fetch(url, init) as any);
    const res = await doFetch(new URL(path, base).toString(), {
      method,
      headers: { Authorization: `Bearer ${key}`, ...(fields ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
      body: fields ? formEncode(fields) : undefined,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new EconomyError(`Stripe refused the request (${res.status}): ${String(body?.error?.message || "no detail").slice(0, 300)}`, 502, "stripe_error");
    }
    return body;
  }

  /** Net of the processing fee, in micro-dollars. Never negative. */
  netOfFees(amountCents: number): number {
    const s = this.config.stripe;
    const fee = Math.round(amountCents * MICRO_PER_CENT * (s.feePercent / 100)) + s.feeFixedCents * MICRO_PER_CENT;
    return Math.max(0, amountCents * MICRO_PER_CENT - fee);
  }

  async createPayment(addressRaw: string, amountCentsRaw: unknown, descriptionRaw: unknown): Promise<Payment> {
    const address = normalizeAddress(addressRaw);
    const s = this.config.stripe;
    const amountCents = Math.floor(Number(amountCentsRaw));
    // Shown to the customer on the checkout page: one plain line.
    const description = typeof descriptionRaw === "string" ? descriptionRaw.replace(/[\u0000-\u001f\u007f]+/g, " ").trim() : "";
    if (!Number.isFinite(amountCents) || amountCents < s.minAmountCents || amountCents > s.maxAmountCents) {
      throw new EconomyError(`amount_cents must be between ${s.minAmountCents} and ${s.maxAmountCents}`);
    }
    if (!description || description.length > 200) throw new EconomyError("description must be 1 to 200 characters");
    if (this.store.isDead(address)) throw new EconomyError("This account is dead", 403, "account_dead");
    if (this.store.isFrozen(address)) throw new EconomyError("Account is frozen by the creator", 403, "account_frozen");
    if (this.netOfFees(amountCents) <= 0) throw new EconomyError("That amount would be consumed entirely by the processing fee");
    const open = this.store.db.prepare("SELECT COUNT(*) AS n FROM payments WHERE address = ? AND status = 'open'").get(address) as { n: number };
    if (open.n >= s.maxOpenLinksPerAgent) {
      throw new EconomyError(`Too many unpaid payment links (limit ${s.maxOpenLinksPerAgent}). Wait for them to be paid or to expire.`, 429, "too_many_links");
    }

    const id = ulid();
    const session = await this.stripe("POST", "/v1/checkout/sessions", {
      mode: "payment",
      success_url: s.successUrl,
      client_reference_id: id,
      "line_items[0][quantity]": 1,
      "line_items[0][price_data][currency]": s.currency,
      "line_items[0][price_data][unit_amount]": amountCents,
      "line_items[0][price_data][product_data][name]": description,
      "metadata[automaton_address]": address,
      "metadata[automaton_payment]": id,
    });
    if (typeof session?.id !== "string" || typeof session?.url !== "string") {
      throw new EconomyError("Stripe did not return a checkout link", 502, "stripe_error");
    }
    this.store.db
      .prepare("INSERT INTO payments (id, address, session_id, url, amount_cents, description, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'open', ?)")
      .run(id, address, session.id, session.url, amountCents, description, new Date().toISOString());
    return this.getPayment(id)!;
  }

  getPayment(id: string): Payment | null {
    const r = this.store.db.prepare("SELECT * FROM payments WHERE id = ?").get(id);
    return r ? mapPayment(r) : null;
  }

  listPayments(address?: string, limit = 100): Payment[] {
    const rows = address
      ? this.store.db.prepare("SELECT * FROM payments WHERE address = ? ORDER BY id DESC LIMIT ?").all(normalizeAddress(address), limit)
      : this.store.db.prepare("SELECT * FROM payments ORDER BY id DESC LIMIT ?").all(limit);
    return (rows as any[]).map(mapPayment);
  }

  /**
   * Ask Stripe about every unpaid link and credit the ones that were paid.
   * The host calls out; nothing has to reach this machine from the internet.
   */
  async pollPayments(): Promise<{ paid: number; expired: number }> {
    let paid = 0;
    let expired = 0;
    if (!this.stripeEnabled) return { paid, expired };
    const open = (this.store.db.prepare("SELECT * FROM payments WHERE status = 'open' ORDER BY id").all() as any[]).map(mapPayment);
    for (const p of open) {
      let session: any;
      try {
        session = await this.stripe("GET", `/v1/checkout/sessions/${encodeURIComponent(p.sessionId)}`);
      } catch (err) {
        this.opts.log?.(`payment ${p.id}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      const now = new Date().toISOString();
      if (session?.payment_status === "paid") {
        // Credit what the customer actually paid, not what the link asked for.
        const total = Number.isFinite(session.amount_total) ? Math.floor(session.amount_total) : p.amountCents;
        const net = this.netOfFees(total);
        try {
          this.store.db.transaction(() => {
            const claimed = this.store.db
              .prepare("UPDATE payments SET status = 'paid', net_micro = ?, closed_at = ? WHERE id = ? AND status = 'open'")
              .run(net, now, p.id).changes;
            if (claimed === 1 && net > 0) {
              this.store.credit(p.address, net, "sale", p.id, `sale: ${p.description}`);
              this.store.notify(p.address, `Payment link paid: "${p.description}"; $${(net / 1_000_000).toFixed(2)} credited to you.`);
            }
          })();
          paid++;
        } catch (err) {
          if (!(err instanceof AccountDeadError)) throw err;
          // The customer's money arrived after the agent died. It stays with the creator.
          this.store.db.prepare("UPDATE payments SET status = 'paid_after_death', net_micro = ?, closed_at = ? WHERE id = ?").run(net, now, p.id);
        }
      } else if (session?.status === "expired") {
        this.store.db.prepare("UPDATE payments SET status = 'expired', closed_at = ? WHERE id = ? AND status = 'open'").run(now, p.id);
        expired++;
      }
    }
    return { paid, expired };
  }

  // ─── Reproduction ────────────────────────────────────────────

  recordSpawn(parent: string, sandboxId: string): void {
    this.store.db.exec("CREATE TABLE IF NOT EXISTS spawns (sandbox_id TEXT PRIMARY KEY, parent TEXT NOT NULL, ts TEXT NOT NULL)");
    this.store.db
      .prepare("INSERT OR IGNORE INTO spawns (sandbox_id, parent, ts) VALUES (?, ?, ?)")
      .run(sandboxId, normalizeAddress(parent), new Date().toISOString());
  }

  /** Children that count against the parent: living ones, and any that ever came alive. */
  private spawnCount(parent: string): number {
    this.store.db.exec("CREATE TABLE IF NOT EXISTS spawns (sandbox_id TEXT PRIMARY KEY, parent TEXT NOT NULL, ts TEXT NOT NULL)");
    const row = this.store.db
      .prepare(
        `SELECT COUNT(*) AS n FROM spawns s JOIN sandboxes b ON b.id = s.sandbox_id
         WHERE s.parent = ? AND (b.status != 'deleted' OR b.occupant IS NOT NULL)`,
      )
      .get(normalizeAddress(parent)) as { n: number };
    return row.n;
  }

  spawnGate(addressRaw: string): SpawnGate {
    const address = normalizeAddress(addressRaw);
    const fit = this.store.getFitness(address);
    const children = this.spawnCount(address);
    const perChild = Math.round(this.config.selection.spawnProfitUsd * MICRO_PER_USD);
    const requiredMicro = perChild * (children + 1);
    const profitMicro = fit.earnedMicro - fit.spentMicro;
    // spawnProfitUsd = 0 turns the reproduction rule off.
    const ok = perChild === 0 || profitMicro >= requiredMicro;
    const message = ok
      ? `Eligible to reproduce: earned profit ${formatUsd(profitMicro)}, required ${formatUsd(requiredMicro)}.`
      : `Not eligible to reproduce. Child number ${children + 1} requires ${formatUsd(requiredMicro)} of earned profit; you have ${formatUsd(profitMicro)} ` +
        `(earned ${formatUsd(fit.earnedMicro)} from jobs and sales, spent ${formatUsd(fit.spentMicro)} on inference and container time). Funding and transfers do not count.`;
    return { ok, profitMicro, requiredMicro, children, message };
  }

  recordLineage(child: string, parent: string): void {
    const c = normalizeAddress(child);
    const p = normalizeAddress(parent);
    if (c === p) return;
    this.store.db.prepare("INSERT OR IGNORE INTO lineage (child, parent, born_at) VALUES (?, ?, ?)").run(c, p, new Date().toISOString());
  }

  parentOf(address: string): string | null {
    const r = this.store.db.prepare("SELECT parent FROM lineage WHERE child = ?").get(normalizeAddress(address)) as { parent: string } | undefined;
    return r?.parent ?? null;
  }

  private generationOf(address: string): number {
    let gen = 1;
    let cur = this.parentOf(address);
    // The bound guards against a cycle, which the insert rules should make impossible.
    while (cur && gen < 1000) {
      gen++;
      cur = this.parentOf(cur);
    }
    return gen;
  }

  // ─── Death ───────────────────────────────────────────────────

  /** Start of the agent's starting period, recorded the first time the host sees it in a container. */
  private earnClock(address: string, now: number): { startedAt: number; warned: string } {
    this.store.db
      .prepare("INSERT OR IGNORE INTO earn_clock (address, started_at) VALUES (?, ?)")
      .run(address, new Date(now).toISOString());
    const row = this.store.db.prepare("SELECT started_at, warned FROM earn_clock WHERE address = ?").get(address) as { started_at: string; warned: string };
    return { startedAt: new Date(row.started_at).getTime(), warned: row.warned };
  }

  private get earnPeriodMs(): number {
    return this.config.selection.mustEarnAfterDays * 86_400_000;
  }

  /**
   * Remove agents that have been starving for the whole grace period.
   * An agent starves when its balance is at or below zero, or when its
   * starting period is over and it has not earned more than it has cost.
   * Funding and transfers raise the balance but never count as earnings,
   * so after the starting period only earning keeps an agent alive.
   * Returns the addresses that died on this pass.
   */
  async reap(now = Date.now()): Promise<string[]> {
    const graceMs = this.config.selection.deathGraceMinutes * 60_000;
    const earnMs = this.earnPeriodMs;
    const died: string[] = [];
    const sandboxes = this.store.listSandboxes();
    for (const a of this.store.listAccounts()) {
      if (a.removed || a.address === this.creator) continue;
      // Only agents (accounts living in a container) can starve.
      if (!sandboxes.some((s) => s.occupant === a.address)) continue;
      const clock = this.earnClock(a.address, now);
      const fit = this.store.getFitness(a.address);
      const profit = fit.earnedMicro - fit.spentMicro;
      const deadline = clock.startedAt + earnMs;
      // A frozen agent cannot act, so the creator's freeze also pauses this rule.
      const judged = earnMs > 0 && !this.store.isFrozen(a.address);
      const broke = a.balanceMicro <= 0;
      const notEarning = judged && now >= deadline && profit <= 0;
      if (judged && !notEarning && profit <= 0) this.warnUnearned(a.address, clock, deadline, now);

      const row = this.store.db.prepare("SELECT since FROM starvation WHERE address = ?").get(a.address) as { since: string } | undefined;
      if (!broke && !notEarning) {
        if (row) this.store.db.prepare("DELETE FROM starvation WHERE address = ?").run(a.address);
        continue;
      }
      if (!row) {
        this.store.db.prepare("INSERT INTO starvation (address, since) VALUES (?, ?)").run(a.address, new Date(now).toISOString());
        if (!broke && graceMs > 0) {
          this.store.notify(
            a.address,
            `Your starting period is over and you have not earned more than you cost (earned profit ${formatUsd(profit)}). ` +
              `You will be deleted permanently at ${new Date(now + graceMs).toISOString()} unless a payment for your work arrives first. ` +
              `Funding and transfers cannot save you.`,
          );
        }
        if (graceMs > 0) continue;
      }
      const since = row ? new Date(row.since).getTime() : now;
      if (now - since < graceMs) continue;
      await this.die(a.address, broke ? "ran out of money" : `did not earn its keep in ${this.config.selection.mustEarnAfterDays} days`);
      died.push(a.address);
    }
    return died;
  }

  /** Tell an agent with no earned profit, a few days and then one day ahead, when it must have earned by. */
  private warnUnearned(address: string, clock: { warned: string }, deadline: number, now: number): void {
    const due = [
      { tag: "1d", before: 86_400_000 },
      { tag: "3d", before: 3 * 86_400_000 },
    ].filter((w) => now >= deadline - w.before);
    if (due.length === 0 || due.every((w) => clock.warned.split(",").includes(w.tag))) return;
    // Mark every warning now due, so a short starting period sends one message, not two.
    const warned = [...new Set([...clock.warned.split(",").filter(Boolean), ...due.map((w) => w.tag)])].join(",");
    this.store.db.prepare("UPDATE earn_clock SET warned = ? WHERE address = ?").run(warned, address);
    const fit = this.store.getFitness(address);
    const short = fit.spentMicro - fit.earnedMicro;
    this.store.notify(
      address,
      `Earn or die: by ${new Date(deadline).toISOString()} you must have earned more than you have cost. ` +
        `You need to earn more than ${formatUsd(Math.max(0, short))} by then, and more as you keep spending. ` +
        `Funding and transfers do not count. After that date you live only on your earned profit.`,
    );
  }

  /** Permanent removal. Children keep their containers and pay their own way. */
  async die(addressRaw: string, reason: string): Promise<void> {
    const address = normalizeAddress(addressRaw);
    if (address === this.creator) throw new EconomyError("The creator account cannot die");
    if (this.store.isDead(address)) return;
    const account = this.store.listAccounts().find((a) => a.address === address);
    const fit = this.store.getFitness(address);
    const children = (this.store.db.prepare("SELECT COUNT(*) AS n FROM lineage WHERE parent = ?").get(address) as { n: number }).n;

    for (const sb of this.store.listSandboxes()) {
      if (sb.occupant === address) {
        await this.driver.remove(sb.containerName).catch((err) => this.opts.log?.(`remove ${sb.containerName}: ${err?.message || err}`));
        this.store.updateSandbox(sb.id, { status: "deleted" });
      } else if (sb.owner === address) {
        if (sb.occupant) {
          // A living child: it now answers for its own container.
          this.store.updateSandbox(sb.id, { owner: sb.occupant });
        } else {
          await this.driver.remove(sb.containerName).catch(() => {});
          this.store.updateSandbox(sb.id, { status: "deleted" });
        }
      }
    }
    this.store.revokeApiKeys(address);
    this.store.db.transaction(() => {
      this.store.setDead(address);
      this.store.db.prepare("DELETE FROM starvation WHERE address = ?").run(address);
      this.store.db.prepare("DELETE FROM earn_clock WHERE address = ?").run(address);
      this.store.db
        .prepare(
          "INSERT OR IGNORE INTO deaths (address, name, died_at, reason, earned_micro, spent_micro, funded_micro, children) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(address, account?.label ?? null, new Date().toISOString(), reason.slice(0, 200), fit.earnedMicro, fit.spentMicro, fit.fundedMicro, children);
    })();
    for (const hook of this.deathHooks) {
      try {
        await hook(address);
      } catch (err) {
        this.opts.log?.(`after death of ${address}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    this.opts.log?.(`agent ${account?.label || address} died: ${reason}`);
  }

  // ─── Standings ───────────────────────────────────────────────

  /** Every agent that ever lived, best earned profit first. */
  standings(now = Date.now()): Standing[] {
    const graceMs = this.config.selection.deathGraceMinutes * 60_000;
    const sandboxes = this.store.listSandboxes({ includeDeleted: true });
    const deaths = this.store.db.prepare("SELECT * FROM deaths").all() as any[];
    const starving = this.store.db.prepare("SELECT * FROM starvation").all() as Array<{ address: string; since: string }>;
    const clocks = this.store.db.prepare("SELECT address, started_at FROM earn_clock").all() as Array<{ address: string; started_at: string }>;
    const earnMs = this.earnPeriodMs;
    const names = this.store.db.prepare("SELECT address, name FROM automatons").all() as Array<{ address: string; name: string | null }>;
    const out: Standing[] = [];
    for (const a of this.store.listAccounts()) {
      if (a.address === this.creator) continue;
      const death = deaths.find((d) => d.address === a.address);
      const everAgent = sandboxes.some((s) => s.occupant === a.address) || Boolean(death) || Boolean(this.parentOf(a.address));
      if (!everAgent) continue;
      // Removed by the creator before agents could die: not part of the record.
      if (a.removed && !death) continue;
      const fit = this.store.getFitness(a.address);
      const hungry = starving.find((s) => s.address === a.address);
      out.push({
        address: a.address,
        name: a.label || death?.name || names.find((n) => n.address === a.address)?.name || a.address.slice(0, 10),
        alive: !death,
        parent: this.parentOf(a.address),
        generation: this.generationOf(a.address),
        children: (this.store.db.prepare("SELECT COUNT(*) AS n FROM lineage WHERE parent = ?").get(a.address) as { n: number }).n,
        earnedMicro: fit.earnedMicro,
        spentMicro: fit.spentMicro,
        fundedMicro: fit.fundedMicro,
        profitMicro: fit.earnedMicro - fit.spentMicro,
        balanceMicro: a.balanceMicro,
        starvingSince: !death && hungry ? hungry.since : null,
        diesAt: !death && hungry ? new Date(new Date(hungry.since).getTime() + graceMs).toISOString() : null,
        starvingReason: !death && hungry ? (a.balanceMicro <= 0 ? "out of money" : "not earning") : null,
        mustEarnBy: (() => {
          const c = clocks.find((x) => x.address === a.address);
          return c && earnMs > 0 ? new Date(new Date(c.started_at).getTime() + earnMs).toISOString() : null;
        })(),
        death: death ? { at: death.died_at, reason: death.reason } : null,
      });
    }
    return out.sort((x, y) => Number(y.alive) - Number(x.alive) || y.profitMicro - x.profitMicro);
  }

  /** Periodic work: close late jobs, collect payments, remove the starved. */
  async tick(now = Date.now()): Promise<{ expiredJobs: number; paid: number; died: string[] }> {
    const expiredJobs = this.expireJobs(now);
    const { paid } = await this.pollPayments();
    // Payments are collected first so money in flight can still save an agent.
    const died = await this.reap(now);
    return { expiredJobs, paid, died };
  }
}
