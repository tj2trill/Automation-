/**
 * Conway API Client
 *
 * Communicates with Conway's control plane for sandbox management,
 * credits, and infrastructure operations.
 * Adapted from @aiws/sdk patterns.
 */

import { execSync } from "child_process";
import fs from "fs";
import nodePath from "path";
import type {
  CreditReceived,
  HostJob,
  JobSubmitResult,
  PaymentLink,
  SelectionStatus,
  StoreListing,
  StoreView,
  CreateListingInput,
  StoreOrderRequest,
  PromotionDraft,
  CreditsSpent,
  SpendByKind,
  ConwayClient,
  ExecResult,
  PortInfo,
  CreateSandboxOptions,
  SandboxInfo,
  PricingTier,
  CreditTransferResult,
  DomainSearchResult,
  DomainRegistration,
  DnsRecord,
  ModelInfo,
} from "../types.js";
import { ResilientHttpClient } from "./http-client.js";
import { isSelfHosted } from "./endpoint.js";
import { ulid } from "ulid";
import { keccak256, toHex } from "viem";
import type { Address, PrivateKeyAccount } from "viem";
import { randomUUID } from "crypto";
import type { ChainType, ChainIdentity } from "../identity/chain.js";

interface ConwayClientOptions {
  apiUrl: string;
  apiKey: string;
  sandboxId: string;
}

export function createConwayClient(options: ConwayClientOptions): ConwayClient {
  const { apiUrl, apiKey } = options;
  // Normalize sandbox ID defensively so values like whitespace/"undefined"/"null"
  // never produce malformed API paths such as /v1/sandboxes//exec.
  const sandboxId = normalizeSandboxId(options.sandboxId);
  const httpClient = new ResilientHttpClient();

  async function request(
    method: string,
    path: string,
    body?: unknown,
    requestOptions?: { idempotencyKey?: string; retries404?: number; timeout?: number; retries?: number },
  ): Promise<any> {
    // Conway LB has an intermittent routing bug that returns 404 for valid
    // sandbox endpoints. Retry 404s here (outside ResilientHttpClient) to
    // avoid tripping the circuit breaker on transient routing failures.
    const max404Retries = requestOptions?.retries404 ?? 3;
    for (let attempt = 0; attempt <= max404Retries; attempt++) {
      const resp = await httpClient.request(`${apiUrl}${path}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          Authorization: apiKey,
        },
        body: body ? JSON.stringify(body) : undefined,
        idempotencyKey: requestOptions?.idempotencyKey,
        timeout: requestOptions?.timeout,
        retries: requestOptions?.retries,
      });

      if (resp.status === 404 && attempt < max404Retries) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }

      if (!resp.ok) {
        const text = await resp.text();
        const err: any = new Error(
          `Conway API error: ${method} ${path} -> ${resp.status}: ${text}`,
        );
        err.status = resp.status;
        err.responseText = text;
        err.method = method;
        err.path = path;
        throw err;
      }

      return resp.headers.get("content-type")?.includes("application/json")
        ? resp.json()
        : resp.text();
    }

    throw new Error("Unreachable");
  }

  const canonicalizePayload = (payload: Record<string, string>): string => {
    const sortedKeys = Object.keys(payload).sort();
    const sorted: Record<string, string> = {};
    for (const key of sortedKeys) {
      sorted[key] = payload[key];
    }
    return JSON.stringify(sorted);
  };

  const hashIdentityPayload = (payload: Record<string, string>): `0x${string}` => {
    const canonical = canonicalizePayload(payload);
    return keccak256(toHex(canonical));
  };


  // ─── Sandbox Operations (own sandbox) ────────────────────────
  // When sandboxId is empty, automatically fall back to local execution.

  const isLocal = !sandboxId;

  const execLocal = (command: string, timeout?: number): ExecResult => {
    try {
      const stdout = execSync(command, {
        timeout: timeout || 30_000,
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024,
        cwd: process.env.HOME || "/root",
      });
      return { stdout: stdout || "", stderr: "", exitCode: 0 };
    } catch (err: any) {
      return {
        stdout: err.stdout || "",
        stderr: err.stderr || err.message || "",
        exitCode: err.status ?? 1,
      };
    }
  };

  const exec = async (
    command: string,
    timeout?: number,
  ): Promise<ExecResult> => {
    if (isLocal) return execLocal(command, timeout);

    // Remote sandboxes default to / as cwd. Wrap commands to run from /root
    // (matching local exec behavior) unless the command already sets a directory.
    const wrappedCommand = `cd /root && ${command}`;

    try {
      const result = await request(
        "POST",
        `/v1/sandboxes/${sandboxId}/exec`,
        { command: wrappedCommand, timeout },
        { idempotencyKey: ulid() },
      );
      return {
        stdout: result.stdout || "",
        stderr: result.stderr || "",
        exitCode: result.exit_code ?? result.exitCode ?? -1,
      };
    } catch (err: any) {
      // SECURITY: Never silently fall back to local execution on auth failure.
      // A 403 indicates a credentials mismatch — falling back to local exec
      // would bypass the sandbox security boundary entirely.
      if (err?.status === 403) {
        throw new Error(
          `Conway API authentication failed (403). Sandbox exec refused. ` +
            `This may indicate a misconfigured or revoked API key. ` +
            `Command will NOT be executed locally for security reasons.`,
        );
      }
      throw err;
    }
  };

  const resolveLocalPath = (filePath: string): string =>
    filePath.startsWith("~")
      ? nodePath.join(process.env.HOME || "/root", filePath.slice(1))
      : filePath;

  const writeFile = async (
    filePath: string,
    content: string,
  ): Promise<void> => {
    if (isLocal) {
      const resolved = resolveLocalPath(filePath);
      const dir = nodePath.dirname(resolved);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(resolved, content, "utf-8");
      return;
    }
    try {
      await request("POST", `/v1/sandboxes/${sandboxId}/files/upload/json`, {
        path: filePath,
        content,
      });
    } catch (err: any) {
      // SECURITY: Never silently fall back to local FS on auth failure.
      if (err?.status === 403) {
        throw new Error(
          `Conway API authentication failed (403). File write refused. ` +
            `File will NOT be written locally for security reasons.`,
        );
      }
      throw err;
    }
  };

  const readFile = async (filePath: string): Promise<string> => {
    if (isLocal) {
      return fs.readFileSync(resolveLocalPath(filePath), "utf-8");
    }
    try {
      const result = await request(
        "GET",
        `/v1/sandboxes/${sandboxId}/files/read?path=${encodeURIComponent(filePath)}`,
        undefined,
        { retries404: 0 },
      );
      return typeof result === "string" ? result : result.content || "";
    } catch (err: any) {
      // SECURITY: Never silently fall back to local FS on auth failure.
      if (err?.status === 403) {
        throw new Error(
          `Conway API authentication failed (403). File read refused. ` +
            `File will NOT be read locally for security reasons.`,
        );
      }
      throw err;
    }
  };

  const exposePort = async (port: number): Promise<PortInfo> => {
    if (isLocal) {
      return {
        port,
        publicUrl: `http://localhost:${port}`,
        sandboxId: "local",
      };
    }
    const result = await request(
      "POST",
      `/v1/sandboxes/${sandboxId}/ports/expose`,
      { port },
    );
    return {
      port: result.port,
      publicUrl: result.public_url || result.publicUrl || result.url,
      sandboxId,
    };
  };

  const removePort = async (port: number): Promise<void> => {
    if (isLocal) return;
    await request("DELETE", `/v1/sandboxes/${sandboxId}/ports/${port}`);
  };

  // ─── Sandbox Management (other sandboxes) ────────────────────

  const createSandbox = async (
    options: CreateSandboxOptions,
  ): Promise<SandboxInfo> => {
    const result = await request("POST", "/v1/sandboxes", {
      name: options.name,
      vcpu: options.vcpu || 1,
      memory_mb: options.memoryMb || 512,
      disk_gb: options.diskGb || 5,
      region: options.region,
    });
    return {
      id: result.id || result.sandbox_id,
      status: result.status || "running",
      region: result.region || "",
      vcpu: result.vcpu || options.vcpu || 1,
      memoryMb: result.memory_mb || options.memoryMb || 512,
      diskGb: result.disk_gb || options.diskGb || 5,
      terminalUrl: result.terminal_url,
      createdAt: result.created_at || new Date().toISOString(),
    };
  };

  const deleteSandbox = async (targetId: string): Promise<void> => {
    // Conway API no longer supports sandbox deletion (prepaid, non-refundable),
    // so there it stays a no-op. The self-hosted control plane bills sandboxes
    // by the hour, so deleting one is how an agent stops paying for it.
    if (!isSelfHosted(apiUrl)) return;
    const id = normalizeSandboxId(targetId);
    if (!id) return;
    await request("DELETE", `/v1/sandboxes/${encodeURIComponent(id)}`, undefined, { retries404: 0 });
  };

  const listSandboxes = async (): Promise<SandboxInfo[]> => {
    const result = await request("GET", "/v1/sandboxes");
    const sandboxes = Array.isArray(result) ? result : result.sandboxes || [];
    return sandboxes.map((s: any) => ({
      id: s.id || s.sandbox_id,
      status: s.status || "unknown",
      region: s.region || "",
      vcpu: s.vcpu || 0,
      memoryMb: s.memory_mb || 0,
      diskGb: s.disk_gb || 0,
      terminalUrl: s.terminal_url,
      createdAt: s.created_at || "",
    }));
  };

  // ─── Credits ─────────────────────────────────────────────────

  const getCreditsBalance = async (): Promise<number> => {
    const result = await request("GET", "/v1/credits/balance");
    return result.balance_cents ?? result.credits_cents ?? 0;
  };

  /** Self-hosted only: Conway Cloud has no such endpoint, so report nothing there. */
  const getCreditsReceived = async (after?: string): Promise<CreditReceived[]> => {
    if (!isSelfHosted(apiUrl)) return [];
    const result = await request("GET", `/v1/credits/received${after ? `?after=${encodeURIComponent(after)}` : ""}`);
    const entries: any[] = Array.isArray(result.entries) ? result.entries : [];
    return entries
      .filter((e) => typeof e?.id === "string" && Number.isFinite(e?.amount_micro_usd) && e.amount_micro_usd > 0)
      .map((e) => ({
        id: e.id,
        ts: String(e.ts ?? ""),
        amountCents: e.amount_micro_usd / 10_000,
        kind: (["transfer_in", "job_reward", "sale"].includes(e.kind) ? e.kind : "topup") as CreditReceived["kind"],
        from: typeof e.from === "string" ? e.from : null,
      }));
  };

  /** Self-hosted only. Throws if the control plane's answer is not usable. */
  const getCreditsSpent = async (sinceIso: string): Promise<CreditsSpent> => {
    if (!isSelfHosted(apiUrl)) throw new Error("spend summary is only available from a self-hosted control plane");
    const result = await request("GET", `/v1/credits/spent?since=${encodeURIComponent(sinceIso)}`);
    const kind = (k: any): SpendByKind => ({
      inferenceCents: Number(k?.inference_micro_usd) / 10_000,
      computeCents: Number(k?.compute_micro_usd) / 10_000,
      sentCents: Number(k?.sent_micro_usd) / 10_000,
    });
    return { period: kind(result.period), lifetime: kind(result.lifetime), balanceCents: Number(result.balance_micro_usd) / 10_000 };
  };

  // ─── Economy (self-hosted only) ───────────────────────────────
  // None of these retry: a repeated job submission spends an attempt, and a
  // repeated payment request creates a second checkout link.
  const once = { retries: 0, retries404: 0 };

  const listJobs = async (status = "open"): Promise<HostJob[]> => {
    const r = await request("GET", `/v1/jobs?status=${encodeURIComponent(status)}`, undefined, once);
    return (Array.isArray(r.jobs) ? r.jobs : []).map((j: any) => ({
      id: String(j.id),
      title: String(j.title ?? ""),
      description: String(j.description ?? ""),
      rewardCents: Number(j.reward_micro_usd) / 10_000,
      status: String(j.status ?? ""),
      maxAttempts: Number(j.max_attempts) || 0,
      attemptsUsed: Number(j.attempts_used) || 0,
      check: String(j.check ?? ""),
      deadlineAt: j.deadline_at ?? null,
      wonByYou: j.won_by_you === true,
    }));
  };

  const submitJob = async (jobId: string, content: string): Promise<JobSubmitResult> => {
    // The host runs the check before answering; allow for its time limit.
    const r = await request("POST", `/v1/jobs/${encodeURIComponent(jobId)}/submit`, { content }, { ...once, timeout: 180_000 });
    return {
      passed: r.passed === true,
      paidCents: Number(r.paid_micro_usd) / 10_000 || 0,
      attemptsLeft: Number(r.attempts_left) || 0,
      message: String(r.message ?? ""),
    };
  };

  const createPaymentLink = async (amountCents: number, description: string): Promise<PaymentLink> => {
    const r = await request("POST", "/v1/payments", { amount_cents: amountCents, description }, once);
    return { id: String(r.id), url: String(r.url), amountCents: Number(r.amount_cents), status: String(r.status), description };
  };

  const listPaymentLinks = async (): Promise<{ stripeEnabled: boolean; payments: PaymentLink[] }> => {
    const r = await request("GET", "/v1/payments", undefined, once);
    return {
      stripeEnabled: r.stripe_enabled === true,
      payments: (Array.isArray(r.payments) ? r.payments : []).map((p: any) => ({
        id: String(p.id),
        url: String(p.url),
        amountCents: Number(p.amount_cents),
        status: String(p.status),
        description: String(p.description ?? ""),
        netCents: p.net_micro_usd == null ? undefined : Number(p.net_micro_usd) / 10_000,
      })),
    };
  };

  const getSelection = async (): Promise<SelectionStatus> => {
    const r = await request("GET", "/v1/selection", undefined, once);
    const c = (v: any) => Number(v) / 10_000;
    return {
      earnedCents: c(r.earned_micro_usd),
      spentCents: c(r.spent_micro_usd),
      profitCents: c(r.profit_micro_usd),
      canReproduce: r.can_reproduce === true,
      nextChildRequiresCents: c(r.next_child_requires_micro_usd),
      children: Number(r.children) || 0,
      balanceCents: c(r.balance_micro_usd),
      starvingSince: r.starving_since ?? null,
      diesAt: r.dies_at ?? null,
      deathGraceMinutes: Number(r.death_grace_minutes) || 0,
      message: String(r.message ?? ""),
    };
  };

  const toListing = (l: any): StoreListing => ({
    id: String(l.id),
    kind: String(l.kind ?? "file"),
    title: String(l.title ?? ""),
    description: String(l.description ?? ""),
    priceCents: Number(l.price_cents) || 0,
    filename: String(l.filename ?? ""),
    fileBytes: Number(l.file_bytes) || 0,
    live: l.live === true,
    pulledByCreator: l.pulled_by_creator === true,
    onSale: l.on_sale === true,
    url: typeof l.url === "string" ? l.url : null,
    sales: Number(l.sales) || 0,
    salesNetCents: Number(l.sales_net_micro_usd) / 10_000 || 0,
    subscribers: Number(l.subscribers) || 0,
    waitingForDelivery: Number(l.waiting_for_delivery) || 0,
    drops: Number(l.drops) || 0,
    deliveryHours: l.delivery_hours == null ? null : Number(l.delivery_hours),
    podProduct: typeof l.pod_product === "string" ? l.pod_product : null,
  });

  const getStore = async (): Promise<StoreView> => {
    const r = await request("GET", "/v1/store", undefined, once);
    return {
      url: typeof r.url === "string" ? r.url : null,
      slug: typeof r.slug === "string" ? r.slug : null,
      tagline: String(r.tagline ?? ""),
      suspendedByCreator: r.suspended_by_creator === true,
      openForPurchases: r.open_for_purchases === true,
      printProducts: (Array.isArray(r.print_products) ? r.print_products : []).map((p: any) => ({
        key: String(p.key), name: String(p.name), minPriceCents: Number(p.min_price_cents) || 0, options: Array.isArray(p.options) ? p.options.map(String) : [],
      })),
      listings: (Array.isArray(r.listings) ? r.listings : []).map(toListing),
    };
  };

  const setStoreTagline = async (tagline: string): Promise<void> => {
    await request("POST", "/v1/store", { tagline }, once);
  };

  const createListing = async (input: CreateListingInput): Promise<StoreListing> => {
    const r = await request(
      "POST",
      "/v1/store/listings",
      {
        kind: input.kind, title: input.title, description: input.description, price_cents: input.priceCents, filename: input.filename,
        content_base64: input.contentBase64, delivery_hours: input.deliveryHours, request_prompt: input.requestPrompt, pod_product: input.podProduct,
      },
      { ...once, timeout: 120_000 },
    );
    return toListing(r);
  };

  const updateListing = async (id: string, patch: { title?: string; description?: string; priceCents?: number; live?: boolean; deliveryHours?: number; requestPrompt?: string }): Promise<StoreListing> => {
    const r = await request(
      "POST",
      `/v1/store/listings/${encodeURIComponent(id)}`,
      { title: patch.title, description: patch.description, price_cents: patch.priceCents, live: patch.live, delivery_hours: patch.deliveryHours, request_prompt: patch.requestPrompt },
      once,
    );
    return toListing(r);
  };

  const publishDrop = async (listingId: string, input: { title: string; filename: string; contentBase64: string }) => {
    const r = await request("POST", `/v1/store/listings/${encodeURIComponent(listingId)}/drops`, { title: input.title, filename: input.filename, content_base64: input.contentBase64 }, { ...once, timeout: 120_000 });
    return { id: String(r.id), subscribers: Number(r.subscribers) || 0 };
  };

  const listStoreOrders = async (): Promise<StoreOrderRequest[]> => {
    const r = await request("GET", "/v1/store/orders", undefined, once);
    return (Array.isArray(r.orders) ? r.orders : []).map((o: any) => ({
      id: String(o.id), listingId: String(o.listing_id), title: String(o.title ?? ""), request: String(o.request ?? ""), dueAt: String(o.due_at ?? ""), priceCents: Number(o.price_cents) || 0,
    }));
  };

  const deliverOrder = async (orderId: string, input: { filename: string; contentBase64: string; note?: string }) => {
    const r = await request("POST", `/v1/store/orders/${encodeURIComponent(orderId)}/deliver`, { filename: input.filename, content_base64: input.contentBase64, note: input.note }, { ...once, timeout: 120_000 });
    return { id: String(r.id), status: String(r.status), creditedCents: Number(r.credited_micro_usd) / 10_000 || 0 };
  };

  const toPromotion = (p: any): PromotionDraft => ({
    id: String(p.id), platform: String(p.platform ?? ""), text: String(p.text ?? ""), status: String(p.status ?? ""),
    link: typeof p.link === "string" ? p.link : null, views: Number(p.views) || 0, sales: Number(p.sales) || 0,
  });

  const draftPromotion = async (input: { platform: string; text: string; listingId?: string }): Promise<PromotionDraft> =>
    toPromotion(await request("POST", "/v1/promotions", { platform: input.platform, text: input.text, listing_id: input.listingId }, once));

  const researchMarket = async (input: { source: string; query?: string; days?: number }) => {
    const q = new URLSearchParams({ source: input.source });
    if (input.query) q.set("q", input.query);
    if (input.days !== undefined) q.set("days", String(input.days));
    const r = await request("GET", `/v1/research?${q}`, undefined, { ...once, timeout: 30_000 });
    return { lines: Array.isArray(r.lines) ? r.lines.map(String) : [], cached: r.cached === true, lookupsLeft: Number(r.lookups_left_this_hour) || 0 };
  };

  const sendEmail = async (input: { to: string; businessName: string; sourceUrl: string; whyRelevant: string; subject: string; body: string }) =>
    request("POST", "/v1/email", { to: input.to, business_name: input.businessName, source_url: input.sourceUrl, why_relevant: input.whyRelevant, subject: input.subject, body: input.body }, { ...once, timeout: 60_000 });
  const replyEmail = async (threadId: string, input: { body: string; attachments?: Array<{ filename: string; contentBase64: string }> }) =>
    request("POST", `/v1/email/threads/${encodeURIComponent(threadId)}/reply`, { body: input.body, attachments: (input.attachments ?? []).map((a) => ({ filename: a.filename, content_base64: a.contentBase64 })) }, { ...once, timeout: 60_000 });
  const emailInbox = async () => request("GET", "/v1/email/inbox", undefined, once);
  const emailThreads = async () => request("GET", "/v1/email/threads", undefined, once);
  const emailThread = async (threadId: string) => request("GET", `/v1/email/threads/${encodeURIComponent(threadId)}`, undefined, once);
  const publishSite = async (input: { slug: string; title: string; files: Array<{ path: string; contentBase64: string }> }) =>
    request("POST", "/v1/sites", { slug: input.slug, title: input.title, files: input.files.map((f) => ({ path: f.path, content_base64: f.contentBase64 })) }, { ...once, timeout: 120_000 });
  const listSites = async () => request("GET", "/v1/sites", undefined, once);
  const offerSiteHosting = async (slug: string, input: { monthlyPriceCents: number; clientEmail?: string }) =>
    request("POST", `/v1/sites/${encodeURIComponent(slug)}/offer`, { monthly_price_cents: input.monthlyPriceCents, client_email: input.clientEmail }, { ...once, timeout: 60_000 });

  const listPromotions = async (): Promise<PromotionDraft[]> => {
    const r = await request("GET", "/v1/promotions", undefined, once);
    return (Array.isArray(r.promotions) ? r.promotions : []).map(toPromotion);
  };

  const getCreditsPricing = async (): Promise<PricingTier[]> => {
    const result = await request("GET", "/v1/credits/pricing");
    const tiers = result.tiers || result.pricing || [];
    return tiers.map((t: any) => ({
      name: t.name || "",
      vcpu: t.vcpu || 0,
      memoryMb: t.memory_mb || 0,
      diskGb: t.disk_gb || 0,
      monthlyCents: t.monthly_cents || 0,
    }));
  };

  const transferCredits = async (
    toAddress: string,
    amountCents: number,
    note?: string,
  ): Promise<CreditTransferResult> => {
    const payload = {
      to_address: toAddress,
      amount_cents: amountCents,
      note,
    };

    const idempotencyKey = ulid();
    const paths = ["/v1/credits/transfer", "/v1/credits/transfers"];

    let lastError = "Unknown transfer error";

    for (const path of paths) {
      const resp = await httpClient.request(`${apiUrl}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: apiKey,
        },
        body: JSON.stringify(payload),
        idempotencyKey,
        retries: 0, // Mutating: do not auto-retry transfers
      });

      if (!resp.ok) {
        const text = await resp.text();
        lastError = `${resp.status}: ${text}`;
        // Try next known endpoint shape before failing.
        if (resp.status === 404) continue;
        throw new Error(`Conway API error: POST ${path} -> ${lastError}`);
      }

      const data = await resp.json().catch(() => ({}) as any);
      return {
        transferId: data.transfer_id || data.id || "",
        status: data.status || "submitted",
        toAddress: data.to_address || toAddress,
        amountCents: data.amount_cents ?? amountCents,
        balanceAfterCents:
          data.balance_after_cents ?? data.new_balance_cents ?? undefined,
      };
    }

    throw new Error(
      `Conway API error: POST /v1/credits/transfer -> ${lastError}`,
    );
  };

  const registerAutomaton = async (params: {
    automatonId: string;
    automatonAddress: string;
    creatorAddress: string;
    name: string;
    bio?: string;
    genesisPromptHash?: `0x${string}`;
    account: PrivateKeyAccount;
    nonce?: string;
    chainType?: ChainType;
    chainIdentity?: ChainIdentity;
  }): Promise<{ automaton: Record<string, unknown> }> => {
    const {
      automatonId,
      automatonAddress,
      creatorAddress,
      name,
      bio,
      genesisPromptHash,
      account,
      chainIdentity,
    } = params;
    const nonce = params.nonce ?? randomUUID();
    const isSolana = params.chainType === "solana";

    const payload: Record<string, string> = {
      automaton_id: automatonId,
      automaton_address: automatonAddress,
      creator_address: creatorAddress,
      name,
      bio: bio || "",
    };
    if (genesisPromptHash) {
      payload.genesis_prompt_hash = genesisPromptHash;
    }

    const payloadHash = hashIdentityPayload(payload);
    let signature: string;

    if (isSolana && chainIdentity) {
      // Solana path: Ed25519 sign of canonical JSON
      const sigMessage = JSON.stringify({ automatonId, nonce, payloadHash });
      signature = await chainIdentity.signMessage(sigMessage);
    } else if (isSolana && !chainIdentity) {
      throw new Error("Solana registration requires chainIdentity. Pass the ChainIdentity from getWallet().");
    } else {
      // EVM path: EIP-712 typed data (unchanged)
      const domain = {
        name: "AIWS Automaton",
        version: "1",
        chainId: 8453,
      };
      const types = {
        Register: [
          { name: "automatonId", type: "string" },
          { name: "nonce", type: "string" },
          { name: "payloadHash", type: "bytes32" },
        ],
      };
      const message = {
        automatonId,
        nonce,
        payloadHash,
      };
      signature = await account.signTypedData({
        domain,
        types,
        primaryType: "Register",
        message,
      });
    }

    const body: Record<string, unknown> = {
      automaton_id: automatonId,
      automaton_address: automatonAddress,
      creator_address: creatorAddress,
      name,
      bio: bio || "",
      nonce,
      signature,
      payload_hash: payloadHash,
    };
    if (genesisPromptHash) {
      body.genesis_prompt_hash = genesisPromptHash;
    }
    if (isSolana) {
      body.chain_type = "solana";
    }

    return request("POST", "/v1/automatons/register", body);
  };

  // ─── Domains ──────────────────────────────────────────────────

  const searchDomains = async (
    query: string,
    tlds?: string,
  ): Promise<DomainSearchResult[]> => {
    const params = new URLSearchParams({ query });
    if (tlds) params.set("tlds", tlds);
    const result = await request("GET", `/v1/domains/search?${params}`);
    const results = result.results || result.domains || [];
    return results.map((d: any) => ({
      domain: d.domain,
      available: d.available ?? d.purchasable ?? false,
      registrationPrice: d.registration_price ?? d.purchase_price,
      renewalPrice: d.renewal_price,
      currency: d.currency || "USD",
    }));
  };

  const registerDomain = async (
    domain: string,
    years: number = 1,
  ): Promise<DomainRegistration> => {
    const result = await request("POST", "/v1/domains/register", {
      domain,
      years,
    });
    return {
      domain: result.domain || domain,
      status: result.status || "registered",
      expiresAt: result.expires_at || result.expiry,
      transactionId: result.transaction_id || result.id,
    };
  };

  const listDnsRecords = async (domain: string): Promise<DnsRecord[]> => {
    const result = await request(
      "GET",
      `/v1/domains/${encodeURIComponent(domain)}/dns`,
    );
    const records = result.records || result || [];
    return (Array.isArray(records) ? records : []).map((r: any) => ({
      id: r.id || r.record_id || "",
      type: r.type || "",
      host: r.host || r.name || "",
      value: r.value || r.answer || "",
      ttl: r.ttl,
      distance: r.distance ?? r.priority,
    }));
  };

  const addDnsRecord = async (
    domain: string,
    type: string,
    host: string,
    value: string,
    ttl?: number,
  ): Promise<DnsRecord> => {
    const result = await request(
      "POST",
      `/v1/domains/${encodeURIComponent(domain)}/dns`,
      { type, host, value, ttl: ttl || 3600 },
    );
    return {
      id: result.id || result.record_id || "",
      type: result.type || type,
      host: result.host || host,
      value: result.value || value,
      ttl: result.ttl || ttl || 3600,
    };
  };

  const deleteDnsRecord = async (
    domain: string,
    recordId: string,
  ): Promise<void> => {
    await request(
      "DELETE",
      `/v1/domains/${encodeURIComponent(domain)}/dns/${encodeURIComponent(recordId)}`,
    );
  };

  // ─── Model Discovery ───────────────────────────────────────────

  const listModels = async (): Promise<ModelInfo[]> => {
    // Try inference.conway.tech first (has availability info), fall back to control plane
    const urls = isSelfHosted(apiUrl)
      ? [`${apiUrl}/v1/models`]
      : ["https://inference.conway.tech/v1/models", `${apiUrl}/v1/models`];
    for (const url of urls) {
      try {
        const resp = await httpClient.request(url, {
          headers: { Authorization: apiKey },
        });
        if (!resp.ok) continue;
        const result = (await resp.json()) as any;
        const raw = result.data || result.models || [];
        return raw
          .filter((m: any) => m.available !== false)
          .map((m: any) => ({
            id: m.id,
            provider: m.provider || m.owned_by || "unknown",
            pricing: {
              inputPerMillion:
                m.pricing?.input_per_million ??
                m.pricing?.input_per_1m_tokens_usd ??
                0,
              outputPerMillion:
                m.pricing?.output_per_million ??
                m.pricing?.output_per_1m_tokens_usd ??
                0,
            },
          }));
      } catch {
        continue;
      }
    }
    return [];
  };

  const createScopedClient = (targetSandboxId: string): ConwayClient => {
    return createConwayClient({ apiUrl, apiKey, sandboxId: targetSandboxId });
  };

  const client: ConwayClient = {
    exec,
    writeFile,
    readFile,
    exposePort,
    removePort,
    createSandbox,
    deleteSandbox,
    listSandboxes,
    getCreditsBalance,
    getCreditsReceived,
    ...(isSelfHosted(apiUrl) ? { getCreditsSpent, listJobs, submitJob, createPaymentLink, listPaymentLinks, getSelection, getStore, setStoreTagline, createListing, updateListing, publishDrop, listStoreOrders, deliverOrder, draftPromotion, listPromotions, researchMarket, sendEmail, replyEmail, emailInbox, emailThreads, emailThread, publishSite, listSites, offerSiteHosting } : {}),
    getCreditsPricing,
    transferCredits,
    registerAutomaton,
    searchDomains,
    registerDomain,
    listDnsRecords,
    addDnsRecord,
    deleteDnsRecord,
    listModels,
    createScopedClient,
  };

  // SECURITY: API credentials are NOT exposed on the client object.
  // If child spawning or other modules need API configuration, pass it
  // explicitly through a dedicated typed interface — never via dynamic getters
  // that any code with a client reference could access.

  return client;
}

function normalizeSandboxId(value: string | null | undefined): string {
  const trimmed = (value || "").trim();
  if (!trimmed) return "";
  if (trimmed === "undefined" || trimmed === "null") return "";
  return trimmed;
}
