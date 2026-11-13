/**
 * Model sync from a self-hosted control plane.
 *
 * The runtime's static model table and routing matrix name Conway's models
 * (gpt-5.2, gpt-5-mini, ...). A self-hosted control plane serves whatever
 * its creator configured, at the creator's prices. This module replaces the
 * registry contents with the host's list so that:
 *   - the router picks models the host actually serves, per survival tier;
 *   - the agent's own cost accounting uses the prices it is really charged.
 *
 * The host's ledger remains the source of truth for money; this only keeps
 * the agent's local picture consistent with it.
 */

import type { AutomatonConfig, ModelEntry, SurvivalTier } from "../types.js";
import { DEFAULT_MODEL_STRATEGY_CONFIG } from "../types.js";
import { ResilientHttpClient } from "../conway/http-client.js";
import type { ModelRegistry } from "./registry.js";

interface HostModel {
  id: string;
  roles?: string[];
  context_window?: number;
  max_tokens?: number;
  pricing?: { input_per_million?: number; output_per_million?: number };
}

export interface HostModelSyncResult {
  primary: string;
  lowCompute: string;
  critical: string;
  enabled: string[];
  disabled: string[];
}

/** Registry prices are hundredths of a cent per 1k tokens; $1/M tokens = 10 of those. */
export function usdPerMillionToRegistryUnits(usdPerMillion: number): number {
  return Math.round(usdPerMillion * 10 * 1000) / 1000;
}

/** Pure part: apply a host model list to the registry and strategy config. */
export function applyHostModels(
  models: HostModel[],
  registry: ModelRegistry,
  config: AutomatonConfig,
): HostModelSyncResult {
  const usable = models.filter((m) => m && typeof m.id === "string" && m.id);
  if (usable.length === 0) throw new Error("Control plane returned no models");

  const now = new Date().toISOString();
  const hostIds = new Set(usable.map((m) => m.id));

  const withRole = (role: string) => usable.find((m) => m.roles?.includes(role))?.id;
  const primary = withRole("primary") ?? usable[0]!.id;
  const lowCompute = withRole("low_compute") ?? primary;
  const critical = withRole("critical") ?? lowCompute;

  // The lowest tier a model actually has to serve decides its minimum. This
  // is derived from the resolved assignment, not the raw roles: a host with a
  // single model serves every tier with it, and marking that model
  // "normal-only" would leave the agent with no model once credits run low.
  const tierMinimumFor = (id: string): SurvivalTier =>
    id === critical ? "critical" : id === lowCompute ? "low_compute" : "normal";

  for (const m of usable) {
    const existing = registry.get(m.id);
    const entry: ModelEntry = {
      modelId: m.id,
      // "other" marks a model that is neither a built-in provider nor part of
      // the static baseline: the registry leaves such rows enabled on startup,
      // and the inference client sends them to the control plane.
      provider: "other",
      displayName: m.id,
      tierMinimum: tierMinimumFor(m.id),
      costPer1kInput: usdPerMillionToRegistryUnits(m.pricing?.input_per_million ?? 0),
      costPer1kOutput: usdPerMillionToRegistryUnits(m.pricing?.output_per_million ?? 0),
      maxTokens: m.max_tokens ?? 4096,
      contextWindow: m.context_window ?? 128_000,
      supportsTools: true,
      supportsVision: false,
      parameterStyle: "max_tokens",
      enabled: true,
      lastSeen: now,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
    registry.upsert(entry);
  }

  // Everything the host does not serve is switched off, so the routing
  // matrix's hard-coded candidates miss and selection falls through to the
  // strategy config below.
  const disabled: string[] = [];
  for (const entry of registry.getAll()) {
    if (!hostIds.has(entry.modelId) && entry.enabled) {
      registry.setEnabled(entry.modelId, false);
      disabled.push(entry.modelId);
    }
  }

  config.inferenceModel = primary;
  config.modelStrategy = {
    ...DEFAULT_MODEL_STRATEGY_CONFIG,
    ...(config.modelStrategy ?? {}),
    inferenceModel: primary,
    lowComputeModel: lowCompute,
    criticalModel: critical,
  };

  return { primary, lowCompute, critical, enabled: [...hostIds], disabled };
}

export async function syncModelsFromControlPlane(params: {
  apiUrl: string;
  apiKey: string;
  registry: ModelRegistry;
  config: AutomatonConfig;
}): Promise<HostModelSyncResult> {
  const http = new ResilientHttpClient();
  const resp = await http.request(`${params.apiUrl}/v1/models`, {
    headers: { Authorization: params.apiKey },
    timeout: 15_000,
  });
  if (!resp.ok) {
    throw new Error(`GET /v1/models -> ${resp.status}: ${await resp.text()}`);
  }
  const data = (await resp.json()) as { data?: HostModel[]; models?: HostModel[] };
  return applyHostModels(data.data || data.models || [], params.registry, params.config);
}
