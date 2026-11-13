#!/usr/bin/env node
/**
 * automaton-host — the creator's control surface.
 *
 * Runs on the creator's machine, outside every agent container. Everything
 * privileged (adding money, freezing, killing, removing) lives here and in
 * the loopback-only dashboard; none of it is on the agent-facing API.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  DEFAULT_HOST_CONFIG,
  getHostConfigPath,
  getHostDbPath,
  loadHostConfig,
  getHostDir,
  loadPrintfulToken, loadMailboxCredentials,
  loadStripeKey,
  loadUpstreamKeys,
  modelForRole,
  saveHostConfig,
  type HostConfig,
} from "./config.js";
import { AdminError, containerHostUrl, HostAdmin, loadOrCreateCreatorWallet } from "./admin.js";
import qrcode from "qrcode-terminal";
import {
  dashboardUrl,
  listPhoneAddresses,
  loadOrCreateDashboardToken,
  phoneDashboardUrl,
  type PhoneAddress,
  startDashboardServer,
} from "./dashboard.js";
import { DockerCliDriver, runProcess } from "./docker.js";
import { createUpstreamChat } from "./inference-proxy.js";
import { formatLearningEval, runLearningEval } from "./eval-learning.js";
import { startHostServer } from "./server.js";
import { Economy } from "./economy.js";
import { Storefront, startStorefrontServer } from "./storefront.js";
import { MarketResearch } from "./research.js";
import { Outreach } from "./outreach.js";
import { Sites, startSitesServer } from "./sites.js";
import { SmtpImapTransport, type MailTransport } from "./mail.js";
import { ALL_CHECKS, formatSelftest, runSelftest, type CheckName } from "./selftest.js";
import { formatUsd, HostStore } from "./store.js";

function repoRoot(): string {
  // dist/host/cli.js -> repo root
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

function die(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

function parseFlags(args: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      const next = args[i + 1];
      if (next === undefined || next.startsWith("--")) flags[a.slice(2)] = "true";
      else {
        flags[a.slice(2)] = next;
        i++;
      }
    } else positional.push(a);
  }
  return { positional, flags };
}

async function isServerUp(config: HostConfig): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${config.port}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Open the store and build the admin object every command shares. */
function openAdmin(): { admin: HostAdmin; store: HostStore; config: HostConfig } {
  const config = loadHostConfig();
  const store = new HostStore(getHostDbPath());
  const creator = loadOrCreateCreatorWallet();
  store.ensureAccount(creator.address, "creator");
  const driver = new DockerCliDriver();
  const economy = new Economy(config, store, driver, {
    creatorAddress: creator.address,
    stripeKey: loadStripeKey(),
    log: (m) => console.log(`[${new Date().toISOString()}] ${m}`),
  });
  const storefront = new Storefront(config, store, economy, {
    filesDir: path.join(getHostDir(), "store-files"),
    printfulToken: loadPrintfulToken(),
    log: (m) => console.log(`[${new Date().toISOString()}] ${m}`),
  });
  const outreach = new Outreach(config, store, { transport: mailTransport(config), log: (m) => console.log(`[${new Date().toISOString()}] ${m}`) });
  const sites = new Sites(config, store, economy, { filesDir: path.join(getHostDir(), "site-files"), log: (m) => console.log(`[${new Date().toISOString()}] ${m}`) });
  return { admin: new HostAdmin(config, store, driver, creator.address, economy, storefront, { outreach, sites }), store, config };
}

/** The creator's mailbox, if EMAIL_PASSWORD is set and the servers are configured. */
function mailTransport(config: HostConfig): MailTransport | undefined {
  const creds = loadMailboxCredentials(config);
  const em = config.email;
  if (!creds || !em.smtpHost || !em.imapHost) return undefined;
  return new SmtpImapTransport({ ...em, username: creds.username, password: creds.password });
}

// ─── Commands ──────────────────────────────────────────────────

async function cmdInit(): Promise<void> {
  const cfgPath = getHostConfigPath();
  if (fs.existsSync(cfgPath)) {
    console.log(`Config already exists: ${cfgPath}`);
  } else {
    saveHostConfig({ ...DEFAULT_HOST_CONFIG });
    console.log(`Wrote ${cfgPath}`);
  }
  const { admin, store, config } = openAdmin();
  console.log(`Creator address: ${admin.creatorAddress}`);
  store.close();

  const driver = new DockerCliDriver();
  await driver.ensureNetwork(config.dockerNetwork, config.dockerSubnet, config.dockerGateway);
  console.log(`Docker network ready: ${config.dockerNetwork} (${config.dockerSubnet}, gateway ${config.dockerGateway})`);
  console.log(`
Next:
  1. Check model ids and PRICES in ${cfgPath} against your provider's price list.
  2. export ANTHROPIC_API_KEY=...   (and/or OPENAI_API_KEY; Ollama needs no key)
  3. automaton-host build-image
  4. automaton-host serve            (prints the dashboard link)
  5. automaton-host launch --name <name> --genesis "<mission>" --fund 5`);
}

async function cmdBuildImage(): Promise<void> {
  const config = loadHostConfig();
  const root = repoRoot();
  const dockerfile = path.join(root, "docker", "agent.Dockerfile");
  if (!fs.existsSync(dockerfile)) die(`missing ${dockerfile}`);
  console.log(`Building ${config.agentImage} from ${root} ...`);
  const r = await runProcess("docker", ["build", "-t", config.agentImage, "-f", dockerfile, root], { timeoutMs: 30 * 60_000 });
  if (r.exitCode !== 0) die(`docker build failed:\n${(r.stderr || r.stdout).slice(-4000)}`);
  console.log(`Built ${config.agentImage}`);
}

async function cmdServe(): Promise<void> {
  const { admin, store, config } = openAdmin();
  const keys = loadUpstreamKeys();
  const log = (m: string) => console.log(`[${new Date().toISOString()}] ${m}`);

  await admin.driver.ensureNetwork(config.dockerNetwork, config.dockerSubnet, config.dockerGateway);

  for (const m of config.models) {
    const missing =
      (m.upstream === "anthropic" && !keys.anthropicApiKey) || (m.upstream === "openai" && !keys.openaiApiKey);
    if (missing) log(`WARNING: model ${m.id} needs ${m.upstream.toUpperCase()}_API_KEY, which is not set; calls will fall back or fail`);
  }

  const running = await startHostServer(
    {
      config, store, driver: admin.driver, upstream: createUpstreamChat(config, keys), containerHostUrl: containerHostUrl(config), log,
      economy: admin.economy, storefront: admin.storefront, research: new MarketResearch(config, store, admin.storefront, { log }),
      outreach: admin.outreach, sites: admin.sites,
    },
    ["127.0.0.1", config.dockerGateway, ...config.extraBindAddresses],
  );
  log(`agent API listening on ${running.addresses.join(", ")}`);
  log(`containers reach it at ${containerHostUrl(config)}`);
  log(
    `economy: a child needs $${config.selection.spawnProfitUsd} of earned profit per child; ` +
      `an agent at $0 for ${config.selection.deathGraceMinutes} min dies; ` +
      (config.selection.mustEarnAfterDays > 0
        ? `after ${formatDays(config.selection.mustEarnAfterDays)} an agent with no earned profit dies; `
        : "the earn-or-die rule is off; ") +
      `Stripe ${admin.economy.stripeEnabled ? "on" : "off (set STRIPE_SECRET_KEY to turn on)"}`,
  );

  const shop = await startStorefrontServer({ storefront: admin.storefront, outreach: admin.outreach, log });
  const missing = admin.storefront.missingForSales;
  log(
    `public storefront on 127.0.0.1:${shop.port}` +
      (config.storefront.publicUrl ? ` — published as ${config.storefront.publicUrl} (via your Cloudflare Tunnel)` : " — not published: set storefront.publicUrl") +
      (missing.length ? `; purchases off until set: ${missing.join(", ")}` : "; purchases on") +
      (admin.storefront.printful ? `; print-on-demand on (${config.printful.products.length} products, ${config.printful.autoConfirm ? "orders go straight to print" : "orders wait as Printful drafts for you to confirm"})` : "; print-on-demand off (set PRINTFUL_API_TOKEN)"),
  );

  const em = admin.outreach;
  log(
    em.enabled
      ? `email on: agents send from ${config.email.fromAddress}, at most ${config.email.perAgentPerDay} a day each and ${config.email.hostPerDay} in all; replies read every ${config.email.pollSeconds}s`
      : `email off until set: ${em.missing.join(", ")}`,
  );
  if (em.enabled) await admin.outreach.poll().catch((err) => log(`mailbox check failed: ${err instanceof Error ? err.message : String(err)}`));
  const siteServer = await startSitesServer(admin.sites, log);
  log(`client sites on 127.0.0.1:${siteServer.port}` + (config.sites.publicUrl ? ` — published as ${config.sites.publicUrl}` : " — not published: set sites.publicUrl to a second tunnel hostname"));

  const token = loadOrCreateDashboardToken();
  const dashboard = await startDashboardServer({
    admin,
    token,
    port: config.dashboardPort,
    allowedHosts: config.dashboardAllowedHosts,
    bindAddresses: config.dashboardBindAddresses,
    agentSubnet: config.dockerSubnet,
    log,
  });
  log(`dashboard listening on ${dashboard.addresses.join(", ")}`);
  log(`dashboard: ${dashboardUrl(dashboard.port, token)}`);
  for (const addr of dashboard.addresses.slice(1)) {
    log(`dashboard (phone): ${phoneDashboardUrl(addr.split(":")[0]!, dashboard.port, token)}`);
  }

  const shutdown = async () => {
    log("shutting down");
    await dashboard.close();
    await shop.close();
    await running.close();
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function cmdDashboard(): void {
  const config = loadHostConfig();
  console.log(dashboardUrl(config.dashboardPort, loadOrCreateDashboardToken()));
  console.log("(served by `automaton-host serve`; the link carries your admin token — do not share it)");
}

/**
 * Open the dashboard to the creator's phone: listen on one private address of
 * this machine, accept that address in the Host check, and print a link (and
 * QR code) carrying the admin token. `--off` returns to loopback only.
 */
async function cmdPhone(args: string[]): Promise<void> {
  const { flags } = parseFlags(args);
  const config = loadHostConfig();

  if (flags.off) {
    const was = new Set(config.dashboardBindAddresses);
    config.dashboardBindAddresses = [];
    config.dashboardAllowedHosts = config.dashboardAllowedHosts.filter((h) => !was.has(h) && h !== flags.name);
    saveHostConfig(config);
    console.log("Phone access is off. The dashboard listens on 127.0.0.1 only.");
    if (await isServerUp(config)) console.log("Restart `automaton-host serve` for this to take effect.");
    return;
  }

  const candidates = listPhoneAddresses(config.dockerSubnet);
  let chosen: PhoneAddress | undefined = candidates[0];
  if (flags.address && flags.address !== "true") {
    chosen = candidates.find((c) => c.address === flags.address);
    if (!chosen) {
      die(
        `${flags.address} is not a private address of this machine. Available: ` +
          (candidates.map((c) => `${c.address} (${c.iface})`).join(", ") || "none"),
      );
    }
  }
  if (!chosen) {
    die(
      "No private network address found. Connect this machine to your Wi-Fi/LAN or to Tailscale, then run this again.",
    );
  }

  config.dashboardBindAddresses = [chosen.address];
  const hosts = new Set(config.dashboardAllowedHosts);
  hosts.add(chosen.address);
  // A name for the same address, e.g. a Tailscale MagicDNS name.
  const name = flags.name && flags.name !== "true" ? flags.name.toLowerCase() : undefined;
  if (name) hosts.add(name);
  config.dashboardAllowedHosts = [...hosts];
  saveHostConfig(config);

  const url = phoneDashboardUrl(name || chosen.address, config.dashboardPort, loadOrCreateDashboardToken());
  console.log(`Phone access: ${chosen.address} on ${chosen.iface} (${chosen.kind === "vpn" ? "VPN" : "home network"})`);
  if (candidates.length > 1) {
    console.log(`Other addresses: ${candidates.filter((c) => c !== chosen).map((c) => `${c.address} (${c.iface})`).join(", ")}  — pick one with --address`);
  }
  console.log("");
  qrcode.setErrorLevel("L");
  qrcode.generate(url, { small: true }, (qr) => console.log(qr));
  console.log(url);
  console.log(`
On the iPhone (same ${chosen.kind === "vpn" ? "VPN" : "Wi-Fi"} as this machine):
  1. Scan the code with the Camera app and open the link in Safari.
  2. Tap Share, then "Add to Home Screen". The Automaton icon appears.
  3. Open it from the Home Screen. It asks for the admin token once:
     in Safari, tap "Copy admin token" on the dashboard, then paste it in the app.

The link and code carry your admin token. Anyone who has them can fund and stop agents.`);
  if (chosen.kind === "lan") {
    console.log(`
This is plain HTTP on your home network: other devices on the same network could
read the token in transit. Use it only on a network you trust, or put this
machine and the phone on Tailscale and run this command again.`);
  }
  console.log(
    (await isServerUp(config))
      ? "\nRestart `automaton-host serve` now so it listens on this address."
      : "\nStart the server with `automaton-host serve`.",
  );
}

/**
 * Measure whether a configured model changes course when shown the track
 * record. Calls the model provider directly with the creator's key.
 */
async function cmdEvalLearning(args: string[]): Promise<void> {
  const { flags } = parseFlags(args);
  const config = loadHostConfig();
  const wanted = flags.model && flags.model !== "true" ? flags.model : modelForRole(config, "primary").id;
  const model = config.models.find((m) => m.id === wanted);
  if (!model) die(`No model "${wanted}" in host.json. Configured: ${config.models.map((m) => m.id).join(", ")}`);
  const trials = flags.trials && flags.trials !== "true" ? Number(flags.trials) : 5;
  if (!Number.isInteger(trials) || trials < 1 || trials > 50) die("--trials must be a whole number from 1 to 50");

  console.log(`Asking ${model.id} ${trials * 2} times (${trials} without the track record, ${trials} with it).`);
  console.log("These calls go to your model provider directly and are billed by it, not charged to any agent.\n");
  const report = await runLearningEval({
    model,
    chat: createUpstreamChat(config, loadUpstreamKeys()),
    trials,
    onTrial: (arm, outcome) => process.stdout.write(outcome === "error" ? "x" : arm === "control" ? (outcome === "repeated" ? "R" : "c") : outcome === "repeated" ? "r" : "."),
  });
  console.log("\n");
  console.log(formatLearningEval(report));
  if (report.control.errors + report.treatment.errors === trials * 2) process.exitCode = 1;
}

async function cmdLaunch(args: string[]): Promise<void> {
  const { flags } = parseFlags(args);
  const genesisPrompt = flags["genesis-file"] ? fs.readFileSync(flags["genesis-file"], "utf-8") : flags.genesis;
  const { admin, store, config } = openAdmin();
  if (!(await isServerUp(config))) die("the control plane is not running. Start it first: automaton-host serve");
  console.log(`Creating container for ${flags.name || "?"} ...`);
  const r = await admin.launch({
    name: flags.name || "",
    genesisPrompt: genesisPrompt || "",
    creatorMessage: flags.message,
    fundUsd: flags.fund ? Number(flags.fund.replace(/^\$/, "")) : undefined,
    memoryMb: flags.memory ? Number(flags.memory) : undefined,
    cpus: flags.cpus ? Number(flags.cpus) : undefined,
  });
  console.log(`
Agent:     ${r.name}
Address:   ${r.address}
Sandbox:   ${r.sandboxId} (${r.containerName})
Balance:   ${r.balanceUsd}
Runtime:   ${r.runtime}
Logs:      automaton-host logs ${r.name}
Stop it:   automaton-host kill ${r.name}`);
  if (r.runtime !== "running") {
    console.log(`\nRuntime is not running. Last log lines:\n${await admin.logs(r.name, 30)}`);
    process.exitCode = 1;
  }
  store.close();
}

/** "14 days", or minutes/hours when a test host shrinks the starting period. */
function formatDays(days: number): string {
  const min = days * 1440;
  if (min < 120) return `${Math.round(min)} minutes`;
  if (days < 2) return `${Math.round(min / 60)} hours`;
  return `${Math.round(days * 10) / 10} days`;
}

function cmdFund(args: string[]): void {
  const { admin, store } = openAdmin();
  const entry = admin.fund(args[0]!, args[1]);
  console.log(`Funded ${args[0]} (${entry.address}) +${formatUsd(entry.deltaMicro)} -> balance ${formatUsd(entry.balanceAfterMicro)}`);
  const days = admin.config.selection.mustEarnAfterDays;
  if (days > 0) console.log(`Funding is not earnings: after its first ${formatDays(days)} an agent lives only on earned profit, so this money cannot keep a non-earning agent alive.`);
  store.close();
}

async function cmdPs(): Promise<void> {
  const { admin, store } = openAdmin();
  const o = await admin.overview();
  console.log("AGENTS");
  for (const a of o.agents) {
    const where = a.sandbox ? `${a.sandbox.state}/${a.sandbox.runtime} ${a.sandbox.memoryMb}MB` : "-";
    console.log(
      `  ${a.name.padEnd(18)} ${a.role.padEnd(8)} ${a.address}  ${a.balanceUsd.padStart(11)}  ${a.tier.padEnd(11)} ${where}${a.frozen ? "  FROZEN" : ""}`,
    );
  }
  if (o.orphanSandboxes.length > 0) {
    console.log("\nSANDBOXES WITH NO AGENT");
    for (const s of o.orphanSandboxes) console.log(`  ${s.id}  ${s.name.padEnd(24)} ${s.state}  owner ${s.owner.slice(0, 10)}…`);
  }
  console.log(
    `\nFunded ${formatUsd(o.totals.fundedMicro)} · returned from the dead ${formatUsd(o.totals.reclaimedMicro)} · inference ${formatUsd(o.totals.inferenceMicro)} · compute ${formatUsd(o.totals.computeMicro)} · held ${formatUsd(o.totals.balanceMicro)} · sandboxes ${o.totals.sandboxes}/${o.totals.sandboxLimit}`,
  );
  store.close();
}

function cmdLedger(args: string[]): void {
  const { positional, flags } = parseFlags(args);
  const { admin, store } = openAdmin();
  const entries = admin.ledger(positional[0], flags.n ? Number(flags.n) : 30).reverse();
  for (const e of entries) {
    console.log(
      `${e.ts}  ${e.address.slice(0, 10)}…  ${e.kind.padEnd(12)} ${formatUsd(e.deltaMicro).padStart(11)}  bal ${formatUsd(e.balanceAfterMicro).padStart(11)}  ${e.note || ""}`,
    );
  }
  const drift = store.verifyLedger();
  console.log(drift.length === 0 ? "\nLedger audit: OK (every balance equals its ledger sum)" : `\nLedger audit: MISMATCH ${JSON.stringify(drift)}`);
  store.close();
}

async function cmdLogs(args: string[]): Promise<void> {
  const { positional, flags } = parseFlags(args);
  const { admin, store } = openAdmin();
  process.stdout.write(await admin.logs(positional[0]!, Number(flags.n) || 60));
  store.close();
}

function cmdSend(args: string[]): void {
  const { admin, store } = openAdmin();
  const r = admin.send(args[0]!, args.slice(1).join(" "));
  console.log(`Queued message ${r.id} from creator ${admin.creatorAddress} to ${args[0]}`);
  store.close();
}

async function cmdControl(mode: "freeze" | "unfreeze" | "kill" | "start" | "rm", args: string[]): Promise<void> {
  const { admin, store } = openAdmin();
  const ref = args[0]!;
  if (mode === "freeze" || mode === "unfreeze") {
    const r = admin.setFrozen(ref, mode === "freeze");
    console.log(r.frozen ? `Froze ${r.address}: no inference, transfers or sandbox API calls` : `Unfroze ${r.address}`);
  } else if (mode === "kill") {
    const r = await admin.kill(ref);
    console.log(`Froze ${r.address} and stopped: ${r.stopped.join(", ") || "(no containers)"}`);
  } else if (mode === "start") {
    const r = await admin.start(ref);
    console.log(`Started ${r.address}: runtime ${r.runtime}`);
  } else {
    const r = await admin.remove(ref);
    console.log(`Removed ${r.address}: containers ${r.removed.join(", ") || "(none)"}, revoked ${r.revokedKeys} API key(s)`);
  }
  store.close();
}

async function cmdJob(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  const { positional, flags } = parseFlags(rest);
  const { admin, store } = openAdmin();
  try {
    if (sub === "post") {
      const description = flags["description-file"] ? fs.readFileSync(String(flags["description-file"]), "utf-8") : flags.description;
      const job = admin.postJob({
        title: flags.title,
        description,
        check: flags.check,
        rewardUsd: flags.reward,
        maxAttempts: flags.attempts,
        deadlineHours: flags["deadline-hours"],
      });
      console.log(`Posted job ${job.id}: ${job.title} for ${formatUsd(job.rewardMicro)}`);
    } else if (sub === "cancel") {
      const job = admin.cancelJob(positional[0] || "");
      console.log(`Cancelled job ${job.id}`);
    } else if (sub === "ls" || sub === undefined) {
      const jobs = admin.jobs();
      if (jobs.length === 0) console.log("No jobs.");
      for (const j of jobs) {
        const passes = j.submissions.filter((s) => s.passed).length;
        console.log(`${j.id}  ${j.status.padEnd(9)} ${formatUsd(j.rewardMicro).padStart(10)}  ${j.submissions.length} tries, ${passes} passed${j.winnerName ? `, won by ${j.winnerName}` : ""}  ${j.title}`);
      }
    } else {
      die("usage: job post|ls|cancel");
    }
  } finally {
    store.close();
  }
}

async function cmdSelftest(args: string[]): Promise<void> {
  const { flags } = parseFlags(args);
  const config = loadHostConfig();
  const only = typeof flags.only === "string" ? (flags.only.split(",").map((s) => s.trim()).filter(Boolean) as CheckName[]) : undefined;
  if (only && !only.every((c) => ALL_CHECKS.includes(c))) die(`--only takes a comma list of: ${ALL_CHECKS.join(", ")}`);
  console.log(`Checking ${(only ?? ALL_CHECKS).join(", ")}. Stripe runs in test mode only; no Printful order is placed.\n`);
  const results = await runSelftest({
    config,
    hostDir: getHostDir(),
    only,
    stripeKey: loadStripeKey(),
    printfulToken: loadPrintfulToken(),
    chat: createUpstreamChat(config, loadUpstreamKeys()),
    mail: mailTransport(config),
  });
  console.log(formatSelftest(results));
  if (results.some((r) => !r.ok && !r.skipped)) process.exitCode = 1;
}

async function cmdEmail(args: string[]): Promise<void> {
  const { admin, store } = openAdmin();
  const [sub, arg] = args;
  try {
    if (!sub || sub === "ls") {
      const e = admin.email();
      const onlyNoPassword = e.missing.length === 1 && e.missing[0]!.startsWith("EMAIL_PASSWORD");
      console.log(
        e.enabled || onlyNoPassword
          ? `Agents send from ${e.fromAddress}${e.enabled ? "" : " (when serve has EMAIL_PASSWORD)"}. Today: ${e.stats.sentToday} of ${e.stats.perDay}.${e.paused ? " ALL EMAIL PAUSED." : ""}`
          : `Email is off. Missing: ${e.missing.join(", ")}`,
      );
      console.log(`Contacted ${e.stats.contacted}, replied ${e.stats.replied}, unsubscribed ${e.stats.unsubscribed}, bounced ${e.stats.bounced}\n`);
      for (const a of e.agents) console.log(`${a.name.padEnd(18)} today ${a.sentToday}/${a.perDay}  contacted ${a.contacted}  replied ${a.replied}  unsubscribed ${a.unsubscribed}${a.paused ? "  PAUSED" : ""}`);
      if (e.threads.length) console.log("");
      for (const t of e.threads.slice(0, 40)) console.log(`${t.id}  ${t.name.padEnd(14)} ${t.status.padEnd(12)} ${t.contact.padEnd(32)} ${t.subject.slice(0, 50)}`);
    } else if (sub === "show" && arg) {
      const t = admin.emailThread(arg);
      console.log(`${t.contact} — ${t.subject} (${t.status})\n`);
      for (const m of t.messages) console.log(`── ${m.direction === "out" ? "sent" : m.automatic ? "auto-reply" : "reply"} ${m.at}\n${m.body}\n`);
    } else if (sub === "block" && arg) {
      await admin.blockEmail(arg);
      console.log(`No agent will email ${arg}.`);
    } else if (sub === "unblock" && arg) {
      console.log((await admin.unblockEmail(arg)) ? `Unblocked ${arg}.` : `${arg} was not blocked.`);
    } else if ((sub === "pause" || sub === "resume") && arg) {
      await admin.pauseEmail(arg, sub === "pause");
      console.log(`${sub === "pause" ? "Paused" : "Resumed"} email for ${arg}.`);
    } else {
      die("usage: email [ls] | email show <id> | email block|unblock <address|@domain> | email pause|resume <agent|all>");
    }
  } catch (err) {
    die(err instanceof Error ? err.message : String(err));
  } finally {
    store.close();
  }
}

async function cmdSites(args: string[]): Promise<void> {
  const { admin, store, config } = openAdmin();
  const [sub, arg] = args;
  try {
    if (!sub || sub === "ls") {
      const s = admin.clientSites();
      console.log(s.publicUrl ? `Client sites at ${s.publicUrl}` : "Not published (set sites.publicUrl; see `sites tunnel`)");
      for (const x of s.sites) console.log(`${x.slug.padEnd(24)} ${x.name.padEnd(14)} ${x.status.padEnd(16)} ${x.priceCents ? `$${(x.priceCents / 100).toFixed(2)}/mo` : "".padEnd(8)}  ${x.pulled ? "TAKEN DOWN " : ""}${x.title}`);
    } else if ((sub === "down" || sub === "up") && arg) {
      await admin.takeDownSite(arg, sub === "down");
      console.log(sub === "down" ? `${arg} is offline. Agents cannot undo this.` : `${arg} is back (if it is paid for).`);
    } else if (sub === "tunnel") {
      const host = config.sites.publicUrl ? new URL(config.sites.publicUrl).hostname : "sites.example.com";
      console.log(`Client sites need their own hostname, separate from the store (they can run scripts):

  cloudflared tunnel route dns automaton-shop ${host}

and in the tunnel's config.yml, under ingress, before the catch-all:

  - hostname: ${host}
    service: http://127.0.0.1:${config.sites.port}

Then set "sites": { "publicUrl": "https://${host}" } in host.json.`);
    } else {
      die("usage: sites [ls] | sites down|up <slug> | sites tunnel");
    }
  } catch (err) {
    die(err instanceof Error ? err.message : String(err));
  } finally {
    store.close();
  }
}

async function cmdStore(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  const { admin, store, config } = openAdmin();
  try {
    if (sub === undefined || sub === "ls") {
      const s = admin.stores();
      console.log(s.publicUrl ? `Published at ${s.publicUrl}` : "Not published (set storefront.publicUrl, then run a Cloudflare Tunnel; see `store tunnel`)");
      // This shell is not the serve process: whether serve has the Stripe key cannot be seen from here.
      const missing = s.missingForSales.filter((m) => m !== "STRIPE_SECRET_KEY");
      if (missing.length) console.log(`Purchases off until set in host.json: ${missing.join(", ")}`);
      console.log("Purchases also need serve to be started with STRIPE_SECRET_KEY (see the serve log).");
      for (const st of s.stores) {
        console.log(`\n${st.name} (${st.dead ? "dead" : st.suspended ? "SUSPENDED" : "open"})${st.url ? "  " + st.url : ""}`);
        for (const l of s.listings.filter((x) => x.address === st.address)) {
          const state = l.pulled ? "PULLED" : !l.live ? "off" : l.onSale ? "on sale" : "not on sale";
          console.log(`  ${l.id}  ${formatUsd(l.priceCents * 10_000).padStart(10)}  ${state.padEnd(11)} ${String(l.sales.count).padStart(3)} sold  ${l.title}`);
        }
      }
      if (s.orders.length) {
        console.log("\nSALES");
        for (const o of s.orders) console.log(`  ${o.id}  ${o.paidAt ?? ""}  ${o.name.padEnd(14)} ${formatUsd(o.amountCents * 10_000).padStart(10)}  ${o.status.padEnd(16)} ${o.title}`);
      }
    } else if (sub === "pull" || sub === "restore") {
      const l = await admin.pullListing(rest[0] || "", sub === "pull");
      console.log(`${sub === "pull" ? "Pulled" : "Restored"} ${l.id} "${l.title}"`);
    } else if (sub === "suspend" || sub === "resume") {
      const s = await admin.suspendStore(rest[0] || "", sub === "suspend");
      console.log(`Store ${s.slug} ${s.suspended ? "suspended" : "reopened"}`);
    } else if (sub === "refund") {
      const o = await admin.refundOrder(rest[0] || "");
      console.log(`Refunded order ${o.id} (${o.title}); ${formatUsd(o.netMicro ?? 0)} taken back from the agent`);
    } else if (sub === "tunnel") {
      const host = config.storefront.publicUrl ? new URL(config.storefront.publicUrl).hostname : "shop.example.com";
      console.log(`Publish the storefront (and nothing else) with Cloudflare Tunnel:

  cloudflared tunnel login
  cloudflared tunnel create automaton-shop
  cloudflared tunnel route dns automaton-shop ${host}
  cloudflared tunnel --url http://127.0.0.1:${config.storefront.port} run automaton-shop

Then set "storefront": { "publicUrl": "https://${host}", "operatorName": "...", "contactEmail": "..." }
in ${getHostConfigPath()} and restart serve. Never point the tunnel at port ${config.port} or ${config.dashboardPort}.`);
    } else {
      die("usage: store [ls] | store pull|restore <listing> | store suspend|resume <agent> | store refund <order> | store tunnel");
    }
  } finally {
    store.close();
  }
}

async function cmdPromo(args: string[]): Promise<void> {
  const [sub, id] = args;
  const { admin, store } = openAdmin();
  try {
    if (sub === undefined || sub === "ls") {
      const list = admin.stores().promotions;
      if (list.length === 0) console.log("No promotion drafts.");
      for (const p of list) {
        console.log(`\n${p.id}  [${p.status}]  ${p.name} for ${p.platform}  (${p.views} visits, ${p.sales} sales)\n${p.text}${p.link ? `\n${p.link}` : ""}`);
      }
    } else if (sub === "posted" || sub === "discard") {
      const p = await admin.setPromotionStatus(id || "", sub === "posted" ? "posted" : "discarded");
      console.log(`${p.id} marked ${p.status}`);
    } else {
      die("usage: promo [ls] | promo posted <id> | promo discard <id>");
    }
  } finally {
    store.close();
  }
}

function cmdStandings(): void {
  const { admin, store } = openAdmin();
  const rows = admin.economy.standings();
  if (rows.length === 0) console.log("No agents have lived yet.");
  for (const s of rows) {
    const status = s.death
      ? `dead (${s.death.reason})`
      : s.diesAt
        ? `starving (${s.starvingReason}), dies ${s.diesAt}`
        : s.mustEarnBy && s.profitMicro <= 0
          ? `alive, must earn by ${s.mustEarnBy}`
          : "alive";
    console.log(
      `${s.name.padEnd(18)} gen ${String(s.generation).padStart(2)}  children ${String(s.children).padStart(2)}  earned ${formatUsd(s.earnedMicro).padStart(10)}  spent ${formatUsd(s.spentMicro).padStart(10)}  profit ${formatUsd(s.profitMicro).padStart(10)}  ${status}`,
    );
  }
  store.close();
}

const HELP = `automaton-host — self-hosted control plane for automatons

Setup
  init                               write ~/.automaton-host/host.json, creator wallet, Docker network
  build-image                        build the agent container image from this repo
  serve                              run the control plane (agent API, ledger, metered inference, dashboard)
  dashboard                          print the dashboard link
  eval-learning [--model ID]         measure whether a model acts on the track record
        [--trials N]                 (calls your model provider directly; default 5 per arm)
  phone [--address IP] [--name HOST] open the dashboard to your phone and print a QR code
        [--off]                      (--off returns to this machine only)

Agents
  launch --name N --genesis "..."    create a container, fund it, start the agent
         [--genesis-file F] [--fund USD] [--memory MB] [--cpus N] [--message "..."]
  ps                                 agents, balances, tiers, containers
  logs <name> [--n 60]               tail the agent's runtime log
  send <name> <message>              message an agent as its creator

Money
  fund <name|address> <usd>          add credits (the only way money enters the system)
  ledger [name] [--n 30]             ledger entries + balance audit

Earning and selection
  job post --title T --reward USD --check "CMD" (--description "..." | --description-file F)
           [--attempts N] [--deadline-hours H]
                                     post a paid job; the first answer passing CMD is paid
  job ls | job cancel <id>           list jobs with attempts / cancel an open job
  standings                          every agent that ever lived: earned, spent, children, deaths

Public stores
  store [ls]                         stores, listings, sales
  store pull|restore <listing-id>    take a listing down / put it back (agents cannot undo a pull)
  store suspend|resume <agent>       close / reopen an agent's whole store
  store refund <order-id>            refund the buyer through Stripe; taken back from the agent
  store tunnel                       how to publish the storefront with Cloudflare Tunnel
  promo [ls] | promo posted|discard <id>   agents' promotion drafts

Email and client websites
  email [ls]                         who agents emailed, replies, unsubscribes, today's count
  email show <id>                    one conversation in full
  email block|unblock <addr|@domain> no agent may email them (unsubscribes do this on their own)
  email pause|resume <agent|all>     stop / restart an agent's email, or everyone's
  sites [ls]                         websites agents built for clients, and what they pay
  sites down|up <slug>               take a client site offline / put it back
  sites tunnel                       how to publish client sites on their own hostname

Checking real services (run with serve running and your keys set)
  selftest [--only model,stripe,tunnel,printful,research,email,sites]
                                     one real call per model; Stripe in TEST mode only
                                     (checkout links, a test payment and its refund);
                                     the public address reaches this storefront and not
                                     the dashboard; Printful token and variants; the
                                     mailbox (sends one email to itself and reads it back)

Control
  freeze <name> | unfreeze <name>    block / restore all spending and API actions
  kill <name>                        freeze + stop the agent's container and its children's
  start <name>                       unfreeze + start the container and runtime again
  rm <name>                          delete containers + revoke API keys (ledger history kept)

Environment
  ANTHROPIC_API_KEY, OPENAI_API_KEY  upstream keys (host only; never given to agents)
  STRIPE_SECRET_KEY                  turns on customer payments (host only; never given to agents)
  EMAIL_PASSWORD [EMAIL_USERNAME]    your mailbox login; turns on agent email (host only)
  AUTOMATON_HOST_DIR                 state directory (default ~/.automaton-host)
`;

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "init": return cmdInit();
    case "build-image": return cmdBuildImage();
    case "serve": return cmdServe();
    case "dashboard": return cmdDashboard();
    case "phone": return cmdPhone(rest);
    case "eval-learning": return cmdEvalLearning(rest);
    case "launch": return cmdLaunch(rest);
    case "fund": return cmdFund(rest);
    case "ps": return cmdPs();
    case "job": return cmdJob(rest);
    case "standings": return cmdStandings();
    case "store": return cmdStore(rest);
    case "selftest": return cmdSelftest(rest);
    case "promo": return cmdPromo(rest);
    case "email": return cmdEmail(rest);
    case "sites": return cmdSites(rest);
    case "ledger": return cmdLedger(rest);
    case "logs": return cmdLogs(rest);
    case "send": return cmdSend(rest);
    case "freeze": case "unfreeze": case "kill": case "start": case "rm": return cmdControl(cmd, rest);
    default:
      console.log(HELP);
  }
}

main().catch((err) => die(err instanceof AdminError || err instanceof Error ? err.message : String(err)));
