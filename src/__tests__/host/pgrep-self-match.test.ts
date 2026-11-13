/**
 * Regression: the runtime-liveness probe runs through `sh -c`, and the shell's
 * own command line contains the pattern. An unescaped `pgrep -f 'index.js --run'`
 * therefore matches the shell itself and always reports "running". The probe
 * must be checked in a real shell, since the test fakes never run it.
 */
import { describe, it, expect } from "vitest";
import { execSync, spawn } from "child_process";

import { runtimeProbeCommand } from "../../host/admin.js";

// A marker no other process on the machine uses, so the result depends only
// on the probe and the process this test starts.
const MARKER = `probe-${process.pid}-${Date.now()}.js --run`;
const PROBE = runtimeProbeCommand(MARKER);

describe("runtime liveness probe", () => {
  it("uses the bracket form for the real runtime", () => {
    expect(runtimeProbeCommand()).toBe("pgrep -f '[i]ndex.js --run' > /dev/null && echo running || echo stopped");
    expect(() => runtimeProbeCommand("x'; rm -rf /")).toThrow();
  });

  it("reports stopped when no runtime process exists", () => {
    const out = execSync(`sh -c ${JSON.stringify(PROBE)}`, { encoding: "utf8" }).trim();
    expect(out).toBe("stopped");
  });

  it("reports running when a runtime process is alive", async () => {
    const child = spawn("node", ["-e", "setTimeout(() => {}, 5000)", ...MARKER.split(" ")], { stdio: "ignore" });
    try {
      await new Promise((r) => setTimeout(r, 300));
      const out = execSync(`sh -c ${JSON.stringify(PROBE)}`, { encoding: "utf8" }).trim();
      expect(out).toBe("running");
    } finally {
      child.kill();
    }
  });
});
