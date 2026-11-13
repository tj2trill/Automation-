/**
 * Host Control Plane — Metered inference proxy
 *
 * Agents never hold an upstream API key. They call this proxy with their
 * host API key; the proxy calls Anthropic / an OpenAI-compatible API / local
 * Ollama, measures the tokens the upstream reports, and charges the agent's
 * ledger. That is what makes "survival" real: an agent holding the provider
 * key itself could think for free and its balance would mean nothing.
 *
 * Fallback: if a paid upstream is unreachable or misconfigured, the request
 * is retried once on the low-compute (local) model so a provider outage
 * degrades the agent instead of stopping it.
 */

import type { ChatMessage, InferenceClient, InferenceResponse, InferenceToolDefinition } from "../types.js";
import { createInferenceClient } from "../conway/inference.js";
import type { HostConfig, HostModelConfig, UpstreamKeys } from "./config.js";
import { modelForRole } from "./config.js";
import type { HostStore } from "./store.js";
import { microToCents } from "./store.js";

export class ProxyError extends Error {
  constructor(public readonly status: number, message: string, public readonly code: string) {
    super(message);
    this.name = "ProxyError";
  }
}

export interface ChatCompletionRequest {
  model?: string;
  messages?: ChatMessage[];
  tools?: InferenceToolDefinition[];
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
}

export type UpstreamChat = (
  model: HostModelConfig,
  messages: ChatMessage[],
  opts: { maxTokens: number; temperature?: number; tools?: InferenceToolDefinition[] },
) => Promise<InferenceResponse>;

/**
 * Resolve a requested model id to a configured model.
 *
 * Exact ids win. Anything else is an alias: parts of the runtime (the
 * orchestrator's provider registry, the default routing matrix) ask for
 * hard-coded names such as "gpt-5-mini". Rather than fail those calls, small
 * model names map to the low-compute role and everything else to primary.
 */
export function resolveModel(config: HostConfig, requested: string | undefined): HostModelConfig {
  const id = (requested || "").trim();
  const exact = config.models.find((m) => m.id === id);
  if (exact) return exact;
  if (/(mini|nano|haiku|small|lite|instant|flash)/i.test(id)) return modelForRole(config, "low_compute");
  return modelForRole(config, "primary");
}

/** Cache prices for a model, from config or the conservative defaults. */
export function cachePrices(model: HostModelConfig): { read: number; write: number } {
  const input = model.inputPerMillionUsd;
  const read = model.cacheReadPerMillionUsd ?? (model.upstream === "anthropic" ? input * 0.1 : model.upstream === "openai" ? input * 0.5 : input);
  const write = model.cacheWritePerMillionUsd ?? (model.upstream === "anthropic" ? input * 1.25 : input);
  return { read, write };
}

/**
 * tokens x (USD per million tokens) is exactly micro-dollars. inputTokens is
 * all input; the cached part of it is priced at the cache rates.
 */
export function costMicro(model: HostModelConfig, inputTokens: number, outputTokens: number, cache: { read?: number; write?: number } = {}): number {
  const read = Math.max(0, Math.min(cache.read ?? 0, inputTokens));
  const write = Math.max(0, Math.min(cache.write ?? 0, inputTokens - read));
  const plain = inputTokens - read - write;
  const p = cachePrices(model);
  return Math.round(plain * model.inputPerMillionUsd + read * p.read + write * p.write + outputTokens * model.outputPerMillionUsd);
}

export function isFree(model: HostModelConfig): boolean {
  return model.inputPerMillionUsd === 0 && model.outputPerMillionUsd === 0;
}

/** Build the real upstream caller from config + environment keys. */
export function createUpstreamChat(config: HostConfig, keys: UpstreamKeys): UpstreamChat {
  // One client per upstream. They must not share an HTTP client: its circuit
  // breaker is per-instance, so a provider outage on a shared client would
  // open the circuit and block the local fallback too.
  const clients = new Map<string, InferenceClient>();
  const clientFor = (kind: HostModelConfig["upstream"]): InferenceClient => {
    let client = clients.get(kind);
    if (!client) {
      client = createInferenceClient({
        // The "conway" backend is never selected: every configured model has
        // an explicit upstream, and missing keys are rejected before the call.
        apiUrl: "http://127.0.0.1:9",
        apiKey: "unused",
        defaultModel: modelForRole(config, "primary").id,
        maxTokens: 4096,
        openaiApiKey: kind === "openai" ? keys.openaiApiKey : undefined,
        openaiBaseUrl: config.openaiBaseUrl,
        anthropicApiKey: kind === "anthropic" ? keys.anthropicApiKey : undefined,
        ollamaBaseUrl: kind === "ollama" ? config.ollamaBaseUrl : undefined,
        getModelProvider: () => kind,
      });
      clients.set(kind, client);
    }
    return client;
  };

  return async (model, messages, opts) => {
    if (model.upstream === "anthropic" && !keys.anthropicApiKey) {
      throw new ProxyError(503, "ANTHROPIC_API_KEY is not set on the host", "upstream_not_configured");
    }
    if (model.upstream === "openai" && !keys.openaiApiKey) {
      throw new ProxyError(503, "OPENAI_API_KEY is not set on the host", "upstream_not_configured");
    }
    return clientFor(model.upstream).chat(messages, {
      model: model.upstreamModel || model.id,
      maxTokens: opts.maxTokens,
      temperature: opts.temperature,
      tools: opts.tools,
    });
  };
}

export interface ProxyResult {
  body: Record<string, unknown>;
  servedBy: HostModelConfig;
  costMicro: number;
  fellBack: boolean;
}

export async function handleChatCompletion(params: {
  address: string;
  request: ChatCompletionRequest;
  config: HostConfig;
  store: HostStore;
  upstream: UpstreamChat;
  log?: (msg: string) => void;
}): Promise<ProxyResult> {
  const { address, request, config, store, upstream, log } = params;

  if (!Array.isArray(request.messages) || request.messages.length === 0) {
    throw new ProxyError(400, "messages must be a non-empty array", "invalid_request");
  }

  let model = resolveModel(config, request.model);

  // Pre-flight: refuse BEFORE spending upstream money. A frozen account gets
  // nothing; a broke account may only use free (local) models.
  const gate = store.canSpend(address);
  if (!gate.ok && gate.reason === "frozen") {
    throw new ProxyError(403, "Account is frozen by the creator", "account_frozen");
  }
  if (!gate.ok && !isFree(model)) {
    const free = modelForRole(config, "critical");
    if (!isFree(free)) {
      throw new ProxyError(
        402,
        `Insufficient credits (balance ${microToCents(gate.balanceMicro)} cents)`,
        "insufficient_credits",
      );
    }
    model = free;
  }

  const requestedMax = request.max_completion_tokens ?? request.max_tokens ?? model.maxTokens ?? 4096;
  const callOpts = (m: HostModelConfig) => ({
    maxTokens: Math.max(1, Math.min(requestedMax, m.maxTokens ?? requestedMax)),
    temperature: request.temperature,
    tools: request.tools && request.tools.length > 0 ? request.tools : undefined,
  });

  let response: InferenceResponse;
  let fellBack = false;
  try {
    response = await upstream(model, request.messages, callOpts(model));
  } catch (err: any) {
    const fallback = modelForRole(config, "low_compute");
    // Only fall back across upstreams: retrying the same broken one is pointless,
    // and a 4xx about the request itself would fail identically.
    const requestFault = err instanceof ProxyError ? false : /: 4(00|13|22)\b/.test(String(err?.message));
    if (fallback.id === model.id || fallback.upstream === model.upstream || requestFault) {
      if (err instanceof ProxyError) throw err;
      throw new ProxyError(502, `Upstream ${model.upstream} failed: ${err?.message || err}`, "upstream_error");
    }
    log?.(`inference: ${model.id} failed (${err?.message || err}); falling back to ${fallback.id}`);
    try {
      response = await upstream(fallback, request.messages, callOpts(fallback));
    } catch (err2: any) {
      throw new ProxyError(
        502,
        `Upstream ${model.upstream} failed (${err?.message || err}) and fallback ${fallback.id} failed (${err2?.message || err2})`,
        "upstream_error",
      );
    }
    model = fallback;
    fellBack = true;
  }

  const inputTokens = response.usage?.promptTokens || 0;
  const outputTokens = response.usage?.completionTokens || 0;
  const cacheRead = response.usage?.cacheReadTokens || 0;
  const cacheWrite = response.usage?.cacheWriteTokens || 0;
  const cost = costMicro(model, inputTokens, outputTokens, { read: cacheRead, write: cacheWrite });
  const usageId = store.recordUsage({
    address,
    model: model.id,
    upstream: model.upstream,
    inputTokens,
    outputTokens,
    costMicro: cost,
  });
  const cacheNote = cacheRead || cacheWrite ? ` (${cacheRead} cached${cacheWrite ? `, ${cacheWrite} cache write` : ""})` : "";
  store.charge(address, cost, "inference", usageId, `${model.id} ${inputTokens}in/${outputTokens}out${cacheNote}`);

  const toolCalls = response.toolCalls && response.toolCalls.length > 0 ? response.toolCalls : undefined;
  const body = {
    id: response.id || `chatcmpl_${usageId}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: model.id,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: response.message?.content || "",
          ...(toolCalls ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: toolCalls ? "tool_calls" : response.finishReason || "stop",
      },
    ],
    usage: {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
    },
    x_automaton: {
      cost_micro_usd: cost,
      balance_cents: microToCents(store.getBalanceMicro(address)),
      fell_back: fellBack,
    },
  };

  return { body, servedBy: model, costMicro: cost, fellBack };
}
