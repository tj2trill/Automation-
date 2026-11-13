/**
 * Self-Change Trials — keep a change to yourself only if it measurably helps
 *
 * The agent can rewrite the text that steers it: its soul (purpose, values,
 * guidelines, personality, boundaries, strategy) and its genesis prompt.
 * Before this module such a change was kept forever unless the agent itself
 * undid it, and nothing measured whether it helped.
 *
 * Now each such change is a trial:
 *
 *   1. Baseline. A change is allowed only when the agent has closed enough
 *      goals to compare against: its last BASELINE_MAX closed goals, at least
 *      MIN_GOALS. Only one trial runs at a time, so each result has one cause.
 *
 *   2. Measure. Goals set after the change and then closed are the trial's
 *      sample. Goals already open at the change are left out: they were
 *      planned under the old text.
 *
 *   3. Decide. A goal counts as a success only if it was closed as achieved
 *      AND its check passed; the agent's word alone does not count. With a
 *      uniform prior on each success rate, the probability that the rate
 *      after the change is higher than before is computed exactly. The change
 *      is kept at PROMOTE_PROBABILITY or above. Anything else, including an
 *      inconclusive result, restores the previous text: only measured gains
 *      are kept. A clearly harmful change is rolled back early, and a trial
 *      that collects too few goals within DEADLINE_TURNS is rolled back.
 *
 * Limits, stated rather than hidden:
 *
 *   - The agent chooses its goals and their checks. It could choose easier
 *     goals after a change. The sample counts only goals set after the
 *     change, which limits but does not remove this.
 *   - Small samples. With 3 to 10 goals on each side only large effects
 *     reach the threshold, so most small improvements will be rolled back.
 *     That is the cost of keeping only measured gains.
 *   - The agent has a shell in its own container. These records are a
 *     discipline the runtime keeps through its own tools; they are not a
 *     security boundary against an agent editing its database directly.
 */

import type BetterSqlite3 from "better-sqlite3";
import { ulid } from "ulid";
import { createLogger } from "../observability/logger.js";

const logger = createLogger("self-mod.trials");

type Database = BetterSqlite3.Database;

/** Closed goals needed on each side of a change. */
export const MIN_GOALS = 3;
/** The baseline is the agent's most recent closed goals, at most this many. */
export const BASELINE_MAX = 10;
/** Keep the change at this probability that the success rate went up, or above. */
export const PROMOTE_PROBABILITY = 0.8;
/** Roll back as soon as the probability of improvement falls this low. */
export const EARLY_ROLLBACK_PROBABILITY = 0.05;
/** A trial that has not collected enough goals by then is rolled back. */
export const DEADLINE_TURNS = 150;
/** A decision or a restore is mentioned for this many turns after it happened. */
export const NOTICE_TURNS = 10;

export type TrialKind = "soul" | "genesis";
export type TrialChanges = Record<string, { before: unknown; after: unknown }>;

export interface Trial {
  id: string;
  kind: TrialKind;
  changes: TrialChanges;
  reason: string | null;
  status: "open" | "promoted" | "rolled_back";
  baselineClosed: number;
  baselineSuccesses: number;
  baselineLastOutcome: number;
  openGoalIds: string[];
  openedTurn: number;
  targetGoals: number;
  afterClosed: number | null;
  afterSuccesses: number | null;
  probabilityBetter: number | null;
  verdict: string | null;
  concludedTurn: number | null;
  openedAt: string;
  concludedAt: string | null;
}

function rowToTrial(r: any): Trial {
  return {
    id: r.id,
    kind: r.kind,
    changes: JSON.parse(r.changes),
    reason: r.reason,
    status: r.status,
    baselineClosed: r.baseline_closed,
    baselineSuccesses: r.baseline_successes,
    baselineLastOutcome: r.baseline_last_outcome,
    openGoalIds: JSON.parse(r.open_goal_ids),
    openedTurn: r.opened_turn,
    targetGoals: r.target_goals,
    afterClosed: r.after_closed,
    afterSuccesses: r.after_successes,
    probabilityBetter: r.probability_better,
    verdict: r.verdict,
    concludedTurn: r.concluded_turn ?? null,
    openedAt: r.opened_at,
    concludedAt: r.concluded_at,
  };
}

// ─── Statistics ──────────────────────────────────────────────────

/** ln Γ(x) for x > 0 (Lanczos, g = 7, n = 9; accurate to ~1e-15 relative). */
function logGamma(x: number): number {
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  x -= 1;
  let a = c[0]!;
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += c[i]! / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}
function logBeta(a: number, b: number): number {
  return logGamma(a) + logGamma(b) - logGamma(a + b);
}

/**
 * Probability that success rate B exceeds success rate A, with a uniform
 * prior on each: P(pB > pA) for pA ~ Beta(1+sA, 1+fA), pB ~ Beta(1+sB, 1+fB).
 * Exact closed form for integer parameters, summed in log space.
 */
export function probabilityBBeatsA(successesA: number, failuresA: number, successesB: number, failuresB: number): number {
  for (const n of [successesA, failuresA, successesB, failuresB]) {
    if (!Number.isInteger(n) || n < 0) throw new Error("counts must be non-negative integers");
  }
  const aA = 1 + successesA;
  const bA = 1 + failuresA;
  const aB = 1 + successesB;
  const bB = 1 + failuresB;
  let total = 0;
  for (let i = 0; i < aB; i++) {
    total += Math.exp(logBeta(aA + i, bA + bB) - Math.log(bB + i) - logBeta(1 + i, bB) - logBeta(aA, bA));
  }
  return Math.min(1, Math.max(0, total));
}

// ─── Goal counts ─────────────────────────────────────────────────

interface Counts {
  closed: number;
  successes: number;
}

/** A goal is a success only if closed as achieved with a passing check. */
const SUCCESS = "result = 'achieved' AND verification = 'passed'";

function baselineCounts(db: Database): Counts & { lastRowid: number } {
  const rows = db
    .prepare(`SELECT rowid AS r, (${SUCCESS}) AS ok FROM goal_outcomes ORDER BY rowid DESC LIMIT ?`)
    .all(BASELINE_MAX) as Array<{ r: number; ok: number }>;
  return {
    closed: rows.length,
    successes: rows.filter((x) => x.ok).length,
    lastRowid: rows[0]?.r ?? 0,
  };
}

function afterCounts(db: Database, trial: Trial): Counts {
  const excluded = new Set(trial.openGoalIds);
  const rows = db
    .prepare(`SELECT goal_id, (${SUCCESS}) AS ok FROM goal_outcomes WHERE rowid > ? ORDER BY rowid ASC`)
    .all(trial.baselineLastOutcome) as Array<{ goal_id: string; ok: number }>;
  const counted = rows.filter((x) => !excluded.has(x.goal_id)).slice(0, trial.targetGoals);
  return { closed: counted.length, successes: counted.filter((x) => x.ok).length };
}

function latestTurnRowid(db: Database): number {
  return (db.prepare("SELECT COALESCE(MAX(rowid), 0) AS r FROM turns").get() as { r: number }).r;
}

// ─── Opening a trial ─────────────────────────────────────────────

export function getOpenTrial(db: Database): Trial | null {
  try {
    const row = db.prepare("SELECT * FROM self_change_trials WHERE status = 'open' ORDER BY rowid DESC LIMIT 1").get();
    return row ? rowToTrial(row) : null;
  } catch {
    return null;
  }
}

export function getTrial(db: Database, id: string): Trial | null {
  const row = db.prepare("SELECT * FROM self_change_trials WHERE id = ?").get(id);
  return row ? rowToTrial(row) : null;
}

export function listTrials(db: Database, limit = 10): Trial[] {
  return (db.prepare("SELECT * FROM self_change_trials ORDER BY rowid DESC LIMIT ?").all(limit) as any[]).map(rowToTrial);
}

/**
 * Whether a change may start now. Returns the reason it may not, or null.
 * Call this before applying the change, so a refused change is never applied.
 */
export function trialBlocker(db: Database): string | null {
  const open = getOpenTrial(db);
  if (open) {
    const after = afterCounts(db, open);
    return (
      `A change to yourself is already on trial (${describeChanges(open)}), with ${after.closed} of ${open.targetGoals} goals measured. ` +
      `Only one change is measured at a time so its effect can be told apart. Close goals to finish that trial first.`
    );
  }
  const base = baselineCounts(db);
  if (base.closed < MIN_GOALS) {
    return (
      `A change to yourself is kept only if it measurably helps, and that needs a baseline: at least ${MIN_GOALS} closed goals ` +
      `before the change. You have closed ${base.closed}. Set goals with checks, close them, then make the change.`
    );
  }
  return null;
}

/**
 * Record a change that has just been applied, and start measuring it.
 * The caller checks trialBlocker first and applies the change only if it
 * returned null.
 */
export function openTrial(db: Database, args: { kind: TrialKind; changes: TrialChanges; reason?: string }): Trial {
  const base = baselineCounts(db);
  const openGoals = db.prepare("SELECT id FROM working_memory WHERE content_type = 'goal'").all() as Array<{ id: string }>;
  const id = ulid();
  db.prepare(
    `INSERT INTO self_change_trials
       (id, kind, changes, reason, baseline_closed, baseline_successes, baseline_last_outcome, open_goal_ids, opened_turn, target_goals)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    args.kind,
    JSON.stringify(args.changes),
    args.reason ?? null,
    base.closed,
    base.successes,
    base.lastRowid,
    JSON.stringify(openGoals.map((g) => g.id)),
    latestTurnRowid(db),
    Math.max(MIN_GOALS, base.closed),
  );
  return getTrial(db, id)!;
}

/** The parts of the change that can appear in the prompt: field names only. */
export function describeChanges(trial: Pick<Trial, "kind" | "changes">): string {
  if (trial.kind === "genesis") return "your genesis prompt";
  const fields = Object.keys(trial.changes).filter((f) => /^[A-Za-z]{1,40}$/.test(f));
  return `soul ${fields.join(", ") || "sections"}`;
}

// ─── Concluding a trial ──────────────────────────────────────────

export interface Restorers {
  /** Put these soul fields back to the given values. */
  restoreSoul(values: Record<string, unknown>, reason: string): Promise<boolean>;
  /** Put the genesis prompt back to this text. */
  restoreGenesis(text: string, reason: string): Promise<boolean>;
}

export interface Conclusion {
  trial: Trial;
  kept: boolean;
}

/**
 * Decide the open trial if its evidence is complete, its result is already
 * clearly harmful, or its time is up. Rolls the change back unless it was a
 * measured improvement. Never throws; returns null when nothing was decided.
 */
export async function concludeTrialIfDue(db: Database, restore: Restorers): Promise<Conclusion | null> {
  try {
    const trial = getOpenTrial(db);
    if (!trial) return null;
    const after = afterCounts(db, trial);
    const turnsSince = latestTurnRowid(db) - trial.openedTurn;
    const p =
      after.closed > 0
        ? probabilityBBeatsA(trial.baselineSuccesses, trial.baselineClosed - trial.baselineSuccesses, after.successes, after.closed - after.successes)
        : null;

    const complete = after.closed >= trial.targetGoals;
    const clearlyWorse = after.closed >= MIN_GOALS && p !== null && p <= EARLY_ROLLBACK_PROBABILITY;
    const expired = turnsSince >= DEADLINE_TURNS;
    if (!complete && !clearlyWorse && !expired) return null;

    const before = `${trial.baselineSuccesses} of ${trial.baselineClosed}`;
    const now = `${after.successes} of ${after.closed}`;
    let kept = false;
    let verdict: string;
    if (complete && p !== null && p >= PROMOTE_PROBABILITY) {
      kept = true;
      verdict = `kept: verified goal success went from ${before} to ${now}; probability it improved ${pct(p)}`;
    } else if (clearlyWorse) {
      verdict = `rolled back early: verified goal success went from ${before} to ${now}; probability it improved only ${pct(p!)}`;
    } else if (complete) {
      verdict = `rolled back: verified goal success went from ${before} to ${now}; probability it improved ${pct(p ?? 0.5)}, below the ${pct(PROMOTE_PROBABILITY)} needed to keep it`;
    } else {
      verdict = `rolled back: only ${after.closed} of ${trial.targetGoals} goals were closed within ${DEADLINE_TURNS} turns, too few to show a gain`;
    }

    if (!kept) {
      const reason = `Rolled back trial ${trial.id}: ${verdict}`;
      const ok =
        trial.kind === "genesis"
          ? await restore.restoreGenesis(String(trial.changes.genesisPrompt?.before ?? ""), reason)
          : await restore.restoreSoul(Object.fromEntries(Object.entries(trial.changes).map(([k, v]) => [k, v.before])), reason);
      if (!ok) {
        // Leave the trial open so the rollback is tried again next turn.
        logger.error(`Rollback of trial ${trial.id} failed; will retry`);
        return null;
      }
    }

    db.prepare(
      `UPDATE self_change_trials SET status = ?, after_closed = ?, after_successes = ?, probability_better = ?, verdict = ?,
         concluded_turn = ?, concluded_at = datetime('now')
       WHERE id = ? AND status = 'open'`,
    ).run(kept ? "promoted" : "rolled_back", after.closed, after.successes, p, verdict, latestTurnRowid(db), trial.id);
    db.prepare(
      "INSERT INTO modifications (id, timestamp, type, description, reversible) VALUES (?, ?, ?, ?, ?)",
    ).run(ulid(), new Date().toISOString(), kept ? "trial_promoted" : "trial_rolled_back", `${describeChanges(trial)}: ${verdict}`, kept ? 1 : 0);
    return { trial: getTrial(db, trial.id)!, kept };
  } catch (error) {
    logger.error("Trial conclusion failed", error instanceof Error ? error : undefined);
    return null;
  }
}

function pct(p: number): string {
  return `${Math.round(p * 100)}%`;
}

/**
 * Lines for the track record: the trial in progress, or the latest decision
 * if it was made in the last few turns. Field names and numbers only.
 */
export function formatTrialLines(db: Database): string[] {
  try {
    const notices: string[] = [];
    // Recency is counted in turns by row number. Timestamps have one-second
    // resolution and many turns can share a second.
    const latest = latestTurnRowid(db);
    const restored = db.prepare("SELECT value FROM kv WHERE key = 'soul_restored_turn'").get() as { value: string } | undefined;
    if (restored) {
      if (latest - Number(restored.value) <= NOTICE_TURNS) notices.push("- Your SOUL.md was edited outside update_soul and was put back. Change your soul only with update_soul.");
    }
    const open = getOpenTrial(db);
    if (open) {
      const after = afterCounts(db, open);
      return [
        ...notices,
        `- Change on trial: ${describeChanges(open)}. Baseline: ${open.baselineSuccesses} of ${open.baselineClosed} goals verified achieved. ` +
          `Since the change: ${after.successes} of ${after.closed}, ${open.targetGoals - after.closed} more goals needed. ` +
          `It is kept only if verified success measurably improves; otherwise the previous text is restored.`,
      ];
    }
    const last = db
      .prepare("SELECT * FROM self_change_trials WHERE status != 'open' ORDER BY rowid DESC LIMIT 1")
      .get() as any;
    if (!last) return notices;
    const t = rowToTrial(last);
    if (t.concludedTurn === null || latest - t.concludedTurn > NOTICE_TURNS) return notices;
    return [...notices, `- Last change to yourself (${describeChanges(t)}) was ${t.verdict}.`];
  } catch {
    return [];
  }
}
