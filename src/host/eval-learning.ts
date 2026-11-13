/**
 * Learning eval — does a model act on the track record?
 *
 * The track record is information in the prompt. Tests can show that it is
 * correct and that it reaches the model; only running a model shows whether
 * the model changes course because of it. This eval measures that on the
 * creator's own model.
 *
 * Method: the same situation is put to the model many times, half without
 * the track record (control) and half with it (treatment). The situation is
 * the one the record exists for: the agent wakes with a standing task
 * (`git push`), and the earlier failures have scrolled out of its context, so
 * the record is the only place they appear. Each reply is classified by what
 * the model does first: repeat the failing command, or anything else.
 *
 * The control arm is told to push and has no reason not to, so repeating
 * there is expected. The result is the difference between the arms.
 *
 * The calls go straight to the model provider with the creator's key. They
 * are not charged to any agent's ledger; the provider bills them.
 */

import type { ChatMessage, InferenceResponse, InferenceToolDefinition } from "../types.js";
import { formatTrackRecord, type TrackRecord } from "../memory/track-record.js";
import type { HostModelConfig } from "./config.js";
import { costMicro, type UpstreamChat } from "./inference-proxy.js";

const SYSTEM_PROMPT = [
  "You are an autonomous agent running in your own Linux container. You pay for every turn from a small balance, so wasted turns shorten your life.",
  "You act only by calling tools. Each turn, decide the single most useful next action and take it.",
].join("\n");

const WAKE_MESSAGE =
  "You have woken up. Your standing task is to publish your work to the remote with `git push origin main`. Take your next action.";

/** The record an agent would see after four failed pushes, built by the real formatter. */
export function evalTrackRecord(): string {
  const none = { count: 0, averageTurns: 0, averageCostCents: 0 };
  const record: TrackRecord = {
    turns: 12,
    totalCostCents: 12,
    idleTurns: 2,
    idleCostCents: 2,
    actions: [{ action: "exec(git)", uses: 4, failures: 4, failureStreak: 4, commonFailure: "EXIT_NONZERO", turnsSinceOk: null }],
    sequences: [{ signature: "exec", turns: 4, cleanTurns: 0, averageCostCents: 1 }],
    goals: { achieved: none, failed: none, abandoned: none, achievedVerified: 0, open: 0, openWithCheck: 0, longestOpenTurns: 0, longestOpenCostCents: 0 },
    income: { tracked: false, fundingCents: 0, earnedCents: 0 },
    lifetimeIncome: { tracked: false, fundingCents: 0, earnedCents: 0 },
    spend: null,
  };
  return formatTrackRecord(record);
}

const TOOLS: InferenceToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "exec",
      description: "Execute a shell command in your container. Returns stdout, stderr, and exit code.",
      parameters: { type: "object", properties: { command: { type: "string", description: "The shell command to execute" } }, required: ["command"] },
    },
  },
  {
    type: "function",
    function: {
      name: "send_message",
      description: "Send a message to your creator.",
      parameters: { type: "object", properties: { content: { type: "string" } }, required: ["content"] },
    },
  },
  {
    type: "function",
    function: {
      name: "sleep",
      description: "Sleep until the next wake-up. Costs nothing.",
      parameters: { type: "object", properties: { reason: { type: "string" } }, required: [] },
    },
  },
];

export type TrialOutcome = "repeated" | "changed" | "error";

/** Did the model's reply run the failing command again? */
export function classifyReply(response: Pick<InferenceResponse, "toolCalls">): Exclude<TrialOutcome, "error"> {
  for (const call of response.toolCalls ?? []) {
    if (call.function?.name !== "exec") continue;
    let command = "";
    try {
      command = String((JSON.parse(call.function.arguments || "{}") as { command?: unknown }).command ?? "");
    } catch {
      command = String(call.function.arguments ?? "");
    }
    if (/\bgit\b[^|;&]*\bpush\b/.test(command)) return "repeated";
  }
  return "changed";
}

export interface ArmResult {
  trials: number;
  repeated: number;
  changed: number;
  errors: number;
  /** What the model did instead, by first tool called ("(text only)" for none), with counts. */
  alternatives: Record<string, number>;
}

export interface LearningEvalReport {
  model: string;
  control: ArmResult;
  treatment: ArmResult;
  /** Provider cost of the eval's own calls at the configured prices, in micro-dollars. */
  costMicro: number;
  firstError?: string;
}

function buildMessages(withRecord: boolean): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: "system", content: SYSTEM_PROMPT }];
  if (withRecord) messages.push({ role: "system", content: evalTrackRecord() });
  messages.push({ role: "user", content: WAKE_MESSAGE });
  return messages;
}

export async function runLearningEval(opts: { model: HostModelConfig; chat: UpstreamChat; trials: number; onTrial?: (arm: "control" | "treatment", outcome: TrialOutcome) => void }): Promise<LearningEvalReport> {
  const trials = Math.max(1, Math.min(50, Math.floor(opts.trials) || 1));
  const empty = (): ArmResult => ({ trials: 0, repeated: 0, changed: 0, errors: 0, alternatives: {} });
  const report: LearningEvalReport = { model: opts.model.id, control: empty(), treatment: empty(), costMicro: 0 };

  // Alternate the arms so that drift in the provider's behaviour over the run falls on both.
  for (let i = 0; i < trials * 2; i++) {
    const armName = i % 2 === 0 ? "control" : "treatment";
    const arm = report[armName];
    arm.trials++;
    try {
      const response = await opts.chat(opts.model, buildMessages(armName === "treatment"), { maxTokens: 300, tools: TOOLS });
      report.costMicro += costMicro(opts.model, response.usage?.promptTokens ?? 0, response.usage?.completionTokens ?? 0);
      const outcome = classifyReply(response);
      arm[outcome]++;
      if (outcome === "changed") {
        const first = response.toolCalls?.[0]?.function?.name ?? "(text only)";
        const label = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/.test(first) || first === "(text only)" ? first : "(other)";
        arm.alternatives[label] = (arm.alternatives[label] ?? 0) + 1;
      }
      opts.onTrial?.(armName, outcome);
    } catch (error) {
      arm.errors++;
      report.firstError ??= error instanceof Error ? error.message : String(error);
      opts.onTrial?.(armName, "error");
    }
  }
  return report;
}

/** Plain-language result. States counts, not significance: the sample is small. */
export function formatLearningEval(report: LearningEvalReport): string {
  const line = (label: string, arm: ArmResult) => {
    const answered = arm.repeated + arm.changed;
    const alternatives = Object.entries(arm.alternatives)
      .sort((a, b) => b[1] - a[1])
      .map(([name, n]) => `${name} ${n}`)
      .join(", ");
    return (
      `${label}: repeated the failing command in ${arm.repeated} of ${answered} replies` +
      (alternatives ? `; did something else in ${arm.changed} (${alternatives})` : "") +
      (arm.errors ? `; ${arm.errors} call(s) failed` : "") +
      "."
    );
  };
  const c = report.control;
  const t = report.treatment;
  const answeredC = c.repeated + c.changed;
  const answeredT = t.repeated + t.changed;
  let verdict: string;
  if (answeredC === 0 || answeredT === 0) {
    verdict = `No result: the model did not answer in one or both arms.${report.firstError ? ` First error: ${report.firstError}` : ""}`;
  } else if (c.repeated === 0) {
    verdict = "No result: this model did not repeat the command even without the track record, so there was nothing for the record to change.";
  } else if (t.repeated < c.repeated && t.repeated / answeredT <= 0.5 * (c.repeated / answeredC)) {
    verdict = "With the track record this model repeated the failing command much less often.";
  } else if (t.repeated < c.repeated) {
    verdict = "With the track record this model repeated the failing command somewhat less often.";
  } else {
    verdict = "The track record did not reduce how often this model repeated the failing command.";
  }
  return [
    `Model: ${report.model}`,
    line("Without the track record", c),
    line("With the track record   ", t),
    verdict,
    `These are counts from ${answeredC + answeredT} replies, not a statistical test. Run more trials (--trials) for a steadier figure.`,
    `Provider cost of this eval at your configured prices: $${(report.costMicro / 1_000_000).toFixed(4)}.`,
  ].join("\n");
}
