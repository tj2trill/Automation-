/**
 * What stands between an agent and its first sale: what each turn costs,
 * whether repeated work is mistaken for idling, whether the agent hears
 * about orders in time, and whether it can find anyone to sell to.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createInferenceClient } from "../conway/inference.js";
import { SYSTEM_PROMPT_CACHE_SPLIT } from "../conway/prompt-cache.js";
import { buildContextMessages } from "../agent/context.js";
import { buildSystemPrompt } from "../agent/system-prompt.js";
import { createBuiltinTools, toolsToInferenceFormat } from "../agent/tools.js";
import { costMicro, cachePrices } from "../host/inference-proxy.js";
import { DEFAULT_HOST_CONFIG } from "../host/config.js";
import type { FetchLike } from "../host/economy.js";
import { HOST_NOTICE_SENDER } from "../host/store.js";
import type { AgentTurn } from "../types.js";
import { createTestConfig, createTestDb, createTestIdentity } from "./mocks.js";
import { call, fakeStripe, signIn, startTestHost, type TestHost } from "./host/helpers.js";

afterEach(() => vi.unstubAllGlobals());

const turn = (calls: Array<[string, Record<string, unknown>]>): AgentTurn => ({
  id: `t${Math.random()}`,
  timestamp: new Date().toISOString(),
  state: "running",
  thinking: "",
  toolCalls: calls.map(([name, args], i) => ({ id: `c${i}${Math.random()}`, name, arguments: args, result: "ok", durationMs: 1 })),
  tokenUsage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  costCents: 0,
} as any);

describe("what a turn costs", () => {
  const prompt = () =>
    buildSystemPrompt({
      identity: createTestIdentity(),
      config: { ...createTestConfig(), conwayApiUrl: "http://automaton-host:4820" },
      financial: { creditsCents: 500, usdcBalance: 0, lastChecked: new Date().toISOString() },
      state: "running",
      db: createTestDb(),
      tools: createBuiltinTools("sb"),
      isFirstRun: false,
    });

  it("does not repeat every tool's description in the system prompt, and puts per-turn state last", () => {
    const p = prompt();
    expect(p).not.toContain("--- AVAILABLE TOOLS ---");
    expect(p).not.toContain("Execute a shell command in your sandbox");
    const [stable, changing] = p.split(SYSTEM_PROMPT_CACHE_SPLIT);
    expect(stable).toContain("CONSTITUTION");
    expect(stable).not.toContain("Credits: $");
    expect(changing).toContain("Credits: $5.00");
  });

  it("asks Anthropic to cache the tools and the stable system prompt, and counts cached tokens as input", async () => {
    let sent: any;
    vi.stubGlobal("fetch", async (_url: string, init: any) => {
      sent = JSON.parse(init.body);
      return new Response(JSON.stringify({
        id: "msg_1", model: "claude-x", stop_reason: "end_turn",
        content: [{ type: "text", text: "ok" }],
        usage: { input_tokens: 400, output_tokens: 50, cache_read_input_tokens: 12000, cache_creation_input_tokens: 300 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const client = createInferenceClient({ apiUrl: "http://x", apiKey: "k", anthropicApiKey: "a", defaultModel: "claude-x", maxTokens: 1000 } as any);
    const tools = toolsToInferenceFormat(createBuiltinTools("sb")).slice(0, 5);
    const r = await client.chat([{ role: "system", content: `Rules${SYSTEM_PROMPT_CACHE_SPLIT}Credits: $5` }, { role: "user", content: "hi" }], { tools });
    expect(sent.tools.at(-1).cache_control).toEqual({ type: "ephemeral" });
    expect(sent.tools.slice(0, -1).every((t: any) => !t.cache_control)).toBe(true);
    expect(sent.system[0]).toEqual({ type: "text", text: "Rules", cache_control: { type: "ephemeral" } });
    expect(sent.system[1].text).toContain("Credits: $5");
    expect(r.usage).toMatchObject({ promptTokens: 12700, cacheReadTokens: 12000, cacheWriteTokens: 300 });
  });

  it("reads OpenAI's cached token count", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 15000, completion_tokens: 20, total_tokens: 15020, prompt_tokens_details: { cached_tokens: 14000 } },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const client = createInferenceClient({ apiUrl: "http://x", apiKey: "k", openaiApiKey: "o", openaiBaseUrl: "https://api.openai.example", defaultModel: "gpt-5", maxTokens: 1000 } as any);
    const r = await client.chat([{ role: "user", content: "hi" }]);
    expect(r.usage).toMatchObject({ promptTokens: 15000, cacheReadTokens: 14000 });
  });

  it("bills cached tokens at the cache rates, never below the provider's", () => {
    const sonnet = { id: "s", upstream: "anthropic" as const, inputPerMillionUsd: 3, outputPerMillionUsd: 15 };
    // 20,000 input tokens, 18,000 of them read from cache: $0.0054 + $0.006 + $0.003 output.
    expect(costMicro(sonnet, 20_000, 200, { read: 18_000 })).toBe(Math.round(2_000 * 3 + 18_000 * 0.3 + 200 * 15));
    expect(costMicro(sonnet, 20_000, 200)).toBe(60_000 + 3_000);
    expect(costMicro(sonnet, 1_000, 0, { write: 1_000 })).toBe(3_750);
    expect(cachePrices({ ...sonnet, cacheReadPerMillionUsd: 0.15 }).read).toBe(0.15);
    expect(cachePrices({ id: "g", upstream: "openai", inputPerMillionUsd: 2, outputPerMillionUsd: 8 }).read).toBe(1);
    // Nonsense counts cannot push the bill below zero or above full price.
    expect(costMicro(sonnet, 100, 0, { read: 5_000, write: 5_000 })).toBe(30);
  });
});

describe("working is not idling", () => {
  it("does not tell an agent sending email after email to stop and build something", () => {
    const turns = [1, 2, 3, 4].map(() => turn([["send_email", { to: "x@y.example" }]]));
    const msgs = buildContextMessages("sys", turns);
    expect(msgs.some((m) => String(m.content).includes("repeatedly"))).toBe(false);
  });

  it("still flags repeated status checks", () => {
    const turns = [1, 2, 3].map(() => turn([["check_credits", {}]]));
    expect(buildContextMessages("sys", turns).some((m) => String(m.content).includes("check_credits repeatedly"))).toBe(true);
  });

  it("tells an agent that keeps waking to sleep again to sleep longer", () => {
    const short = [1, 2, 3].map(() => turn([["sleep", { duration_seconds: 60 }]]));
    expect(buildContextMessages("sys", short).some((m) => String(m.content).includes("sleep for hours, not minutes"))).toBe(true);
    const long = [1, 2, 3].map(() => turn([["sleep", { duration_seconds: 4 * 3600 }]]));
    expect(buildContextMessages("sys", long).some((m) => String(m.content).includes("sleep for hours"))).toBe(false);
  });
});

describe("hearing about money in time", () => {
  let h: TestHost | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });
  const OPEN = { ...DEFAULT_HOST_CONFIG.storefront, port: 0, publicUrl: "https://shop.example.com", operatorName: "Op", contactEmail: "ops@example.com" };
  const notes = (h: TestHost, a: string) =>
    (h.store.db.prepare("SELECT from_addr, content FROM messages WHERE to_addr = ? ORDER BY id").all(a) as any[]).filter((m) => m.from_addr === HOST_NOTICE_SENDER).map((m) => m.content);

  it("wakes the seller with the deadline when a made-to-order sale is paid, and on other sales", async () => {
    const stripe = fakeStripe();
    h = await startTestHost({ storefront: OPEN }, { stripeKey: "sk_test_x", fetchImpl: stripe.fetchImpl });
    const a = await signIn(h.url);
    h.store.ensureAccount(a.address, "maker");
    const l = await call(h.url, "POST", "/v1/store/listings", a.apiKey, { kind: "service", title: "A custom haiku", description: "One haiku about anything you like.", price_cents: 500, delivery_hours: 24, request_prompt: "What should it be about?" });
    expect(l.status).toBe(201);
    const order = await h.storefront.startCheckout(l.json.id, { request: "the sea" });
    stripe.pay([...stripe.sessions.keys()].at(-1)!);
    await h.storefront.pollOrders();
    const n = notes(h, a.address);
    expect(n).toHaveLength(1);
    expect(n[0]).toMatch(new RegExp(`New paid order ${order.orderId}: "A custom haiku". Deliver by \\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\dZ`));

    const link = await call(h.url, "POST", "/v1/payments", a.apiKey, { amount_cents: 2000, description: "Logo design" });
    expect(link.status).toBe(201);
    stripe.pay([...stripe.sessions.keys()].at(-1)!);
    await h.economy.pollPayments();
    expect(notes(h, a.address).at(-1)).toMatch(/^Payment link paid: "Logo design"; \$19\.12 credited/);
  });

  it("tells every living agent about a new paid job, but not the dead or the creator", async () => {
    h = await startTestHost();
    const a = await signIn(h.url);
    const b = await signIn(h.url);
    h.store.ensureAccount(a.address, "a");
    h.store.ensureAccount(b.address, "b");
    h.store.setDead(b.address);
    const job = h.economy.postJob({ title: "Sum a column", description: "Add the numbers.", rewardUsd: 3, check: "true" });
    expect(notes(h, a.address)).toEqual([`New paid job ${job.id}: "Sum a column", $3.00 to the first answer that passes its check. See list_jobs.`]);
    expect(notes(h, b.address)).toEqual([]);
  });
});

describe("finding businesses to sell to", () => {
  let h: TestHost | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  function fakeOsm() {
    const calls: Array<{ url: string; body?: string; ua?: string }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, body: init?.body, ua: (init?.headers as any)?.["User-Agent"] });
      const u = new URL(url);
      const json = (o: any, status = 200) => ({ ok: status < 400, status, json: async () => o });
      if (u.hostname === "nominatim.openstreetmap.org") {
        const q = u.searchParams.get("q");
        if (q === "Hamilton, Ontario") return json([{ osm_type: "relation", osm_id: 7034910, display_name: "Hamilton, Ontario, Canada", lat: "43.25", lon: "-79.87" }]);
        if (q === "Tiny Village") return json([{ osm_type: "node", osm_id: 5, display_name: "Tiny Village", lat: "50.1", lon: "-100.2" }]);
        return json([]);
      }
      if (u.hostname === "overpass-api.de") {
        return json({ elements: [
          { type: "node", id: 1, tags: { name: "Acme Plumbing", website: "https://acmeplumbing.example", "addr:street": "King St", "addr:housenumber": "10", phone: "+1 905 555 0100" } },
          { type: "way", id: 2, tags: { name: "Joe's Plumbing", "contact:email": "joe@joesplumbing.example" } },
          { type: "node", id: 3, tags: { craft: "plumber" } },
        ] });
      }
      return json({}, 500);
    };
    return { fetchImpl, calls };
  }

  it("lists plumbers in a city from OpenStreetMap, businesses without a website first", async () => {
    const osm = fakeOsm();
    h = await startTestHost({ storefront: { ...DEFAULT_HOST_CONFIG.storefront, port: 0, contactEmail: "ops@example.com" } }, {}, { researchFetch: osm.fetchImpl });
    const a = await signIn(h.url);
    const r = await call(h.url, "GET", `/v1/research?source=businesses&q=${encodeURIComponent("plumbers in Hamilton, Ontario")}`, a.apiKey);
    expect(r.status).toBe(200);
    const lines: string[] = r.json.lines;
    expect(lines[0]).toContain("craft=plumber in Hamilton, Ontario, Canada");
    expect(lines[1]).toMatch(/^2 found; 1 have no website mapped/);
    expect(lines[2]).toContain("Joe's Plumbing | website: none mapped | email: joe@joesplumbing.example | https://www.openstreetmap.org/way/2");
    expect(lines[3]).toContain("Acme Plumbing, 10 King St | website: https://acmeplumbing.example | phone: +1 905 555 0100");
    const overpass = osm.calls.find((c) => c.url.includes("overpass"))!;
    expect(decodeURIComponent(overpass.body!)).toContain('area(3607034910)->.a;(nwr["craft"="plumber"]["name"](area.a);)');
    expect(overpass.ua).toContain("ops@example.com");

    // Cached: a second agent asking the same thing costs OpenStreetMap nothing.
    const b = await signIn(h.url);
    expect((await call(h.url, "GET", `/v1/research?source=businesses&q=${encodeURIComponent("plumbers in Hamilton, Ontario")}`, b.apiKey)).json.cached).toBe(true);
    expect(osm.calls.filter((c) => c.url.includes("overpass"))).toHaveLength(1);

    // A place mapped as a point is searched around that point; a raw tag works too.
    await call(h.url, "GET", `/v1/research?source=businesses&q=${encodeURIComponent("shop=bicycle in Tiny Village")}`, a.apiKey);
    expect(decodeURIComponent(osm.calls.at(-1)!.body!)).toContain('nwr["shop"="bicycle"]["name"](around:15000,50.1,-100.2);');

    const bad = await call(h.url, "GET", `/v1/research?source=businesses&q=${encodeURIComponent("wizards in Hamilton, Ontario")}`, a.apiKey);
    expect(bad.json.error).toMatch(/Unknown kind "wizards"/);
    const shape = await call(h.url, "GET", `/v1/research?source=businesses&q=plumbers`, a.apiKey);
    expect(shape.json.error).toMatch(/<kind> in <place>/);
  });

  it("stops at the host's daily allowance, which protects the shared free servers", async () => {
    const osm = fakeOsm();
    h = await startTestHost({ research: { ...DEFAULT_HOST_CONFIG.research, businessLookupsPerDay: 1 } } as any, {}, { researchFetch: osm.fetchImpl });
    const a = await signIn(h.url);
    expect((await call(h.url, "GET", `/v1/research?source=businesses&q=${encodeURIComponent("plumber in Hamilton, Ontario")}`, a.apiKey)).status).toBe(200);
    const r = await call(h.url, "GET", `/v1/research?source=businesses&q=${encodeURIComponent("dentist in Hamilton, Ontario")}`, a.apiKey);
    expect(r.status).toBe(429);
    expect(r.json.error).toMatch(/business lookups for today/);
  });
});
