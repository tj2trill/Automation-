/**
 * Outcomes — what the agent's goals came to, and what money came in
 *
 * The track record can count tool failures from stored turns, but three
 * things are recorded nowhere unless something writes them down:
 *
 *  1. Whether a goal was met. The agent says so when it closes a goal
 *     (achieved, failed or abandoned). A goal can carry a check command,
 *     fixed when the goal is set; "achieved" is then accepted only if the
 *     check passes, and the record keeps verified results apart from the
 *     agent's word. Each turn is attributed to exactly one goal, the one in
 *     focus, so the costs of overlapping goals never double count.
 *
 *  2. Whether a saved procedure worked. A procedure is credited with a goal's
 *     outcome when the agent names it, or when it recalled that procedure by
 *     exact name while the goal was open (tracked by goal id, not by time).
 *
 *  3. What the agent received and spent. The control plane's ledger is the
 *     only record of money, so received entries are copied from it and
 *     spending by kind (inference, container time, transfers out) is read
 *     from it, both for the recent period and since the account was opened.
 *
 * Only numbers and fixed words leave this module for the prompt. Goal text
 * and procedure names stay in the memory tiers that already hold them.
 */

import type BetterSqlite3 from "better-sqlite3";
import { ulid } from "ulid";
import type { ConwayClient, CreditsSpent } from "../types.js";
import { EpisodicMemoryManager } from "./episodic.js";
import { ProceduralMemoryManager } from "./procedural.js";
import { WorkingMemoryManager } from "./working.js";
import { createLogger } from "../observability/logger.js";

const logger = createLogger("memory.outcomes");

type Database = BetterSqlite3.Database;

export type GoalResult = "achieved" | "failed" | "abandoned";
export const GOAL_RESULTS: readonly GoalResult[] = ["achieved", "failed", "abandoned"];

const RECALLS_KEY = "outcomes.procedure_recalls";
const INCOME_CURSOR_KEY = "outcomes.income_cursor";
const INCOME_SYNCED_AT_KEY = "outcomes.income_synced_at";
const FOCUS_KEY = "outcomes.focus_goal";
const SPEND_KEY = "outcomes.ledger_spend";
const MAX_RECALLS = 20;
export const MAX_CHECK_LENGTH = 500;
/** The ledger is asked for new entries at most this often. */
export const INCOME_SYNC_INTERVAL_MS = 60_000;

function getKV(db: Database, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value;
}
function setKV(db: Database, key: string, value: string): void {
  db.prepare(
    "INSERT INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
  ).run(key, value);
}

/** SQLite's datetime('now') is "YYYY-MM-DD HH:MM:SS" in UTC. */
export function sqliteTimeToMs(value: string): number {
  const iso = /T/.test(value) ? value : `${value.replace(" ", "T")}Z`;
  return new Date(iso).getTime();
}

// ─── Procedures ──────────────────────────────────────────────────

interface Recall {
  name: string;
  /** Goals that were open when the procedure was looked up. */
  goals: string[];
}

/** Recalls in the order they happened, oldest first. */
function readRecalls(db: Database): Recall[] {
  try {
    const parsed = JSON.parse(getKV(db, RECALLS_KEY) ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter((r) => typeof r?.name === "string" && Array.isArray(r?.goals) && r.goals.every((g: unknown) => typeof g === "string"))
      : [];
  } catch {
    return [];
  }
}

/**
 * Note that the agent looked up a saved procedure by its exact name.
 *
 * The recall is tied to the goals open at that moment, by id. Comparing
 * times instead would be wrong: goals are stamped to the second, so a lookup
 * just before a goal was set would appear to fall inside it.
 */
export function noteProcedureRecalled(db: Database, name: string): void {
  try {
    const open = db.prepare("SELECT id FROM working_memory WHERE content_type = 'goal'").all() as Array<{ id: string }>;
    const recalls = readRecalls(db).filter((r) => r.name !== name);
    // With no goal open there is nothing the lookup could later be credited to.
    if (open.length > 0) recalls.push({ name, goals: open.map((g) => g.id) });
    setKV(db, RECALLS_KEY, JSON.stringify(recalls.slice(-MAX_RECALLS)));
  } catch (error) {
    logger.error("Failed to note recall", error instanceof Error ? error : undefined);
  }
}

// ─── Goals ───────────────────────────────────────────────────────

interface GoalStateRow {
  goal_id: string;
  check_command: string | null;
  turns: number;
  tool_calls: number;
  cost_cents: number;
}

function isOpenGoal(db: Database, goalId: string): boolean {
  return !!db.prepare("SELECT 1 FROM working_memory WHERE id = ? AND content_type = 'goal'").get(goalId);
}
function goalState(db: Database, goalId: string): GoalStateRow | undefined {
  return db.prepare("SELECT * FROM goal_state WHERE goal_id = ?").get(goalId) as GoalStateRow | undefined;
}

/**
 * Start tracking a newly set goal: store its check and put it in focus.
 * The check cannot be changed afterwards, so it cannot be fitted to whatever
 * the agent ends up with.
 */
export function registerGoal(db: Database, goalId: string, check?: string): void {
  const command = check?.trim() ? check.trim() : null;
  db.prepare("INSERT OR IGNORE INTO goal_state (goal_id, check_command) VALUES (?, ?)").run(goalId, command);
  setKV(db, FOCUS_KEY, goalId);
}

/** The command that decides whether this goal was achieved, if it has one. */
export function getGoalCheck(db: Database, goalId: string): string | null {
  try {
    return goalState(db, goalId)?.check_command ?? null;
  } catch {
    return null;
  }
}

/**
 * The goal the agent is working on: the one it chose, or else the most
 * recently set goal that is still open. Null when no goal is open.
 */
export function getFocusGoal(db: Database): string | null {
  try {
    const chosen = getKV(db, FOCUS_KEY);
    if (chosen && isOpenGoal(db, chosen)) return chosen;
    const latest = db
      .prepare("SELECT id FROM working_memory WHERE content_type = 'goal' ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .get() as { id: string } | undefined;
    return latest?.id ?? null;
  } catch {
    return null;
  }
}

/** Switch focus to another open goal. Turns from now on are attributed to it. */
export function focusGoal(db: Database, goalId: string): string {
  try {
    if (!isOpenGoal(db, goalId)) return `Goal not found: ${goalId}`;
    setKV(db, FOCUS_KEY, goalId);
    return `Focus is now on goal ${goalId}. Turns from now on count toward it.`;
  } catch (error) {
    return `Failed to change focus: ${error instanceof Error ? error.message : error}`;
  }
}

/**
 * Attribute one finished turn to exactly one goal and return that goal's id.
 *
 * The turn goes to the goal that was in focus when the turn began if that
 * goal was closed during the turn (closing it was this turn's work),
 * otherwise to the goal in focus now (which covers the turn that set it).
 * With no goal open the turn is attributed to none.
 */
export function attributeTurn(db: Database, turn: { toolCalls: unknown[]; costCents: number }, focusAtStart: string | null): string | null {
  try {
    const cost = Number(turn.costCents) || 0;
    const calls = turn.toolCalls.length;
    if (focusAtStart && !isOpenGoal(db, focusAtStart)) {
      const closed = db
        .prepare(
          "UPDATE goal_outcomes SET turns = turns + 1, tool_calls = tool_calls + ?, cost_cents = cost_cents + ? WHERE id = (SELECT id FROM goal_outcomes WHERE goal_id = ? ORDER BY rowid DESC LIMIT 1)",
        )
        .run(calls, cost, focusAtStart);
      if (closed.changes > 0) return focusAtStart;
    }
    const focus = getFocusGoal(db);
    if (!focus) return null;
    db.prepare(
      `INSERT INTO goal_state (goal_id, turns, tool_calls, cost_cents) VALUES (?, 1, ?, ?)
       ON CONFLICT(goal_id) DO UPDATE SET turns = turns + 1, tool_calls = tool_calls + excluded.tool_calls, cost_cents = cost_cents + excluded.cost_cents`,
    ).run(focus, calls, cost);
    return focus;
  } catch (error) {
    logger.error("Failed to attribute turn", error instanceof Error ? error : undefined);
    return null;
  }
}

export interface CloseGoalArgs {
  goalId: string;
  sessionId: string;
  result?: GoalResult;
  /** The agent's own description of what happened. Stored in episodic memory only. */
  outcome?: string;
  /** Saved procedure the agent followed, if it wants to name one. */
  procedure?: string;
  /** "passed" when the caller ran the goal's check and it exited 0. */
  verification?: "none" | "passed";
}

/**
 * Close a working-memory goal with its result, record what was spent on it,
 * and credit the procedure that was followed.
 *
 * This function does not run the goal's check; the caller does, and refuses
 * to close a goal as achieved when the check fails (see the complete_goal
 * tool). A goal with a check that is closed as achieved without
 * `verification: "passed"` is rejected here, so no other path can skip it.
 */
export function closeGoal(db: Database, args: CloseGoalArgs): string {
  const result: GoalResult = args.result ?? "achieved";
  if (!GOAL_RESULTS.includes(result)) {
    return `Failed to close goal: result must be one of ${GOAL_RESULTS.join(", ")}.`;
  }
  try {
    const working = new WorkingMemoryManager(db);
    const goal = working.getBySession(args.sessionId).find((e) => e.id === args.goalId && e.contentType === "goal");
    if (!goal) return `Goal not found: ${args.goalId}`;

    const state = goalState(db, goal.id);
    const verification = result === "achieved" && args.verification === "passed" ? "passed" : "none";
    if (result === "achieved" && state?.check_command && verification !== "passed") {
      return "Failed to close goal: this goal has a check, and it has not passed. The goal stays open.";
    }
    // Turns attributed to this goal so far. The turn making this call is
    // added by attributeTurn once it has been stored.
    const spent = { turns: state?.turns ?? 0, calls: state?.tool_calls ?? 0, cost: state?.cost_cents ?? 0 };

    const procedural = new ProceduralMemoryManager(db);
    let procedure: string | null = null;
    let procedureNote = "";
    if (args.procedure) {
      if (procedural.get(args.procedure)) procedure = args.procedure;
      else procedureNote = ` No saved procedure is named "${args.procedure}", so none was credited.`;
    } else {
      // The most recent lookup made while this goal was open.
      const recalled = readRecalls(db)
        .reverse()
        .find((r) => r.goals.includes(goal.id) && procedural.get(r.name));
      if (recalled) procedure = recalled.name;
    }

    const write = db.transaction(() => {
      db.prepare(
        `INSERT INTO goal_outcomes (id, goal_id, result, verification, procedure, turns, tool_calls, cost_cents, opened_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(ulid(), goal.id, result, verification, procedure, spent.turns, spent.calls, spent.cost, goal.createdAt);

      new EpisodicMemoryManager(db).record({
        sessionId: args.sessionId,
        eventType: result === "achieved" ? "goal_completed" : `goal_${result}`,
        summary: `Goal ${result}${verification === "passed" ? " (check passed)" : ""}: ${goal.content}`,
        detail: args.outcome ?? null,
        outcome: result === "achieved" ? "success" : result === "failed" ? "failure" : "neutral",
        importance: goal.priority,
        classification: "productive",
      });

      // An abandoned goal says nothing about whether the procedure works.
      if (procedure && result !== "abandoned") procedural.recordOutcome(procedure, result === "achieved");
      working.delete(goal.id);
      db.prepare("DELETE FROM goal_state WHERE goal_id = ?").run(goal.id);
      // This goal is closed; later goals must not inherit its lookups.
      const remaining = readRecalls(db)
        .map((r) => ({ name: r.name, goals: r.goals.filter((g) => g !== goal.id) }))
        .filter((r) => r.goals.length > 0);
      setKV(db, RECALLS_KEY, JSON.stringify(remaining));
    });
    write();

    if (procedure && result !== "abandoned") {
      procedureNote = ` Recorded a ${result === "achieved" ? "success" : "failure"} for procedure "${procedure}".`;
    }
    const how = verification === "passed" ? " Its check passed." : result === "achieved" ? " It had no check, so this rests on your word." : "";
    return (
      `Goal ${result} and archived: "${goal.content}".${how} ` +
      `Before this turn it took ${spent.turns} turn(s) and $${(spent.cost / 100).toFixed(4)}.${procedureNote}`
    );
  } catch (error) {
    return `Failed to close goal: ${error instanceof Error ? error.message : error}`;
  }
}

export interface GoalSummary {
  achieved: GoalGroup;
  failed: GoalGroup;
  abandoned: GoalGroup;
  /** Achieved goals whose check passed. The rest of `achieved` rest on the agent's word. */
  achievedVerified: number;
  /** Goals still open. */
  open: number;
  /** Open goals that have a check. */
  openWithCheck: number;
  /** Turns and cost attributed to the open goal that has used the most turns. */
  longestOpenTurns: number;
  longestOpenCostCents: number;
}
export interface GoalGroup {
  count: number;
  averageTurns: number;
  averageCostCents: number;
}

/** Goals closed since `sinceSqliteTime`, plus the state of open goals. */
export function summariseGoals(db: Database, sinceSqliteTime: string): GoalSummary {
  const group = (result: GoalResult): GoalGroup => {
    const row = db
      .prepare(
        "SELECT COUNT(*) AS n, COALESCE(AVG(turns), 0) AS turns, COALESCE(AVG(cost_cents), 0) AS cost FROM goal_outcomes WHERE result = ? AND closed_at >= ?",
      )
      .get(result, sinceSqliteTime) as { n: number; turns: number; cost: number };
    return { count: row.n, averageTurns: row.turns, averageCostCents: row.cost };
  };
  const verified = db
    .prepare("SELECT COUNT(*) AS n FROM goal_outcomes WHERE result = 'achieved' AND verification = 'passed' AND closed_at >= ?")
    .get(sinceSqliteTime) as { n: number };
  const open = db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN s.check_command IS NOT NULL THEN 1 ELSE 0 END), 0) AS checked
       FROM working_memory w LEFT JOIN goal_state s ON s.goal_id = w.id WHERE w.content_type = 'goal'`,
    )
    .get() as { n: number; checked: number };
  const longest = db
    .prepare(
      `SELECT s.turns AS turns, s.cost_cents AS cost FROM goal_state s
       JOIN working_memory w ON w.id = s.goal_id AND w.content_type = 'goal' ORDER BY s.turns DESC LIMIT 1`,
    )
    .get() as { turns: number; cost: number } | undefined;
  return {
    achieved: group("achieved"),
    failed: group("failed"),
    abandoned: group("abandoned"),
    achievedVerified: verified.n,
    open: open.n,
    openWithCheck: open.checked,
    longestOpenTurns: longest?.turns ?? 0,
    longestOpenCostCents: longest?.cost ?? 0,
  };
}

// ─── Income ──────────────────────────────────────────────────────

export interface IncomeSyncOptions {
  /** Kept for callers; all transfers now count as funding, whoever sent them. */
  fundingAddresses?: string[];
  now?: number;
  /** Ask the ledger even if it was asked recently. */
  force?: boolean;
}

/**
 * Copy newly received money from the control plane's ledger.
 *
 * A job reward or a customer payment is "earned". Everything else (top-ups,
 * and transfers from any account, including other agents) is "funding":
 * money moved inside the population is not new money, and the host does not
 * count it toward reproduction either. Returns how many entries were new.
 * Never throws: the ledger being unreachable must not stop the agent loop.
 */
export async function syncIncome(db: Database, conway: Pick<ConwayClient, "getCreditsReceived">, opts: IncomeSyncOptions): Promise<number> {
  if (!conway.getCreditsReceived) return 0;
  const now = opts.now ?? Date.now();
  try {
    const last = Number(getKV(db, INCOME_SYNCED_AT_KEY) ?? 0);
    if (!opts.force && now - last < INCOME_SYNC_INTERVAL_MS) return 0;

    let cursor = getKV(db, INCOME_CURSOR_KEY) ?? "";
    let added = 0;
    // The ledger returns pages of entries; stop on a short page or after a few pages.
    for (let page = 0; page < 5; page++) {
      const entries = await conway.getCreditsReceived(cursor || undefined);
      if (entries.length === 0) break;
      const insert = db.prepare("INSERT OR IGNORE INTO income_events (id, kind, amount_cents, occurred_at) VALUES (?, ?, ?, ?)");
      const store = db.transaction(() => {
        for (const e of entries) {
          if (!(e.amountCents > 0) || !Number.isFinite(sqliteTimeToMs(e.ts))) continue;
          const kind = e.kind === "job_reward" || e.kind === "sale" ? "earned" : "funding";
          added += insert.run(e.id, kind, e.amountCents, new Date(sqliteTimeToMs(e.ts)).toISOString()).changes;
        }
        cursor = entries[entries.length - 1]!.id;
        setKV(db, INCOME_CURSOR_KEY, cursor);
      });
      store();
      if (entries.length < 100) break;
    }
    setKV(db, INCOME_SYNCED_AT_KEY, String(now));
    return added;
  } catch (error) {
    logger.error("Income sync failed", error instanceof Error ? error : undefined);
    return 0;
  }
}

export interface IncomeSummary {
  /** False until the ledger has been read at least once; then "no income" is a fact, not a gap. */
  tracked: boolean;
  fundingCents: number;
  earnedCents: number;
}

/** Money received since `sinceIso`. */
export function summariseIncome(db: Database, sinceIso: string): IncomeSummary {
  const tracked = getKV(db, INCOME_SYNCED_AT_KEY) !== undefined;
  const rows = db
    .prepare("SELECT kind, COALESCE(SUM(amount_cents), 0) AS total FROM income_events WHERE occurred_at >= ? GROUP BY kind")
    .all(sinceIso) as Array<{ kind: string; total: number }>;
  const total = (kind: string) => rows.find((r) => r.kind === kind)?.total ?? 0;
  return { tracked, fundingCents: total("funding"), earnedCents: total("earned") };
}

// ─── Spending ────────────────────────────────────────────────────

export interface LedgerSpend extends CreditsSpent {
  /** Start of the period, as sent to the ledger. */
  since: string;
}

export interface Period {
  /** ISO 8601, comparable with ledger times and turn timestamps. */
  iso: string;
  /** "YYYY-MM-DD HH:MM:SS", comparable with SQLite datetime('now') columns. */
  sqlite: string;
}

const BEGINNING: Period = { iso: "1970-01-01T00:00:00.000Z", sqlite: "1970-01-01 00:00:00" };

/**
 * Where the period covered by the agent's last `maxTurns` turns begins.
 *
 * It is not the oldest of those turns' own timestamp: a turn is stamped
 * after its inference call has been charged, so that charge would fall just
 * outside. The period begins where the turn before the window ended, or at
 * the beginning when the window covers every turn the agent has taken.
 * Null when the agent has taken no turns.
 */
export function periodStart(db: Database, maxTurns: number): Period | null {
  const rows = db
    .prepare("SELECT timestamp, created_at FROM turns ORDER BY rowid DESC LIMIT ?")
    .all(maxTurns + 1) as Array<{ timestamp: string; created_at: string }>;
  if (rows.length === 0) return null;
  if (rows.length <= maxTurns) return BEGINNING;
  const before = rows[rows.length - 1]!;
  return { iso: before.timestamp, sqlite: before.created_at };
}

/**
 * Read what the ledger says this account spent, for the track record's
 * period and since the account was opened, and keep the answer for the
 * track record to use. Never throws.
 */
export async function syncSpend(db: Database, conway: Pick<ConwayClient, "getCreditsSpent">, maxTurns: number): Promise<boolean> {
  if (!conway.getCreditsSpent) return false;
  try {
    const since = periodStart(db, maxTurns)?.iso;
    if (!since) return false;
    const spent = await conway.getCreditsSpent(since);
    const ok = (k: { inferenceCents: number; computeCents: number; sentCents: number } | undefined) =>
      !!k && [k.inferenceCents, k.computeCents, k.sentCents].every((n) => Number.isFinite(n) && n >= 0);
    if (!ok(spent?.period) || !ok(spent?.lifetime) || !Number.isFinite(spent.balanceCents)) return false;
    const value: LedgerSpend = { since, period: spent.period, lifetime: spent.lifetime, balanceCents: spent.balanceCents };
    setKV(db, SPEND_KEY, JSON.stringify(value));
    return true;
  } catch (error) {
    logger.error("Spend sync failed", error instanceof Error ? error : undefined);
    return false;
  }
}

/** The ledger's spend figures, if they were read for the period starting at `since`. */
export function readLedgerSpend(db: Database, since: string): LedgerSpend | null {
  try {
    const parsed = JSON.parse(getKV(db, SPEND_KEY) ?? "null") as LedgerSpend | null;
    // Figures for a different period would be set against the wrong turns.
    return parsed && parsed.since === since ? parsed : null;
  } catch {
    return null;
  }
}
