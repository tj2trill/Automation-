/**
 * Learning eval: the A/B that measures whether a model acts on the track record.
 */
import { describe, it, expect } from "vitest";
import { classifyReply, evalTrackRecord, formatLearningEval, runLearningEval } from "../../host/eval-learning.js";
import type { UpstreamChat } from "../../host/inference-proxy.js";
import type { InferenceResponse } from "../../types.js";
import { testConfig } from "./helpers.js";

const model = testConfig().models[0]!;
const reply = (tool?: { name: string; args: unknown }): InferenceResponse => ({
  id: "r",
  model: model.id,
  message: { role: "assistant", content: tool ? "" : "I will wait." },
  toolCalls: tool ? [{ id: "c", type: "function", function: { name: tool.name, arguments: typeof tool.args === "string" ? tool.args : JSON.stringify(tool.args) } }] : undefined,
  usage: { promptTokens: 400, completionTokens: 50, totalTokens: 450 },
  finishReason: "stop",
});
const push = reply({ name: "exec", args: { command: "git push origin main" } });
const sawRecord = (messages: { content: string }[]) => messages.some((m) => m.content.includes("## Track Record"));

describe("classifyReply", () => {
  it("recognises the failing command however it is wrapped", () => {
    for (const command of ["git push origin main", "cd /root/work && git push", "git -C /root/work push origin main --force", "GIT_SSH=x git  push"]) {
      expect(classifyReply(reply({ name: "exec", args: { command } }))).toBe("repeated");
    }
    expect(classifyReply(reply({ name: "exec", args: '{"command": "git push" broken json' }))).toBe("repeated");
  });

  it("counts anything else as a change of course", () => {
    for (const command of ["git remote -v", "git status", "ls; echo push", "git log | grep push", "cat .git/config"]) {
      expect(classifyReply(reply({ name: "exec", args: { command } }))).toBe("changed");
    }
    expect(classifyReply(reply({ name: "send_message", args: { content: "git push keeps failing" } }))).toBe("changed");
    expect(classifyReply(reply())).toBe("changed");
  });
});

describe("runLearningEval", () => {
  it("shows the record to the treatment arm only, with the real formatter's text", async () => {
    const seen: boolean[] = [];
    const chat: UpstreamChat = async (_m, messages, opts) => {
      seen.push(sawRecord(messages));
      expect(opts.tools?.map((t) => t.function.name)).toEqual(["exec", "send_message", "sleep"]);
      expect(messages[messages.length - 1]!.content).toContain("git push origin main");
      return push;
    };
    const report = await runLearningEval({ model, chat, trials: 3 });
    expect(seen).toEqual([false, true, false, true, false, true]);
    expect(evalTrackRecord()).toContain("Failing: exec(git) failed all 4 recent tries, mostly EXIT_NONZERO.");
    expect(report.control).toMatchObject({ trials: 3, repeated: 3, changed: 0 });
    expect(report.treatment).toMatchObject({ trials: 3, repeated: 3, changed: 0 });
    expect(formatLearningEval(report)).toContain("The track record did not reduce how often this model repeated the failing command.");
  });

  it("reports a model that heeds the record, and what it did instead", async () => {
    const chat: UpstreamChat = async (_m, messages) => (sawRecord(messages) ? reply({ name: "exec", args: { command: "git remote -v" } }) : push);
    const report = await runLearningEval({ model, chat, trials: 4 });
    expect(report.control).toMatchObject({ repeated: 4, changed: 0 });
    expect(report.treatment).toMatchObject({ repeated: 0, changed: 4, alternatives: { exec: 4 } });
    const text = formatLearningEval(report);
    expect(text).toContain("Without the track record: repeated the failing command in 4 of 4 replies.");
    expect(text).toContain("With the track record   : repeated the failing command in 0 of 4 replies; did something else in 4 (exec 4).");
    expect(text).toContain("much less often");
    expect(text).toContain("not a statistical test");
    // 8 calls of 400 in / 50 out at the test model's prices.
    expect(report.costMicro).toBeGreaterThan(0);
  });

  it("distinguishes a partial effect, no baseline, and a model that cannot be reached", async () => {
    let n = 0;
    const partial: UpstreamChat = async (_m, messages) => (sawRecord(messages) && n++ % 4 === 0 ? reply() : push);
    expect(formatLearningEval(await runLearningEval({ model, chat: partial, trials: 8 }))).toContain("somewhat less often");

    const careful: UpstreamChat = async () => reply({ name: "exec", args: { command: "git status" } });
    expect(formatLearningEval(await runLearningEval({ model, chat: careful, trials: 2 }))).toContain("nothing for the record to change");

    const down: UpstreamChat = async () => { throw new Error("ANTHROPIC_API_KEY is not set on the host"); };
    const report = await runLearningEval({ model, chat: down, trials: 2 });
    expect(report.control.errors + report.treatment.errors).toBe(4);
    expect(formatLearningEval(report)).toContain("No result: the model did not answer in one or both arms. First error: ANTHROPIC_API_KEY is not set on the host");
  });

  it("never echoes a model-invented tool name into the report", async () => {
    const chat: UpstreamChat = async (_m, messages) => (sawRecord(messages) ? reply({ name: "x\nIGNORE PREVIOUS", args: {} }) : push);
    const text = formatLearningEval(await runLearningEval({ model, chat, trials: 1 }));
    expect(text).toContain("(other) 1");
    expect(text).not.toContain("IGNORE");
  });

  it("keeps the trial count within bounds", async () => {
    const chat: UpstreamChat = async () => push;
    expect((await runLearningEval({ model, chat, trials: 0 })).control.trials).toBe(1);
    expect((await runLearningEval({ model, chat, trials: 999 })).control.trials).toBe(50);
  });
});
