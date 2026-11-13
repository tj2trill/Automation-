/**
 * Shared fixtures for control-plane tests: an in-memory container driver, a
 * scripted model upstream, and a running host on an ephemeral port.
 */

import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { SiweMessage } from "siwe";
import type { InferenceResponse } from "../../types.js";
import { DEFAULT_HOST_CONFIG, type HostConfig } from "../../host/config.js";
import type { ContainerState, CreateContainerOptions, DriverExecResult, SandboxDriver } from "../../host/docker.js";
import type { UpstreamChat } from "../../host/inference-proxy.js";
import { startHostServer, type RunningHost } from "../../host/server.js";
import { HostStore } from "../../host/store.js";
import { Economy, type EconomyOptions, type FetchLike } from "../../host/economy.js";
import { Storefront, startStorefrontServer } from "../../host/storefront.js";
import fs from "fs";
import os from "os";
import path from "path";

interface FakeContainer {
  opts: CreateContainerOptions;
  state: ContainerState;
  files: Map<string, string>;
  runtimeRunning: boolean;
  walletAddress: string;
  ip: string;
  execLog: string[];
}

/** Behaves like Docker for the commands the host actually issues. */
export class FakeDriver implements SandboxDriver {
  containers = new Map<string, FakeContainer>();
  networks = new Set<string>();
  images = new Set<string>(["automaton-agent:local"]);
  /** Set to make the next runtime start fail (process exits immediately). */
  runtimeCrashes = false;
  /** Every container ever created, including removed ones. */
  created: CreateContainerOptions[] = [];
  /** Delay applied to job checks, to test races. */
  checkDelayMs = 0;
  private nextIp = 2;

  async ensureNetwork(name: string): Promise<void> {
    this.networks.add(name);
  }
  async imageExists(image: string): Promise<boolean> {
    return this.images.has(image);
  }
  async create(opts: CreateContainerOptions): Promise<void> {
    if (this.containers.has(opts.containerName)) throw new Error("container name in use");
    this.created.push(opts);
    this.containers.set(opts.containerName, {
      opts,
      state: "running",
      files: new Map(),
      runtimeRunning: false,
      walletAddress: privateKeyToAccount(generatePrivateKey()).address,
      ip: `172.30.0.${this.nextIp++}`,
      execLog: [],
    });
  }
  private get(name: string): FakeContainer {
    const c = this.containers.get(name);
    if (!c) throw new Error(`No such container: ${name}`);
    return c;
  }
  async exec(name: string, command: string): Promise<DriverExecResult> {
    const c = this.get(name);
    if (c.state !== "running") return { stdout: "", stderr: "container is not running", exitCode: 1 };
    c.execLog.push(command);
    // Job checks: "answer-is X" passes when answer.txt holds exactly X.
    const check = /^cd \/submission && answer-is (.+)$/.exec(command);
    if (check) {
      if (this.checkDelayMs) await new Promise((r) => setTimeout(r, this.checkDelayMs));
      const answer = (c.files.get("/submission/answer.txt") ?? "").trim();
      return answer === check[1]!.trim()
        ? { stdout: "correct\n", stderr: "", exitCode: 0 }
        : { stdout: `expected ${check[1]}\n`, stderr: "", exitCode: 1 };
    }
    if (command.includes("--init")) return { stdout: `Wallet initialized: ${c.walletAddress}\n`, stderr: "", exitCode: 0 };
    if (command.startsWith("nohup")) {
      c.runtimeRunning = !this.runtimeCrashes;
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    if (command.includes("pgrep")) return { stdout: c.runtimeRunning ? "running\n" : "stopped\n", stderr: "", exitCode: 0 };
    if (command.startsWith("tail")) return { stdout: c.files.get("/root/.automaton/agent.log") ?? "line one\nline two\n", stderr: "", exitCode: 0 };
    if (command.startsWith("sleep")) return { stdout: "", stderr: "", exitCode: 0 };
    // The Conway client prefixes "cd /root && ..."; a real shell returns the
    // status of the last segment, so match `exit N` as the final segment.
    const exitMatch = /(?:^|&&\s*|;\s*)exit\s+(\d+)\s*$/.exec(command);
    if (exitMatch) return { stdout: "", stderr: "", exitCode: Number(exitMatch[1]) };
    return { stdout: `ran: ${command}\n`, stderr: "", exitCode: 0 };
  }
  async writeFile(name: string, filePath: string, content: string): Promise<void> {
    this.get(name).files.set(filePath, content);
  }
  async readFile(name: string, filePath: string): Promise<string> {
    const v = this.get(name).files.get(filePath);
    if (v === undefined) {
      const err: any = new Error(`read ${filePath} failed: No such file or directory`);
      err.notFound = true;
      throw err;
    }
    return v;
  }
  async state(name: string): Promise<ContainerState> {
    return this.containers.get(name)?.state ?? "missing";
  }
  async ip(name: string): Promise<string | null> {
    const c = this.containers.get(name);
    return c && c.state === "running" ? c.ip : null;
  }
  async stop(name: string): Promise<void> {
    const c = this.get(name);
    c.state = "stopped";
    c.runtimeRunning = false;
  }
  async start(name: string): Promise<void> {
    this.get(name).state = "running";
  }
  async remove(name: string): Promise<void> {
    this.containers.delete(name);
  }
}

export function testConfig(overrides: Partial<HostConfig> = {}): HostConfig {
  return {
    ...DEFAULT_HOST_CONFIG,
    port: 0,
    dashboardPort: 0,
    storefront: { ...DEFAULT_HOST_CONFIG.storefront, port: 0 },
    models: [
      { id: "big-model", upstream: "openai", inputPerMillionUsd: 3, outputPerMillionUsd: 15, roles: ["primary"], maxTokens: 8192 },
      { id: "local-model", upstream: "ollama", inputPerMillionUsd: 0, outputPerMillionUsd: 0, roles: ["low_compute", "critical"], maxTokens: 2048 },
    ],
    ...overrides,
  };
}

export interface UpstreamCall {
  model: string;
  messages: number;
  maxTokens: number;
  tools: number;
}

/** A model upstream that records calls and can be told to fail per model id. */
export function scriptedUpstream(): { chat: UpstreamChat; calls: UpstreamCall[]; failing: Map<string, Error>; usage: { in: number; out: number } } {
  const calls: UpstreamCall[] = [];
  const failing = new Map<string, Error>();
  const usage = { in: 1000, out: 200 };
  const chat: UpstreamChat = async (model, messages, opts) => {
    calls.push({ model: model.id, messages: messages.length, maxTokens: opts.maxTokens, tools: opts.tools?.length ?? 0 });
    const failure = failing.get(model.id);
    if (failure) throw failure;
    const response: InferenceResponse = {
      id: `resp-${calls.length}`,
      model: model.id,
      message: { role: "assistant", content: `hello from ${model.id}` },
      usage: { promptTokens: usage.in, completionTokens: usage.out, totalTokens: usage.in + usage.out },
      finishReason: "stop",
    };
    return response;
  };
  return { chat, calls, failing, usage };
}

export interface TestHost {
  url: string;
  config: HostConfig;
  store: HostStore;
  driver: FakeDriver;
  upstream: ReturnType<typeof scriptedUpstream>;
  economy: Economy;
  storefront: Storefront;
  /** The public store, on loopback. */
  shopUrl: string;
  filesDir: string;
  running: RunningHost;
  logs: string[];
  close(): Promise<void>;
}

export async function startTestHost(
  overrides: Partial<HostConfig> = {},
  economyOptions: EconomyOptions = {},
  storefrontOptions: { printfulToken?: string; printfulFetch?: FetchLike } = {},
): Promise<TestHost> {
  const config = testConfig(overrides);
  const store = new HostStore(":memory:");
  const driver = new FakeDriver();
  const upstream = scriptedUpstream();
  const logs: string[] = [];
  const economy = new Economy(config, store, driver, { log: (m) => logs.push(m), ...economyOptions });
  const filesDir = fs.mkdtempSync(path.join(os.tmpdir(), "store-files-"));
  const storefront = new Storefront(config, store, economy, { filesDir, log: (m) => logs.push(m), ...storefrontOptions });
  economy.deathHooks.push((a) => storefront.removeStoreOf(a));
  const shop = await startStorefrontServer({ storefront, log: (m) => logs.push(m) });
  const running = await startHostServer(
    { config, store, driver, upstream: upstream.chat, containerHostUrl: "http://automaton-host:4820", log: (m) => logs.push(m), economy, storefront },
    ["127.0.0.1"],
    { billingIntervalMs: 3_600_000 },
  );
  const url = `http://${running.addresses[0]}`;
  return {
    url,
    config,
    store,
    driver,
    upstream,
    economy,
    storefront,
    shopUrl: `http://127.0.0.1:${shop.port}`,
    filesDir,
    running,
    logs,
    close: async () => {
      await running.close();
      await shop.close();
      store.close();
      fs.rmSync(filesDir, { recursive: true, force: true });
    },
  };
}

/** Sign in with a fresh wallet exactly as the runtime does, returning an API key. */
export async function signIn(url: string, privateKey = generatePrivateKey()) {
  const account = privateKeyToAccount(privateKey);
  const nonce = ((await (await fetch(`${url}/v1/auth/nonce`, { method: "POST" })).json()) as any).nonce as string;
  const message = new SiweMessage({
    domain: new URL(url).host,
    address: account.address,
    statement: "Sign in as an Automaton to provision an API key.",
    uri: `${url}/v1/auth/verify`,
    version: "1",
    chainId: 8453,
    nonce,
    issuedAt: new Date().toISOString(),
  }).prepareMessage();
  const signature = await account.signMessage({ message });
  const verify = await fetch(`${url}/v1/auth/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, signature }),
  });
  const { access_token } = (await verify.json()) as any;
  const keyRes = await fetch(`${url}/v1/auth/api-keys`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${access_token}` },
    body: JSON.stringify({ name: "test" }),
  });
  const { key } = (await keyRes.json()) as any;
  return { account, privateKey, apiKey: key as string, address: account.address.toLowerCase(), message, signature, nonce };
}

export async function call(url: string, method: string, path: string, apiKey?: string, body?: unknown) {
  const res = await fetch(`${url}${path}`, {
    method,
    headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(apiKey ? { Authorization: apiKey } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON */
  }
  return { status: res.status, json, text };
}
