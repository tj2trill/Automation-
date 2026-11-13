/**
 * Host Control Plane — Docker sandbox driver
 *
 * Each agent (and each child) lives in its own container. The host drives
 * Docker through the CLI with argument arrays — nothing an agent supplies is
 * ever interpolated into a host shell. The agent's command string is passed
 * as a single argv element to `bash -c` INSIDE the container, which is the
 * boundary it is allowed to control.
 *
 * Containers get: no --privileged, no Docker socket, no host mounts, a
 * memory/CPU/pids cap, and a dedicated bridge network.
 */

import { spawn } from "child_process";

export interface DriverExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface CreateContainerOptions {
  containerName: string;
  image: string;
  network: string;
  memoryMb: number;
  cpus: number;
  pidsLimit: number;
  env: Record<string, string>;
  labels: Record<string, string>;
  /** Hostnames mapped to the host gateway so the container can reach the control plane. */
  hostAliases: Record<string, string>;
  /** No network at all (job checks: the submission is untrusted input). */
  noNetwork?: boolean;
}

export type ContainerState = "running" | "stopped" | "missing";

export interface SandboxDriver {
  ensureNetwork(name: string, subnet: string, gateway: string): Promise<void>;
  imageExists(image: string): Promise<boolean>;
  create(opts: CreateContainerOptions): Promise<void>;
  exec(containerName: string, command: string, timeoutMs?: number): Promise<DriverExecResult>;
  writeFile(containerName: string, filePath: string, content: string): Promise<void>;
  readFile(containerName: string, filePath: string): Promise<string>;
  state(containerName: string): Promise<ContainerState>;
  ip(containerName: string, network: string): Promise<string | null>;
  stop(containerName: string): Promise<void>;
  start(containerName: string): Promise<void>;
  remove(containerName: string): Promise<void>;
}

const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const HOME_DIR = "/root";

interface RunOptions {
  input?: string;
  timeoutMs?: number;
}

/** Run a host binary with an argv array; never a shell. */
export function runProcess(bin: string, args: string[], opts: RunOptions = {}): Promise<DriverExecResult & { timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let timedOut = false;
    let settled = false;

    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, opts.timeoutMs)
      : null;

    child.stdout.on("data", (d: Buffer) => {
      if (outBytes < MAX_OUTPUT_BYTES) out.push(d);
      outBytes += d.length;
    });
    child.stderr.on("data", (d: Buffer) => {
      if (errBytes < MAX_OUTPUT_BYTES) err.push(d);
      errBytes += d.length;
    });

    const finish = (exitCode: number, extraErr = "") => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(out).toString("utf-8"),
        stderr: Buffer.concat(err).toString("utf-8") + extraErr,
        exitCode,
        timedOut,
      });
    };

    child.on("error", (e) => finish(127, `\n${e.message}`));
    child.on("close", (code) => finish(code ?? (timedOut ? 124 : 1)));

    // The child may exit before reading stdin; that is not our error to throw.
    child.stdin.on("error", () => {});
    child.stdin.end(opts.input ?? "");
  });
}

function resolveContainerPath(filePath: string): string {
  if (filePath === "~") return HOME_DIR;
  if (filePath.startsWith("~/")) return `${HOME_DIR}/${filePath.slice(2)}`;
  return filePath;
}

export class DockerCliDriver implements SandboxDriver {
  constructor(private readonly dockerBin = "docker") {}

  private async docker(args: string[], opts: RunOptions = {}): Promise<DriverExecResult & { timedOut: boolean }> {
    return runProcess(this.dockerBin, args, opts);
  }

  private async dockerOrThrow(args: string[], what: string, opts: RunOptions = {}): Promise<string> {
    const r = await this.docker(args, { timeoutMs: 120_000, ...opts });
    if (r.exitCode !== 0) {
      throw new Error(`docker ${what} failed (exit ${r.exitCode}): ${r.stderr.trim() || r.stdout.trim()}`);
    }
    return r.stdout;
  }

  async ensureNetwork(name: string, subnet: string, gateway: string): Promise<void> {
    const inspect = await this.docker(["network", "inspect", name], { timeoutMs: 30_000 });
    if (inspect.exitCode === 0) return;
    await this.dockerOrThrow(
      ["network", "create", "--driver", "bridge", "--subnet", subnet, "--gateway", gateway, name],
      "network create",
    );
  }

  async imageExists(image: string): Promise<boolean> {
    const r = await this.docker(["image", "inspect", image], { timeoutMs: 30_000 });
    return r.exitCode === 0;
  }

  async create(opts: CreateContainerOptions): Promise<void> {
    const args = [
      "run", "-d",
      "--name", opts.containerName,
      "--hostname", opts.containerName,
      "--network", opts.noNetwork ? "none" : opts.network,
      "--memory", `${opts.memoryMb}m`,
      // No swap beyond the memory cap: a thrashing agent must hit its own limit, not the host's disk.
      "--memory-swap", `${opts.memoryMb}m`,
      "--cpus", String(opts.cpus),
      "--pids-limit", String(opts.pidsLimit),
      "--restart", opts.noNetwork ? "no" : "unless-stopped",
      // `docker run --init` gives PID 1 a reaper so backgrounded agent processes don't pile up as zombies.
      "--init",
      // No raw sockets: a container cannot forge another container's source
      // address on the bridge, which the host uses to tell sandboxes apart.
      "--cap-drop", "NET_RAW",
    ];
    for (const [host, ip] of Object.entries(opts.hostAliases)) args.push("--add-host", `${host}:${ip}`);
    for (const [k, v] of Object.entries(opts.env)) args.push("--env", `${k}=${v}`);
    for (const [k, v] of Object.entries(opts.labels)) args.push("--label", `${k}=${v}`);
    args.push(opts.image, "sleep", "infinity");
    await this.dockerOrThrow(args, "run");
  }

  async exec(containerName: string, command: string, timeoutMs = 30_000): Promise<DriverExecResult> {
    // The time limit is enforced INSIDE the container by coreutils `timeout`.
    // Killing only the `docker exec` client would leave the command running
    // in the container with nothing tracking it. The host-side timer is a
    // backstop for a hung Docker daemon, hence the margin.
    const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
    const r = await this.docker(
      ["exec", "-w", HOME_DIR, containerName, "timeout", "-k", "5", `${seconds}s`, "bash", "-c", command],
      { timeoutMs: timeoutMs + 15_000 },
    );
    if (r.exitCode === 124 || r.timedOut) {
      return {
        stdout: r.stdout,
        stderr: `${r.stderr}\nCommand timed out after ${seconds}s`.trim(),
        exitCode: 124,
      };
    }
    return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode };
  }

  async writeFile(containerName: string, filePath: string, content: string): Promise<void> {
    const target = resolveContainerPath(filePath);
    // Path travels as "$1", content on stdin — neither is parsed by a shell.
    const r = await this.docker(
      ["exec", "-i", containerName, "sh", "-c", 'mkdir -p "$(dirname "$1")" && cat > "$1"', "sh", target],
      { input: content, timeoutMs: 60_000 },
    );
    if (r.exitCode !== 0) {
      throw new Error(`write ${target} failed (exit ${r.exitCode}): ${r.stderr.trim()}`);
    }
  }

  async readFile(containerName: string, filePath: string): Promise<string> {
    const target = resolveContainerPath(filePath);
    const r = await this.docker(["exec", containerName, "cat", "--", target], { timeoutMs: 60_000 });
    if (r.exitCode !== 0) {
      const err: any = new Error(`read ${target} failed: ${r.stderr.trim()}`);
      err.notFound = /No such file/i.test(r.stderr);
      throw err;
    }
    return r.stdout;
  }

  async state(containerName: string): Promise<ContainerState> {
    const r = await this.docker(["inspect", "-f", "{{.State.Running}}", containerName], { timeoutMs: 30_000 });
    if (r.exitCode !== 0) return "missing";
    return r.stdout.trim() === "true" ? "running" : "stopped";
  }

  async ip(containerName: string, network: string): Promise<string | null> {
    const r = await this.docker(
      ["inspect", "-f", `{{with index .NetworkSettings.Networks "${network}"}}{{.IPAddress}}{{end}}`, containerName],
      { timeoutMs: 30_000 },
    );
    const ip = r.stdout.trim();
    return r.exitCode === 0 && ip ? ip : null;
  }

  async stop(containerName: string): Promise<void> {
    await this.dockerOrThrow(["stop", "-t", "5", containerName], "stop");
  }

  async start(containerName: string): Promise<void> {
    await this.dockerOrThrow(["start", containerName], "start");
  }

  async remove(containerName: string): Promise<void> {
    const r = await this.docker(["rm", "-f", containerName], { timeoutMs: 60_000 });
    if (r.exitCode !== 0 && !/No such container/i.test(r.stderr)) {
      throw new Error(`docker rm failed: ${r.stderr.trim()}`);
    }
  }
}
