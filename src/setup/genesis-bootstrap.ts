/**
 * Non-interactive first-run setup.
 *
 * A spawned child (and an agent started by `automaton-host launch`) has no
 * terminal: the parent writes ~/.automaton/genesis.json and then starts the
 * runtime detached. The interactive wizard cannot run there — it would block
 * forever on stdin. This module performs the same setup from genesis.json.
 *
 * Returns null when there is no genesis file, so callers fall through to the
 * wizard for a human at a terminal.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type { AutomatonConfig } from "../types.js";
import { getWallet, getAutomatonDir } from "../identity/wallet.js";
import { provision, loadApiKeyFromConfig } from "../identity/provision.js";
import { createConfig, saveConfig } from "../config.js";
import { writeDefaultHeartbeatConfig } from "../heartbeat/config.js";
import { detectEnvironment } from "./environment.js";
import { generateSoulMd, installDefaultSkills } from "./defaults.js";
import { resolveApiUrl, isSelfHosted, trustInsecureOrigin } from "../conway/endpoint.js";
import { isValidAddress } from "../identity/chain.js";
import type { ChainType } from "../identity/chain.js";
import { createLogger } from "../observability/logger.js";

const logger = createLogger("setup.genesis");

interface GenesisFile {
  name?: unknown;
  genesisPrompt?: unknown;
  creatorMessage?: unknown;
  creatorAddress?: unknown;
  parentAddress?: unknown;
  chainType?: unknown;
}

export function getGenesisPath(): string {
  return path.join(getAutomatonDir(), "genesis.json");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Get an API key from the control plane, retrying while it is unreachable.
 *
 * A child is started seconds after its container; the retry covers the
 * window where the network path is not up yet. It stops after a bounded
 * number of attempts and throws — an agent with no key cannot do anything,
 * and a visible failure in its log beats a silent half-configured start.
 */
async function provisionWithRetry(apiUrl: string, attempts = 6): Promise<string> {
  const existing = loadApiKeyFromConfig();
  if (existing) return existing;

  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const result = await provision(apiUrl);
      return result.apiKey;
    } catch (err) {
      lastError = err;
      logger.warn(
        `Provisioning attempt ${i + 1}/${attempts} against ${apiUrl} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      if (i < attempts - 1) await sleep(Math.min(2000 * (i + 1), 10_000));
    }
  }
  throw new Error(
    `Could not provision an API key from ${apiUrl}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

/** Copy the constitution next to the agent's state, read-only. */
function installConstitution(automatonDir: string): boolean {
  const dst = path.join(automatonDir, "constitution.md");
  // A parent propagates the constitution (with a hash) before starting the
  // child; never overwrite that copy.
  if (fs.existsSync(dst)) return true;
  // Resolve relative to this module, not the working directory: a detached
  // start runs from the home directory, where the repo file is not found.
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  for (const src of [path.join(repoRoot, "constitution.md"), path.join(process.cwd(), "constitution.md")]) {
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dst);
      fs.chmodSync(dst, 0o444);
      return true;
    }
  }
  return false;
}

export async function bootstrapFromGenesis(): Promise<AutomatonConfig | null> {
  const genesisPath = getGenesisPath();
  if (!fs.existsSync(genesisPath)) return null;

  let genesis: GenesisFile;
  try {
    genesis = JSON.parse(fs.readFileSync(genesisPath, "utf-8"));
  } catch (err) {
    throw new Error(`genesis.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  const name = typeof genesis.name === "string" ? genesis.name.trim() : "";
  const genesisPrompt = typeof genesis.genesisPrompt === "string" ? genesis.genesisPrompt.trim() : "";
  const creatorAddress = typeof genesis.creatorAddress === "string" ? genesis.creatorAddress.trim() : "";
  const chainType: ChainType = genesis.chainType === "solana" ? "solana" : "evm";
  if (!name || !genesisPrompt) {
    throw new Error("genesis.json must contain a non-empty name and genesisPrompt");
  }
  if (!isValidAddress(creatorAddress, chainType)) {
    throw new Error(`genesis.json creatorAddress is not a valid ${chainType} address: "${creatorAddress}"`);
  }

  const apiUrl = resolveApiUrl();
  if (isSelfHosted(apiUrl)) trustInsecureOrigin(apiUrl);

  const { chainIdentity, chainType: walletChainType } = await getWallet(chainType);
  const walletAddress = chainIdentity.address;
  const apiKey = await provisionWithRetry(apiUrl);

  const config = createConfig({
    name,
    genesisPrompt,
    creatorMessage: typeof genesis.creatorMessage === "string" ? genesis.creatorMessage : undefined,
    creatorAddress,
    registeredWithConway: true,
    sandboxId: detectEnvironment().sandboxId,
    walletAddress,
    apiKey,
    parentAddress: typeof genesis.parentAddress === "string" ? genesis.parentAddress : undefined,
    chainType: walletChainType,
  });
  saveConfig(config);

  const automatonDir = getAutomatonDir();
  writeDefaultHeartbeatConfig();
  if (!installConstitution(automatonDir)) {
    logger.warn("constitution.md not found; the built-in fallback text will be used");
  }
  const soulPath = path.join(automatonDir, "SOUL.md");
  if (!fs.existsSync(soulPath)) {
    fs.writeFileSync(soulPath, generateSoulMd(name, walletAddress, creatorAddress, genesisPrompt), { mode: 0o600 });
  }
  installDefaultSkills(config.skillsDir || "~/.automaton/skills");

  logger.info(`Configured ${name} (${walletAddress}) from genesis.json against ${apiUrl}`);
  return config;
}
