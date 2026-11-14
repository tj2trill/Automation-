import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { DockerCliDriver } from "../../host/docker.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** A stand-in `docker` that records its arguments, one per line. */
function fakeDocker(): { bin: string; args: () => string[] } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-docker-"));
  dirs.push(dir);
  const log = path.join(dir, "args");
  const bin = path.join(dir, "docker");
  fs.writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$@" > '${log}'\n`, { mode: 0o755 });
  return { bin, args: () => fs.readFileSync(log, "utf-8").trimEnd().split("\n") };
}

const create = (driver: DockerCliDriver) =>
  driver.create({
    containerName: "automaton-test",
    image: "automaton-agent:local",
    network: "automaton-net",
    memoryMb: 512,
    cpus: 1,
    pidsLimit: 256,
    env: { A: "1" },
    labels: { "automaton.owner": "0xabc" },
    hostAliases: { host: "172.30.0.1" },
  });

const valuesOf = (args: string[], flag: string) => args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []));

describe("docker driver: container security", () => {
  it("starts every container unable to gain privileges and without the capabilities an agent never needs", async () => {
    const docker = fakeDocker();
    await create(new DockerCliDriver(docker.bin));
    const args = docker.args();

    expect(valuesOf(args, "--security-opt")).toContain("no-new-privileges");
    expect(valuesOf(args, "--cap-drop").sort()).toEqual(["AUDIT_WRITE", "MKNOD", "NET_RAW", "SETFCAP", "SYS_CHROOT"]);
    // Never the flags that would hand the container the host.
    expect(args).not.toContain("--privileged");
    expect(args).not.toContain("--cap-add");
    expect(args.some((a) => a === "-v" || a === "--volume" || a === "--mount" || a === "--pid" || a === "--device")).toBe(false);
    // The resource limits stay in place.
    expect(valuesOf(args, "--memory")).toEqual(["512m"]);
    expect(valuesOf(args, "--memory-swap")).toEqual(["512m"]);
    expect(valuesOf(args, "--pids-limit")).toEqual(["256"]);
    expect(args.slice(-3)).toEqual(["automaton-agent:local", "sleep", "infinity"]);
  });
});
