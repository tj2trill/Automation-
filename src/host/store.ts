/**
 * Host Control Plane — Store & Ledger
 *
 * SQLite state for the host: accounts, the append-only ledger, API keys,
 * sandboxes, registrations and the message relay.
 *
 * Money is stored as integer micro-dollars (1e-6 USD). Inference calls cost
 * fractions of a cent, so integer cents would either round every call to
 * zero (free inference) or up to one cent (10-100x overcharge). The Conway
 * wire format is cents, so cents are derived at the API boundary only.
 *
 * Every balance change goes through `applyEntry` inside a transaction that
 * writes the ledger row and the new balance together, so the balance is
 * always the sum of the ledger and can be audited with `verifyLedger`.
 */

import Database from "better-sqlite3";
import { createHash, randomBytes } from "crypto";
import fs from "fs";
import path from "path";
import { monotonicFactory } from "ulid";

// Ids double as sort keys and relay cursors. Plain ulid() is random within a
// millisecond, so two rows written in the same millisecond could sort in
// either order; the monotonic factory guarantees increasing ids.
const ulid = monotonicFactory();

export const MICRO_PER_CENT = 10_000;
export const MICRO_PER_USD = 1_000_000;

export type LedgerKind =
  | "topup" // creator added funds (CLI only — no network path reaches this)
  | "inference"
  | "compute"
  | "transfer_out"
  | "transfer_in"
  | "adjustment"
  | "job_reward" // paid by the creator for a job whose check passed
  | "sale" // a customer paid through Stripe
  | "refund"; // the creator refunded a customer; taken back from the agent

/**
 * Money that entered from outside the agent population, net of refunds.
 * Transfers between agents are not earnings.
 */
export const EARNED_KINDS = ["job_reward", "sale", "refund"] as const;

export interface LedgerEntry {
  id: string;
  ts: string;
  address: string;
  deltaMicro: number;
  balanceAfterMicro: number;
  kind: LedgerKind;
  ref: string | null;
  note: string | null;
}

export interface SpendByKindMicro {
  inferenceMicro: number;
  computeMicro: number;
  sentMicro: number;
}

export interface CreditReceived {
  id: string;
  ts: string;
  amountMicro: number;
  kind: "topup" | "transfer_in" | "job_reward" | "sale";
  /** Sending account for a transfer; null otherwise. */
  from: string | null;
}

export interface SandboxRow {
  id: string;
  owner: string;
  /** Address of the automaton living in it, once known. */
  occupant: string | null;
  name: string;
  containerName: string;
  status: string;
  vcpu: number;
  memoryMb: number;
  diskGb: number;
  createdAt: string;
  lastBilledAt: string;
}

export class InsufficientFundsError extends Error {
  constructor(
    public readonly address: string,
    public readonly balanceMicro: number,
    public readonly neededMicro: number,
  ) {
    super(
      `Insufficient credits: balance ${formatUsd(balanceMicro)}, needed ${formatUsd(neededMicro)}`,
    );
    this.name = "InsufficientFundsError";
  }
}

export class AccountFrozenError extends Error {
  constructor(public readonly address: string) {
    super(`Account ${address} is frozen by the creator`);
    this.name = "AccountFrozenError";
  }
}

export class AccountDeadError extends Error {
  constructor(public readonly address: string) {
    super(`Account ${address} is dead. Dead agents cannot receive money or be revived.`);
    this.name = "AccountDeadError";
  }
}

export function formatUsd(micro: number): string {
  const sign = micro < 0 ? "-" : "";
  return `${sign}$${(Math.abs(micro) / MICRO_PER_USD).toFixed(4)}`;
}

export function microToCents(micro: number): number {
  // Floor toward -infinity so a slightly negative balance reads as negative
  // cents (the runtime treats negative as "dead") and a positive sub-cent
  // balance reads as 0 (critical), never as more than the agent has.
  return Math.floor(micro / MICRO_PER_CENT);
}

/** EVM addresses are case-insensitive; store them lowercased. */
export function normalizeAddress(address: string): string {
  const a = (address || "").trim();
  return /^0x[a-fA-F0-9]{40}$/.test(a) ? a.toLowerCase() : a;
}

export function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  address        TEXT PRIMARY KEY,
  balance_micro  INTEGER NOT NULL DEFAULT 0,
  frozen         INTEGER NOT NULL DEFAULT 0,
  removed        INTEGER NOT NULL DEFAULT 0,
  label          TEXT,
  created_at     TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ledger (
  id                  TEXT PRIMARY KEY,
  ts                  TEXT NOT NULL,
  address             TEXT NOT NULL,
  delta_micro         INTEGER NOT NULL,
  balance_after_micro INTEGER NOT NULL,
  kind                TEXT NOT NULL,
  ref                 TEXT,
  note                TEXT
);
CREATE INDEX IF NOT EXISTS ledger_address_ts ON ledger(address, ts);
CREATE TABLE IF NOT EXISTS api_keys (
  key_hash    TEXT PRIMARY KEY,
  key_prefix  TEXT NOT NULL,
  address     TEXT NOT NULL,
  name        TEXT,
  created_at  TEXT NOT NULL,
  revoked     INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS auth_nonces (
  nonce       TEXT PRIMARY KEY,
  expires_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash  TEXT PRIMARY KEY,
  address     TEXT NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sandboxes (
  id              TEXT PRIMARY KEY,
  owner           TEXT NOT NULL,
  occupant        TEXT,
  name            TEXT NOT NULL,
  container_name  TEXT NOT NULL,
  status          TEXT NOT NULL,
  vcpu            REAL NOT NULL,
  memory_mb       INTEGER NOT NULL,
  disk_gb         INTEGER NOT NULL,
  created_at      TEXT NOT NULL,
  last_billed_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS automatons (
  automaton_id  TEXT PRIMARY KEY,
  address       TEXT NOT NULL,
  creator       TEXT,
  name          TEXT,
  payload       TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY,
  from_addr   TEXT NOT NULL,
  to_addr     TEXT NOT NULL,
  content     TEXT NOT NULL,
  signed_at   TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  reply_to    TEXT
);
CREATE INDEX IF NOT EXISTS messages_to ON messages(to_addr, id);
CREATE TABLE IF NOT EXISTS relay_cursors (
  address       TEXT PRIMARY KEY,
  delivered_id  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  description   TEXT NOT NULL,
  reward_micro  INTEGER NOT NULL,
  check_cmd     TEXT NOT NULL,
  max_attempts  INTEGER NOT NULL,
  status        TEXT NOT NULL,
  winner        TEXT,
  created_at    TEXT NOT NULL,
  deadline_at   TEXT,
  closed_at     TEXT
);
CREATE TABLE IF NOT EXISTS job_submissions (
  id          TEXT PRIMARY KEY,
  job_id      TEXT NOT NULL,
  address     TEXT NOT NULL,
  ts          TEXT NOT NULL,
  passed      INTEGER NOT NULL,
  exit_code   INTEGER NOT NULL,
  output_tail TEXT
);
CREATE INDEX IF NOT EXISTS job_submissions_job ON job_submissions(job_id, address);
CREATE TABLE IF NOT EXISTS payments (
  id            TEXT PRIMARY KEY,
  address       TEXT NOT NULL,
  session_id    TEXT NOT NULL UNIQUE,
  url           TEXT NOT NULL,
  amount_cents  INTEGER NOT NULL,
  description   TEXT NOT NULL,
  status        TEXT NOT NULL,
  net_micro     INTEGER,
  created_at    TEXT NOT NULL,
  closed_at     TEXT
);
CREATE TABLE IF NOT EXISTS lineage (
  child     TEXT PRIMARY KEY,
  parent    TEXT NOT NULL,
  born_at   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS starvation (
  address  TEXT PRIMARY KEY,
  since    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS deaths (
  address        TEXT PRIMARY KEY,
  name           TEXT,
  died_at        TEXT NOT NULL,
  reason         TEXT NOT NULL,
  earned_micro   INTEGER NOT NULL,
  spent_micro    INTEGER NOT NULL,
  funded_micro   INTEGER NOT NULL,
  children       INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS usage (
  id             TEXT PRIMARY KEY,
  ts             TEXT NOT NULL,
  address        TEXT NOT NULL,
  model          TEXT NOT NULL,
  upstream       TEXT NOT NULL,
  input_tokens   INTEGER NOT NULL,
  output_tokens  INTEGER NOT NULL,
  cost_micro     INTEGER NOT NULL
);
`;

export class HostStore {
  readonly db: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
    }
    this.db = new Database(dbPath);
    // WAL lets the CLI (fund/kill/ps) write while the server is running.
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(SCHEMA);
    // Databases created before agents could die lack the column.
    const cols = this.db.prepare("PRAGMA table_info(accounts)").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "dead")) this.db.exec("ALTER TABLE accounts ADD COLUMN dead INTEGER NOT NULL DEFAULT 0");
  }

  close(): void {
    this.db.close();
  }

  // ─── Accounts & ledger ───────────────────────────────────────

  ensureAccount(address: string, label?: string): void {
    const a = normalizeAddress(address);
    this.db
      .prepare(
        "INSERT INTO accounts (address, balance_micro, frozen, label, created_at) VALUES (?, 0, 0, ?, ?) ON CONFLICT(address) DO NOTHING",
      )
      .run(a, label ?? null, new Date().toISOString());
    if (label) {
      this.db
        .prepare("UPDATE accounts SET label = ? WHERE address = ? AND label IS NULL")
        .run(label, a);
    }
  }

  getBalanceMicro(address: string): number {
    const row = this.db
      .prepare("SELECT balance_micro FROM accounts WHERE address = ?")
      .get(normalizeAddress(address)) as { balance_micro: number } | undefined;
    return row?.balance_micro ?? 0;
  }

  isFrozen(address: string): boolean {
    const row = this.db
      .prepare("SELECT frozen FROM accounts WHERE address = ?")
      .get(normalizeAddress(address)) as { frozen: number } | undefined;
    return row?.frozen === 1;
  }

  isDead(address: string): boolean {
    const row = this.db
      .prepare("SELECT dead FROM accounts WHERE address = ?")
      .get(normalizeAddress(address)) as { dead: number } | undefined;
    return row?.dead === 1;
  }

  /** Permanent. Nothing in the host clears this flag. */
  setDead(address: string): void {
    this.db.prepare("UPDATE accounts SET dead = 1, removed = 1, frozen = 1 WHERE address = ?").run(normalizeAddress(address));
  }

  setFrozen(address: string, frozen: boolean): void {
    this.ensureAccount(address);
    this.db
      .prepare("UPDATE accounts SET frozen = ? WHERE address = ?")
      .run(frozen ? 1 : 0, normalizeAddress(address));
  }

  listAccounts(): Array<{ address: string; balanceMicro: number; frozen: boolean; removed: boolean; label: string | null }> {
    return (
      this.db
        .prepare("SELECT address, balance_micro, frozen, removed, label FROM accounts ORDER BY created_at")
        .all() as any[]
    ).map((r) => ({
      address: r.address,
      balanceMicro: r.balance_micro,
      frozen: r.frozen === 1,
      removed: r.removed === 1,
      label: r.label,
    }));
  }

  /** Removed accounts keep their ledger history but release their name. */
  findAccountByLabel(label: string): string | null {
    const row = this.db
      .prepare("SELECT address FROM accounts WHERE label = ? AND removed = 0 ORDER BY created_at DESC LIMIT 1")
      .get(label) as { address: string } | undefined;
    return row?.address ?? null;
  }

  setRemoved(address: string): void {
    this.db.prepare("UPDATE accounts SET removed = 1, frozen = 1 WHERE address = ?").run(normalizeAddress(address));
  }

  /** Must be called inside a transaction. */
  private applyEntry(
    address: string,
    deltaMicro: number,
    kind: LedgerKind,
    ref?: string | null,
    note?: string | null,
  ): LedgerEntry {
    if (!Number.isSafeInteger(deltaMicro)) {
      throw new Error(`Ledger delta must be a safe integer, got ${deltaMicro}`);
    }
    const a = normalizeAddress(address);
    this.ensureAccount(a);
    const before = this.getBalanceMicro(a);
    const after = before + deltaMicro;
    this.db.prepare("UPDATE accounts SET balance_micro = ? WHERE address = ?").run(after, a);
    const entry: LedgerEntry = {
      id: ulid(),
      ts: new Date().toISOString(),
      address: a,
      deltaMicro,
      balanceAfterMicro: after,
      kind,
      ref: ref ?? null,
      note: note ?? null,
    };
    this.db
      .prepare(
        "INSERT INTO ledger (id, ts, address, delta_micro, balance_after_micro, kind, ref, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(entry.id, entry.ts, a, deltaMicro, after, kind, entry.ref, entry.note);
    return entry;
  }

  /** Creator adds funds. Only reachable from the host CLI. */
  topup(address: string, amountMicro: number, note?: string): LedgerEntry {
    if (amountMicro <= 0) throw new Error("Top-up amount must be positive");
    if (this.isDead(address)) throw new AccountDeadError(normalizeAddress(address));
    return this.db.transaction(() => this.applyEntry(address, amountMicro, "topup", null, note))();
  }

  /**
   * Money earned from outside the agent population: a job reward or a
   * customer payment. `ref` is the job or payment id, and one ref pays once.
   */
  credit(address: string, amountMicro: number, kind: "job_reward" | "sale", ref: string, note?: string): LedgerEntry {
    if (!Number.isSafeInteger(amountMicro) || amountMicro <= 0) throw new Error("Credit amount must be a positive integer");
    return this.db.transaction(() => {
      if (this.isDead(address)) throw new AccountDeadError(normalizeAddress(address));
      const dup = this.db.prepare("SELECT 1 FROM ledger WHERE kind = ? AND ref = ?").get(kind, ref);
      if (dup) throw new Error(`${kind} ${ref} has already been paid`);
      return this.applyEntry(address, amountMicro, kind, ref, note);
    })();
  }

  /**
   * Take a refunded sale back from the agent. May push the balance below
   * zero: the agent spent money it turned out not to have earned.
   */
  debitRefund(address: string, amountMicro: number, ref: string, note?: string): LedgerEntry | null {
    if (!Number.isSafeInteger(amountMicro) || amountMicro <= 0) return null;
    return this.db.transaction(() => {
      if (this.isDead(address)) return null;
      if (this.db.prepare("SELECT 1 FROM ledger WHERE kind = 'refund' AND ref = ?").get(ref)) throw new Error(`refund ${ref} already taken`);
      return this.applyEntry(address, -amountMicro, "refund", ref, note);
    })();
  }

  /** Lifetime totals used for selection: what an account earned outside, spent on itself, and was given. */
  getFitness(address: string): { earnedMicro: number; spentMicro: number; fundedMicro: number } {
    const rows = this.db
      .prepare("SELECT kind, COALESCE(SUM(delta_micro), 0) AS total FROM ledger WHERE address = ? GROUP BY kind")
      .all(normalizeAddress(address)) as Array<{ kind: string; total: number }>;
    const of = (k: string) => rows.find((r) => r.kind === k)?.total ?? 0;
    return {
      // Refund rows are negative: a refunded sale was never really earned.
      earnedMicro: of("job_reward") + of("sale") + of("refund"),
      spentMicro: -(of("inference") + of("compute")),
      fundedMicro: of("topup") + of("transfer_in"),
    };
  }

  /** Creator correction (may be negative). Only reachable from the host CLI. */
  adjust(address: string, deltaMicro: number, note?: string): LedgerEntry {
    return this.db.transaction(() => this.applyEntry(address, deltaMicro, "adjustment", null, note))();
  }

  /**
   * Charge for usage that has ALREADY been consumed (inference tokens,
   * compute time). The cost is real whether or not the account can cover it,
   * so this never refuses — the balance may go negative, which the runtime
   * reads as "dead". Refusal happens before consumption, via `canSpend`.
   */
  charge(address: string, costMicro: number, kind: "inference" | "compute", ref?: string, note?: string): LedgerEntry | null {
    if (costMicro <= 0) return null;
    return this.db.transaction(() => this.applyEntry(address, -costMicro, kind, ref, note))();
  }

  /** Pre-flight gate for anything that will cost money. */
  canSpend(address: string): { ok: true } | { ok: false; reason: "frozen" | "insufficient"; balanceMicro: number } {
    const balanceMicro = this.getBalanceMicro(address);
    if (this.isFrozen(address)) return { ok: false, reason: "frozen", balanceMicro };
    if (balanceMicro <= 0) return { ok: false, reason: "insufficient", balanceMicro };
    return { ok: true };
  }

  /** Move credits between accounts. Refuses overdraft and frozen senders. */
  transfer(from: string, to: string, amountMicro: number, note?: string): { transferId: string; balanceAfterMicro: number } {
    if (!Number.isSafeInteger(amountMicro) || amountMicro <= 0) {
      throw new Error("Transfer amount must be a positive integer");
    }
    const src = normalizeAddress(from);
    const dst = normalizeAddress(to);
    if (src === dst) throw new Error("Cannot transfer to self");
    return this.db.transaction(() => {
      if (this.isFrozen(src)) throw new AccountFrozenError(src);
      if (this.isDead(dst)) throw new AccountDeadError(dst);
      const balance = this.getBalanceMicro(src);
      if (balance < amountMicro) throw new InsufficientFundsError(src, balance, amountMicro);
      const transferId = ulid();
      const out = this.applyEntry(src, -amountMicro, "transfer_out", transferId, note ?? `to ${dst}`);
      this.applyEntry(dst, amountMicro, "transfer_in", transferId, note ?? `from ${src}`);
      return { transferId, balanceAfterMicro: out.balanceAfterMicro };
    })();
  }

  /**
   * Money that arrived in an account, oldest first, after ledger id `afterId`.
   * Ledger ids are ULIDs, so they sort by time and serve as a cursor.
   *
   * For a transfer the sender is looked up from the matching transfer_out
   * row. The note is deliberately not returned: the sender writes it, and
   * the receiving agent would read it.
   */
  getCreditsReceived(address: string, afterId = "", limit = 100): CreditReceived[] {
    const rows = this.db
      .prepare(
        `SELECT l.id, l.ts, l.delta_micro, l.kind,
                (SELECT o.address FROM ledger o WHERE o.ref = l.ref AND o.kind = 'transfer_out' LIMIT 1) AS sender
         FROM ledger l
         WHERE l.address = ? AND l.id > ? AND l.delta_micro > 0 AND l.kind IN ('topup', 'transfer_in', 'job_reward', 'sale')
         ORDER BY l.id ASC LIMIT ?`,
      )
      .all(normalizeAddress(address), afterId, Math.max(1, Math.min(500, Math.floor(limit) || 100)));
    return (rows as any[]).map((r) => ({
      id: r.id,
      ts: r.ts,
      amountMicro: r.delta_micro,
      kind: r.kind,
      from: r.kind === "transfer_in" ? (r.sender ?? null) : null,
    }));
  }

  /**
   * What an account spent, by kind, in micro-dollars: from `sinceIso` on, and
   * since the account was opened. Every debit kind is counted, so the three
   * figures add up to everything that left the account.
   */
  getSpendSummary(address: string, sinceIso: string): { period: SpendByKindMicro; lifetime: SpendByKindMicro } {
    const a = normalizeAddress(address);
    const sum = (since: string): SpendByKindMicro => {
      const rows = this.db
        .prepare("SELECT kind, COALESCE(SUM(-delta_micro), 0) AS total FROM ledger WHERE address = ? AND delta_micro < 0 AND ts >= ? GROUP BY kind")
        .all(a, since) as Array<{ kind: string; total: number }>;
      const out: SpendByKindMicro = { inferenceMicro: 0, computeMicro: 0, sentMicro: 0 };
      for (const r of rows) {
        if (r.kind === "inference") out.inferenceMicro += r.total;
        else if (r.kind === "compute") out.computeMicro += r.total;
        // transfer_out and any debit kind added later: money that left for somewhere else.
        else out.sentMicro += r.total;
      }
      return out;
    };
    return { period: sum(sinceIso), lifetime: sum("") };
  }

  getLedger(address?: string, limit = 50): LedgerEntry[] {
    const rows = address
      ? this.db
          .prepare("SELECT * FROM ledger WHERE address = ? ORDER BY id DESC LIMIT ?")
          .all(normalizeAddress(address), limit)
      : this.db.prepare("SELECT * FROM ledger ORDER BY id DESC LIMIT ?").all(limit);
    return (rows as any[]).map((r) => ({
      id: r.id,
      ts: r.ts,
      address: r.address,
      deltaMicro: r.delta_micro,
      balanceAfterMicro: r.balance_after_micro,
      kind: r.kind,
      ref: r.ref,
      note: r.note,
    }));
  }

  /** Audit: every account balance must equal the sum of its ledger rows. */
  verifyLedger(): Array<{ address: string; balanceMicro: number; ledgerSumMicro: number }> {
    const rows = this.db
      .prepare(
        `SELECT a.address AS address, a.balance_micro AS balance,
                COALESCE((SELECT SUM(delta_micro) FROM ledger l WHERE l.address = a.address), 0) AS total
         FROM accounts a`,
      )
      .all() as Array<{ address: string; balance: number; total: number }>;
    return rows
      .filter((r) => r.balance !== r.total)
      .map((r) => ({ address: r.address, balanceMicro: r.balance, ledgerSumMicro: r.total }));
  }

  recordUsage(u: { address: string; model: string; upstream: string; inputTokens: number; outputTokens: number; costMicro: number }): string {
    const id = ulid();
    this.db
      .prepare(
        "INSERT INTO usage (id, ts, address, model, upstream, input_tokens, output_tokens, cost_micro) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(id, new Date().toISOString(), normalizeAddress(u.address), u.model, u.upstream, u.inputTokens, u.outputTokens, u.costMicro);
    return id;
  }

  // ─── Auth ────────────────────────────────────────────────────

  createNonce(ttlMs = 5 * 60_000): string {
    const nonce = randomBytes(16).toString("hex");
    this.db.prepare("DELETE FROM auth_nonces WHERE expires_at < ?").run(Date.now());
    this.db.prepare("INSERT INTO auth_nonces (nonce, expires_at) VALUES (?, ?)").run(nonce, Date.now() + ttlMs);
    return nonce;
  }

  /** Single use: a nonce is deleted the moment it is checked. */
  consumeNonce(nonce: string): boolean {
    const res = this.db
      .prepare("DELETE FROM auth_nonces WHERE nonce = ? AND expires_at >= ?")
      .run(nonce, Date.now());
    return res.changes === 1;
  }

  createSession(address: string, ttlMs = 10 * 60_000): string {
    const token = `atm_s_${randomBytes(24).toString("hex")}`;
    this.db.prepare("DELETE FROM auth_sessions WHERE expires_at < ?").run(Date.now());
    this.db
      .prepare("INSERT INTO auth_sessions (token_hash, address, expires_at) VALUES (?, ?, ?)")
      .run(hashKey(token), normalizeAddress(address), Date.now() + ttlMs);
    return token;
  }

  resolveSession(token: string): string | null {
    const row = this.db
      .prepare("SELECT address FROM auth_sessions WHERE token_hash = ? AND expires_at >= ?")
      .get(hashKey(token), Date.now()) as { address: string } | undefined;
    return row?.address ?? null;
  }

  /** Only the SHA-256 of a key is stored; the plaintext is returned once. */
  createApiKey(address: string, name?: string): { key: string; keyPrefix: string } {
    const key = `atm_k_${randomBytes(24).toString("hex")}`;
    const keyPrefix = key.slice(0, 12);
    this.ensureAccount(address);
    this.db
      .prepare("INSERT INTO api_keys (key_hash, key_prefix, address, name, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(hashKey(key), keyPrefix, normalizeAddress(address), name ?? null, new Date().toISOString());
    return { key, keyPrefix };
  }

  resolveApiKey(key: string): string | null {
    const row = this.db
      .prepare("SELECT address FROM api_keys WHERE key_hash = ? AND revoked = 0")
      .get(hashKey(key)) as { address: string } | undefined;
    return row?.address ?? null;
  }

  revokeApiKeys(address: string): number {
    return this.db
      .prepare("UPDATE api_keys SET revoked = 1 WHERE address = ? AND revoked = 0")
      .run(normalizeAddress(address)).changes;
  }

  // ─── Sandboxes ───────────────────────────────────────────────

  insertSandbox(row: SandboxRow): void {
    this.db
      .prepare(
        `INSERT INTO sandboxes (id, owner, occupant, name, container_name, status, vcpu, memory_mb, disk_gb, created_at, last_billed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id, normalizeAddress(row.owner), row.occupant ? normalizeAddress(row.occupant) : null,
        row.name, row.containerName, row.status, row.vcpu, row.memoryMb, row.diskGb, row.createdAt, row.lastBilledAt,
      );
  }

  private mapSandbox(r: any): SandboxRow {
    return {
      id: r.id,
      owner: r.owner,
      occupant: r.occupant,
      name: r.name,
      containerName: r.container_name,
      status: r.status,
      vcpu: r.vcpu,
      memoryMb: r.memory_mb,
      diskGb: r.disk_gb,
      createdAt: r.created_at,
      lastBilledAt: r.last_billed_at,
    };
  }

  getSandbox(id: string): SandboxRow | null {
    const r = this.db.prepare("SELECT * FROM sandboxes WHERE id = ?").get(id);
    return r ? this.mapSandbox(r) : null;
  }

  listSandboxes(filter?: { owner?: string; includeDeleted?: boolean }): SandboxRow[] {
    let rows = this.db.prepare("SELECT * FROM sandboxes ORDER BY created_at").all() as any[];
    if (!filter?.includeDeleted) rows = rows.filter((r) => r.status !== "deleted");
    if (filter?.owner) {
      const o = normalizeAddress(filter.owner);
      rows = rows.filter((r) => r.owner === o);
    }
    return rows.map((r) => this.mapSandbox(r));
  }

  updateSandbox(id: string, patch: Partial<Pick<SandboxRow, "status" | "owner" | "occupant" | "lastBilledAt">>): void {
    const cur = this.getSandbox(id);
    if (!cur) return;
    const next = { ...cur, ...patch };
    this.db
      .prepare("UPDATE sandboxes SET status = ?, owner = ?, occupant = ?, last_billed_at = ? WHERE id = ?")
      .run(
        next.status, normalizeAddress(next.owner),
        next.occupant ? normalizeAddress(next.occupant) : null, next.lastBilledAt, id,
      );
  }

  // ─── Registrations ───────────────────────────────────────────

  registerAutomaton(r: { automatonId: string; address: string; creator?: string; name?: string; payload: unknown }): "created" | "exists" | "conflict" {
    const existing = this.db
      .prepare("SELECT address FROM automatons WHERE automaton_id = ?")
      .get(r.automatonId) as { address: string } | undefined;
    if (existing) return existing.address === normalizeAddress(r.address) ? "exists" : "conflict";
    this.db
      .prepare("INSERT INTO automatons (automaton_id, address, creator, name, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(
        r.automatonId, normalizeAddress(r.address), r.creator ? normalizeAddress(r.creator) : null,
        r.name ?? null, JSON.stringify(r.payload), new Date().toISOString(),
      );
    return "created";
  }

  // ─── Message relay ───────────────────────────────────────────

  insertMessage(m: { from: string; to: string; content: string; signedAt: string; replyTo?: string }): string {
    const id = ulid();
    this.db
      .prepare("INSERT INTO messages (id, from_addr, to_addr, content, signed_at, created_at, reply_to) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, normalizeAddress(m.from), normalizeAddress(m.to), m.content, m.signedAt, new Date().toISOString(), m.replyTo ?? null);
    return id;
  }

  pollMessages(to: string, cursor?: string, limit = 50): Array<{ id: string; from: string; to: string; content: string; signedAt: string; createdAt: string; replyTo?: string }> {
    const rows = this.db
      .prepare("SELECT * FROM messages WHERE to_addr = ? AND id > ? ORDER BY id LIMIT ?")
      .all(normalizeAddress(to), cursor ?? "", Math.min(Math.max(limit, 1), 200)) as any[];
    return rows.map((r) => ({
      id: r.id,
      from: r.from_addr,
      to: r.to_addr,
      content: r.content,
      signedAt: r.signed_at,
      createdAt: r.created_at,
      replyTo: r.reply_to ?? undefined,
    }));
  }

  /** Remember the newest message handed to a recipient, for unread counts. */
  markDelivered(to: string, lastId: string): void {
    this.db
      .prepare(
        `INSERT INTO relay_cursors (address, delivered_id) VALUES (?, ?)
         ON CONFLICT(address) DO UPDATE SET delivered_id = MAX(delivered_id, excluded.delivered_id)`,
      )
      .run(normalizeAddress(to), lastId);
  }

  countUnread(to: string): number {
    const a = normalizeAddress(to);
    const cur = this.db
      .prepare("SELECT delivered_id FROM relay_cursors WHERE address = ?")
      .get(a) as { delivered_id: string } | undefined;
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM messages WHERE to_addr = ? AND id > ?")
      .get(a, cur?.delivered_id ?? "") as { n: number };
    return row.n;
  }
}
