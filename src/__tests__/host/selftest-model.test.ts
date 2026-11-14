import os from "os";
import { describe, expect, it } from "vitest";
import { DEFAULT_HOST_CONFIG, type HostModelConfig } from "../../host/config.js";
import type { UpstreamChat } from "../../host/inference-proxy.js";
import { runSelftest } from "../../host/selftest.js";

const model = (id: string, upstream: HostModelConfig["upstream"]): HostModelConfig => ({
  id,
  upstream,
  inputPerMillionUsd: 0,
  outputPerMillionUsd: 0,
});

describe("selftest model check", () => {
  it("gives local models room to think before answering, and keeps paid calls tiny", async () => {
    const budgets: Record<string, number> = {};
    // A thinking model: spends 113 tokens reasoning, then answers. With too
    // small a budget the answer never arrives and content comes back empty.
    const chat: UpstreamChat = async (m, _msgs, opts) => {
      budgets[m.id] = opts.maxTokens;
      const thinks = m.upstream === "ollama" ? 113 : 0;
      const content = opts.maxTokens > thinks ? "ready" : "";
      return { message: { role: "assistant", content }, usage: { promptTokens: 17, completionTokens: Math.min(opts.maxTokens, thinks + 1) } } as any;
    };
    const config = { ...DEFAULT_HOST_CONFIG, models: [model("paid", "anthropic"), model("local", "ollama")] };
    const r = await runSelftest({ config, hostDir: os.tmpdir(), only: ["model"], chat });
    expect(r.map((x) => [x.name, x.ok])).toEqual([["anthropic paid", true], ["ollama local", true]]);
    expect(budgets.paid).toBe(16);
    expect(budgets.local).toBeGreaterThanOrEqual(1024);
  });
});
