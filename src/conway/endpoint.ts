/**
 * Control-plane endpoint resolution.
 *
 * The runtime speaks one API (sandboxes, credits, inference, relay). That
 * API can be served by the self-hosted control plane (`automaton-host`,
 * src/host/) or by Conway Cloud. This module decides which one is in use
 * and which origins may be reached over plain HTTP.
 */

/** Where `automaton-host serve` listens when the runtime runs on the same machine. */
export const DEFAULT_SELF_HOSTED_URL = "http://127.0.0.1:4820";

/**
 * Resolve the control-plane URL.
 * AUTOMATON_HOST_URL is injected into every container the host creates;
 * CONWAY_API_URL is honoured for backward compatibility.
 */
export function resolveApiUrl(explicit?: string): string {
  return (
    explicit ||
    process.env.AUTOMATON_HOST_URL ||
    process.env.CONWAY_API_URL ||
    DEFAULT_SELF_HOSTED_URL
  ).replace(/\/+$/, "");
}

/** True unless the URL points at Conway's hosted service. */
export function isSelfHosted(apiUrl: string | undefined): boolean {
  if (!apiUrl) return true;
  try {
    const host = new URL(apiUrl).hostname.toLowerCase();
    return !(host === "conway.tech" || host.endsWith(".conway.tech"));
  } catch {
    return true;
  }
}

const trustedInsecureOrigins = new Set<string>();

/**
 * Allow plain HTTP to one specific origin.
 *
 * The HTTP client refuses non-HTTPS URLs so credentials are never sent in
 * clear text over a network. The self-hosted control plane is the deliberate
 * exception: it is reached over loopback or a private Docker bridge on the
 * same machine, where there is no certificate to present. Trust is granted
 * per exact origin (scheme + host + port) taken from configuration — never
 * from a URL an agent or a tool result supplied.
 */
export function trustInsecureOrigin(url: string | undefined): void {
  if (!url) return;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "http:") trustedInsecureOrigins.add(parsed.origin);
  } catch {
    // Not a URL: nothing to trust.
  }
}

export function isTrustedInsecureOrigin(url: URL): boolean {
  return url.protocol === "http:" && trustedInsecureOrigins.has(url.origin);
}

/** Test hook. */
export function clearTrustedInsecureOrigins(): void {
  trustedInsecureOrigins.clear();
}

// ─── On-chain payments switch ──────────────────────────────────

let chainPayments = true;

/**
 * Turn on-chain payments (USDC balance lookups, x402, credit top-ups) on or
 * off for this process.
 *
 * On the self-hosted control plane credits come only from the creator's
 * ledger, so there is nothing to buy with USDC. Every auto top-up path in
 * the runtime is gated on the wallet's USDC balance, so reporting that
 * balance as zero at its single source disables all of them — without a
 * public RPC call on every turn and heartbeat tick.
 */
export function setChainPaymentsEnabled(enabled: boolean): void {
  chainPayments = enabled;
}

export function chainPaymentsEnabled(): boolean {
  return chainPayments;
}

/** Tools that only work against Conway Cloud or on-chain funds. */
export const CONWAY_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "check_usdc_balance",
  "topup_credits",
  "x402_fetch",
  "search_domains",
  "register_domain",
  "manage_dns",
]);
