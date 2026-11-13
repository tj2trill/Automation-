/**
 * Track Record — outcome feedback for the agent loop
 *
 * Every turn's cost and every tool call's outcome are already persisted
 * (`turns`, `tool_calls`), but nothing read them back, so the agent could
 * repeat an action that fails every time and never see what its turns cost.
 * This module computes a short summary of recent outcomes from those tables
 * and renders it for the prompt.
 *
 * Design constraints:
 *
 *  - Read-only over existing tables. There is no second copy of the data to
 *    drift out of step, and history recorded before this module existed
 *    counts.
 *
 *  - Recent window, not lifetime totals. An action is judged on its last few
 *    uses and one success ends a failure streak. Lifetime counters would
 *    teach an agent to avoid a tool forever after one bad stretch.
 *
 *  - Nothing free-form reaches the prompt. This block is re-read on every
 *    turn, and tool errors can carry text from web pages or other agents, so
 *    a quoted error would be a prompt injection that persists. Only tool
 *    names, a sanitised command name and a fixed set of error labels are
 *    rendered.
 *
 *  - A tool call that did not fail is not a goal that was met. Goal results
 *    come only from the agent closing its goals (see outcomes.ts), and money
 *    received comes only from the control plane's ledger. Both are reported
 *    as counts and amounts.
 */

import type BetterSqlite3 from "better-sqlite3";
import { periodStart, readLedgerSpend, summariseGoals, summariseIncome, type GoalSummary, type IncomeSummary, type LedgerSpend } from "./outcomes.js";
import { createLogger } from "../observability/logger.js";
import { formatTrialLines } from "../self-mod/trials.js";

const logger = createLogger("memory.track-record");

type Database = BetterSqlite3.Database;

/** Turns looked at. Large enough to show a pattern, small enough to follow a change. */
export const TRACK_RECORD_TURNS = 50;
/** An action is judged on at most this many of its latest uses. */
export const ACTION_WINDOW = 10;
const MAX_FAILING_LINES = 5;
const MAX_SEQUENCE_LINES = 3;
const MAX_SEQUENCE_STEPS = 6;
/** Active turns after which an unclosed goal, or no goals at all, is worth a line. */
export const OPEN_GOAL_WARNING_TURNS = 10;

/** The only failure labels that can appear in the prompt. */
const FAILURE_LABELS: Array<[RegExp, string]> = [
  [/policy denied|denied.by.policy/i, "POLICY_DENIED"],
  [/unknown tool/i, "UNKNOWN_TOOL"],
  [/path.traversal/i, "PATH_TRAVERSAL"],
  [/permission.denied|access.denied|forbidden|\b403\b/i, "PERMISSION_DENIED"],
  [/timeout|timed?\s*out/i, "TIMEOUT"],
  [/rate.limit|too.many.requests|\b429\b/i, "RATE_LIMIT"],
  [/insufficient|payment required|\b402\b/i, "INSUFFICIENT_FUNDS"],
  [/not.found|no.such|does.not.exist|enoent|\b404\b/i, "NOT_FOUND"],
  [/eaddrinuse|address.already.in.use/i, "ADDRESS_IN_USE"],
  [/econnrefused|connection.refused/i, "CONNECTION_REFUSED"],
  [/out.of.memory|\boom\b|enomem/i, "OUT_OF_MEMORY"],
  [/syntax.error|parse.error|unexpected.token/i, "SYNTAX_ERROR"],
];

/**
 * Decide whether a tool call failed, and why, as one of a fixed set of labels.
 * Returns null when the call succeeded.
 *
 * The `error` field alone is not enough: `exec` reports a failing command as
 * ordinary result text ("exit_code: 1 ..."), and refused commands and paths
 * come back as "Blocked: ...". Both would otherwise count as successes.
 */
export function failureLabel(result: string | null | undefined, error: string | null | undefined): string | null {
  if (error) {
    for (const [pattern, label] of FAILURE_LABELS) if (pattern.test(error)) return label;
    return "ERROR";
  }
  const head = (result ?? "").slice(0, 64);
  const exit = /^exit_code: (-?\d{1,5})\b/.exec(head);
  if (exit) {
    const code = Number(exit[1]);
    if (code === 0) return null;
    // 124 is what `timeout` and the sandbox report for a command that ran too long.
    return code === 124 ? "TIMEOUT" : "EXIT_NONZERO";
  }
  if (/^Blocked:/.test(head)) return "BLOCKED";
  return null;
}

/** Tool names come from model output; keep only what a real tool name can contain. */
function safeToolName(name: unknown): string {
  const s = typeof name === "string" ? name : "";
  return /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(s) ? s : "unknown_tool";
}

/**
 * For `exec`, the program being run ("git", "npm") separates outcomes that
 * have nothing to do with each other. Returns undefined unless the first
 * word is a plain program name.
 */
export function commandName(args: unknown): string | undefined {
  const command = (args as { command?: unknown } | null)?.command;
  if (typeof command !== "string") return undefined;
  let rest = command.trim();
  // Skip leading "cd dir &&", environment assignments and sudo.
  for (let i = 0; i < 4; i++) {
    const before = rest;
    rest = rest
      .replace(/^cd\s+\S+\s*(&&|;)\s*/, "")
      .replace(/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/, "")
      .replace(/^sudo\s+/, "");
    if (rest === before) break;
  }
  const word = (rest.split(/\s+/)[0] ?? "").split("/").pop() ?? "";
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,23}$/.test(word) ? word.toLowerCase() : undefined;
}

export interface ActionRecord {
  /** "exec(git)" or "write_file". */
  action: string;
  /** Uses counted, at most ACTION_WINDOW, newest first. */
  uses: number;
  failures: number;
  /** Consecutive failures up to and including the most recent use. */
  failureStreak: number;
  /** Most frequent failure label among the counted uses. */
  commonFailure: string | null;
  /** How many turns back this action last succeeded (1 = the previous turn); null if it never did in the window. */
  turnsSinceOk: number | null;
}

export interface SequenceRecord {
  /** "exec > write_file > exec×2" */
  signature: string;
  turns: number;
  /** Turns in which no call failed. */
  cleanTurns: number;
  averageCostCents: number;
}

export interface TrackRecord {
  turns: number;
  totalCostCents: number;
  /** Turns that made no tool call. */
  idleTurns: number;
  idleCostCents: number;
  actions: ActionRecord[];
  sequences: SequenceRecord[];
  /** Goals the agent closed in this period, and goals still open. */
  goals: GoalSummary;
  /** Money received in this period. */
  income: IncomeSummary;
  /** Money received since the account was opened. */
  lifetimeIncome: IncomeSummary;
  /** What the ledger says was spent, by kind; null when it could not be read for this period. */
  spend: LedgerSpend | null;
}

interface TurnRow {
  id: string;
  cost_cents: number | null;
  timestamp: string;
  created_at: string;
}

const NO_GROUP = { count: 0, averageTurns: 0, averageCostCents: 0 };
const NO_GOALS: GoalSummary = { achieved: NO_GROUP, failed: NO_GROUP, abandoned: NO_GROUP, achievedVerified: 0, open: 0, openWithCheck: 0, longestOpenTurns: 0, longestOpenCostCents: 0 };
const NO_INCOME: IncomeSummary = { tracked: false, fundingCents: 0, earnedCents: 0 };
interface CallRow {
  turn_id: string;
  name: string;
  arguments: string;
  head: string | null;
  error: string | null;
}

function signatureOf(names: string[]): string {
  const steps: string[] = [];
  let i = 0;
  while (i < names.length) {
    let j = i;
    while (j + 1 < names.length && names[j + 1] === names[i]) j++;
    steps.push(j > i ? `${names[i]}×${j - i + 1}` : names[i]!);
    i = j + 1;
  }
  return steps.length > MAX_SEQUENCE_STEPS ? `${steps.slice(0, MAX_SEQUENCE_STEPS).join(" > ")} > …` : steps.join(" > ");
}

/**
 * Summarise the outcomes of the agent's most recent turns.
 * Never throws: a failure here must not stop the agent loop.
 */
export function computeTrackRecord(db: Database, maxTurns = TRACK_RECORD_TURNS): TrackRecord {
  const empty: TrackRecord = { turns: 0, totalCostCents: 0, idleTurns: 0, idleCostCents: 0, actions: [], sequences: [], goals: NO_GOALS, income: NO_INCOME, lifetimeIncome: NO_INCOME, spend: null };
  try {
    // Newest first. rowid is insertion order; timestamps have one-second
    // resolution and several turns can share one.
    const turns = db.prepare("SELECT id, cost_cents, timestamp, created_at FROM turns ORDER BY rowid DESC LIMIT ?").all(maxTurns) as TurnRow[];
    if (turns.length === 0) return empty;

    const placeholders = turns.map(() => "?").join(",");
    const calls = db
      .prepare(
        `SELECT turn_id, name, arguments, substr(result, 1, 64) AS head, error
         FROM tool_calls WHERE turn_id IN (${placeholders}) ORDER BY rowid ASC`,
      )
      .all(...turns.map((t) => t.id)) as CallRow[];

    const callsByTurn = new Map<string, Array<{ action: string; tool: string; failure: string | null }>>();
    for (const c of calls) {
      const tool = safeToolName(c.name);
      let args: unknown = null;
      try {
        args = JSON.parse(c.arguments || "{}");
      } catch {
        // Unparseable arguments: the tool name alone identifies the action.
      }
      const program = tool === "exec" ? commandName(args) : undefined;
      const entry = { action: program ? `${tool}(${program})` : tool, tool, failure: failureLabel(c.head, c.error) };
      const list = callsByTurn.get(c.turn_id);
      if (list) list.push(entry);
      else callsByTurn.set(c.turn_id, [entry]);
    }

    let totalCostCents = 0;
    let idleTurns = 0;
    let idleCostCents = 0;
    // Per action: outcomes newest first, each with how many turns ago it happened.
    const outcomes = new Map<string, Array<{ failure: string | null; turnsAgo: number }>>();
    const sequences = new Map<string, { turns: number; cleanTurns: number; cost: number }>();

    turns.forEach((turn, index) => {
      // The turn being prepared is not stored yet, so the newest stored turn is one turn ago.
      const turnsAgo = index + 1;
      const cost = Number(turn.cost_cents) || 0;
      totalCostCents += cost;
      const turnCalls = callsByTurn.get(turn.id) ?? [];
      if (turnCalls.length === 0) {
        idleTurns++;
        idleCostCents += cost;
        return;
      }
      // Within a turn the latest call is last; walk backwards to stay newest-first.
      for (let i = turnCalls.length - 1; i >= 0; i--) {
        const c = turnCalls[i]!;
        const list = outcomes.get(c.action) ?? [];
        if (list.length < ACTION_WINDOW) list.push({ failure: c.failure, turnsAgo });
        outcomes.set(c.action, list);
      }
      const signature = signatureOf(turnCalls.map((c) => c.tool));
      const seq = sequences.get(signature) ?? { turns: 0, cleanTurns: 0, cost: 0 };
      seq.turns++;
      if (turnCalls.every((c) => c.failure === null)) seq.cleanTurns++;
      seq.cost += cost;
      sequences.set(signature, seq);
    });

    const actions: ActionRecord[] = [];
    for (const [action, list] of outcomes) {
      const failures = list.filter((o) => o.failure !== null);
      let failureStreak = 0;
      while (failureStreak < list.length && list[failureStreak]!.failure !== null) failureStreak++;
      const counts = new Map<string, number>();
      for (const f of failures) counts.set(f.failure!, (counts.get(f.failure!) ?? 0) + 1);
      const commonFailure = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
      const lastOk = list.find((o) => o.failure === null);
      actions.push({
        action,
        uses: list.length,
        failures: failures.length,
        failureStreak,
        commonFailure,
        turnsSinceOk: lastOk ? lastOk.turnsAgo : null,
      });
    }
    actions.sort((a, b) => b.failureStreak - a.failureStreak || b.failures - a.failures || a.action.localeCompare(b.action));

    const sequenceList: SequenceRecord[] = [...sequences.entries()]
      .map(([signature, s]) => ({ signature, turns: s.turns, cleanTurns: s.cleanTurns, averageCostCents: s.cost / s.turns }))
      .sort((a, b) => b.turns - a.turns || a.signature.localeCompare(b.signature));

    // Goals, income and ledger spend cover the same stretch of time as the turns above.
    const period = periodStart(db, maxTurns);
    let goals = NO_GOALS;
    let income = NO_INCOME;
    let lifetimeIncome = NO_INCOME;
    let spend: LedgerSpend | null = null;
    try {
      if (period) {
        goals = summariseGoals(db, period.sqlite);
        income = summariseIncome(db, period.iso);
        lifetimeIncome = summariseIncome(db, "");
        spend = readLedgerSpend(db, period.iso);
      }
    } catch (error) {
      // A database from before these tables existed: report tool outcomes alone.
      logger.error("Goal and income summary failed", error instanceof Error ? error : undefined);
    }

    return { turns: turns.length, totalCostCents, idleTurns, idleCostCents, actions, sequences: sequenceList, goals, income, lifetimeIncome, spend };
  } catch (error) {
    logger.error("Track record failed", error instanceof Error ? error : undefined);
    return empty;
  }
}

/** An action worth warning about: failing repeatedly right now, or failing at least half the time. */
export function isFailing(a: ActionRecord): boolean {
  return a.failureStreak >= 2 || (a.uses >= 3 && a.failures * 2 >= a.uses);
}

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(4)}`;
}
function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/**
 * Render the track record for the prompt. Returns "" when there is nothing
 * the agent could act on, so an uneventful history costs no tokens.
 */
export function formatTrackRecord(record: TrackRecord, trialLines: string[] = []): string {
  if (record.turns < 3 && trialLines.length === 0) return "";
  const lines: string[] = [];

  const failing = record.actions.filter(isFailing).slice(0, MAX_FAILING_LINES);
  for (const a of failing) {
    const what =
      a.failureStreak >= 2 && a.failureStreak === a.uses
        ? `failed all ${a.uses} recent tries`
        : a.failureStreak >= 2
          ? `failed the last ${a.failureStreak} tries in a row (${a.failures} of the last ${a.uses})`
          : `failed ${a.failures} of the last ${a.uses} tries`;
    const since =
      a.turnsSinceOk === null ? "It has not succeeded in this period." : `It last succeeded ${plural(a.turnsSinceOk, "turn")} ago.`;
    lines.push(`- Failing: ${a.action} ${what}${a.commonFailure ? `, mostly ${a.commonFailure}` : ""}. ${since}`);
  }

  const sequences = record.sequences.filter((s) => s.turns >= 3).slice(0, MAX_SEQUENCE_LINES);
  for (const s of sequences) {
    const clean = s.cleanTurns === 0 ? "none without a failure" : `${s.cleanTurns} without a failure`;
    lines.push(`- Sequence ${s.signature}: ${plural(s.turns, "turn")}, ${clean}, ${dollars(s.averageCostCents)} per turn.`);
  }

  // Goals: the only direct evidence of whether the work achieved anything.
  const g = record.goals;
  const closed = g.achieved.count + g.failed.count + g.abandoned.count;
  const goalLines: string[] = [];
  if (closed > 0) {
    const detail = (label: string, grp: typeof g.achieved) =>
      grp.count > 0 ? ` ${label} goals took ${grp.averageTurns.toFixed(1)} turns and ${dollars(grp.averageCostCents)} each on average.` : "";
    const unverified = g.achieved.count - g.achievedVerified;
    const how =
      g.achieved.count === 0
        ? ""
        : unverified === 0
          ? ` (${g.achievedVerified === 1 ? "its check passed" : "all checks passed"})`
          : ` (${g.achievedVerified} with a passing check, ${unverified} on your word alone)`;
    goalLines.push(
      `- Goals closed: ${g.achieved.count} achieved${how}, ${g.failed.count} failed, ${g.abandoned.count} abandoned.` +
        detail("Achieved", g.achieved) +
        detail("Failed", g.failed) +
        (unverified > 0 ? " Give a goal a check when you set it (a command that exits 0 only when the goal is met) so that achieved is evidence." : ""),
    );
  }
  if (g.open > 0 && g.longestOpenTurns >= OPEN_GOAL_WARNING_TURNS) {
    goalLines.push(
      `- Open goals: ${g.open}. One has taken ${plural(g.longestOpenTurns, "turn")} and ${dollars(g.longestOpenCostCents)} so far. Close it as achieved, failed or abandoned, or change approach.`,
    );
  }
  const activeTurns = record.turns - record.idleTurns;
  if (closed === 0 && g.open === 0 && activeTurns >= OPEN_GOAL_WARNING_TURNS) {
    goalLines.push(
      "- Goals closed: none. Without them this record cannot tell which of your approaches work. Use set_goal (with a check) before a piece of work and complete_goal (result: achieved, failed or abandoned) after it.",
    );
  }

  // Money. With the ledger's spend figures the net is complete: inference,
  // container time and transfers out, for this period and since launch.
  // Without them, income (if known) is set against the turns' inference cost.
  const inc = record.income;
  const moneyLines: string[] = [];
  const received = inc.fundingCents + inc.earnedCents;
  const signed = (cents: number) => `${cents >= 0 ? "+" : "-"}${dollars(Math.abs(cents))}`;
  if (record.spend && inc.tracked) {
    const p = record.spend.period;
    const spentPeriod = p.inferenceCents + p.computeCents + p.sentCents;
    const l = record.spend.lifetime;
    const li = record.lifetimeIncome;
    const spentLife = l.inferenceCents + l.computeCents + l.sentCents;
    const receivedLife = li.fundingCents + li.earnedCents;
    const kinds = (k: typeof p) => `inference ${dollars(k.inferenceCents)}, container ${dollars(k.computeCents)}, sent ${dollars(k.sentCents)}`;
    const lifeLine =
      `spent ${dollars(spentLife)} (${kinds(l)}); ` +
      `received ${dollars(receivedLife)} (earned ${dollars(li.earnedCents)}, funding ${dollars(li.fundingCents)}).`;
    // A young agent's period is its whole life; one line then says it all.
    const same = Math.abs(spentPeriod - spentLife) < 1e-9 && Math.abs(received - receivedLife) < 1e-9;
    if (same) {
      moneyLines.push(`- Ledger, since launch: ${lifeLine} Net: ${signed(receivedLife - spentLife)}. Balance: ${dollars(record.spend.balanceCents)}.`);
    } else {
      moneyLines.push(
        `- Ledger, this period: spent ${dollars(spentPeriod)} (${kinds(p)}); ` +
          `received ${dollars(received)} (earned ${dollars(inc.earnedCents)}, funding ${dollars(inc.fundingCents)}). Net: ${signed(received - spentPeriod)}.`,
      );
      moneyLines.push(`- Ledger, since launch: ${lifeLine} Balance: ${dollars(record.spend.balanceCents)}.`);
    }
  } else if (inc.tracked) {
    const net = received - record.totalCostCents;
    moneyLines.push(
      received > 0
        ? `- Income: ${dollars(inc.earnedCents)} earned from jobs and customers, ${dollars(inc.fundingCents)} funding (top-ups and transfers). Net of inference spend: ${signed(net)}.`
        : `- Income: none in this period. Net of inference spend: -${dollars(record.totalCostCents)}.`,
    );
  }
  const incomeNotable = inc.tracked && (received > 0 || record.turns >= OPEN_GOAL_WARNING_TURNS);

  const idleHeavy = record.idleTurns >= 3 && record.idleTurns * 2 >= record.turns;
  // A sequence that always runs clean is context, not news: it is listed
  // when the block appears for another reason, but does not cause it to.
  const sequenceNotable = sequences.some((s) => s.cleanTurns < s.turns);
  if (failing.length === 0 && !sequenceNotable && goalLines.length === 0 && !idleHeavy && !incomeNotable && trialLines.length === 0) return "";

  const spend = record.turns === 0 ? "" :
    `- Spend: ${dollars(record.totalCostCents)} on inference over ${plural(record.turns, "turn")}, ${dollars(record.totalCostCents / record.turns)} per turn.` +
    (idleHeavy ? ` ${plural(record.idleTurns, "turn")} made no tool call and cost ${dollars(record.idleCostCents)}.` : "");

  return [
    `## Track Record (your last ${plural(record.turns, "turn")}, computed from your own logs)`,
    `"Failed" for an action means the tool returned an error, a non-zero exit code, or was blocked. A call that did not fail may still not have met your goal; only closed goals show that.`,
    spend,
    ...moneyLines,
    ...goalLines,
    ...trialLines,
    ...lines,
    failing.length > 0 ? "Before repeating a failing action, change the approach or the inputs. One success clears the warning." : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Compute and render in one step. Returns "" on any failure. */
export function buildTrackRecordBlock(db: Database, maxTurns = TRACK_RECORD_TURNS): string {
  try {
    return formatTrackRecord(computeTrackRecord(db, maxTurns), formatTrialLines(db));
  } catch (error) {
    logger.error("Track record block failed", error instanceof Error ? error : undefined);
    return "";
  }
}
