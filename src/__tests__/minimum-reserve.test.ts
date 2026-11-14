import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBuiltinTools } from "../agent/tools.js";
import { reserveShortfall } from "../agent/policy-rules/financial.js";
import { DEFAULT_TREASURY_POLICY } from "../types.js";
import type { AutomatonDatabase, AutomatonTool, ToolContext } from "../types.js";
import { MockConwayClient, MockInferenceClient, createTestConfig, createTestDb, createTestIdentity } from "./mocks.js";

describe("minimum reserve", () => {
  let transfer: AutomatonTool;
  let ctx: ToolContext;
  let db: AutomatonDatabase;
  let conway: MockConwayClient;

  beforeEach(() => {
    transfer = createBuiltinTools("test-sandbox-id").find((t) => t.name === "transfer_credits")!;
    db = createTestDb();
    conway = new MockConwayClient();
    ctx = { identity: createTestIdentity(), config: createTestConfig(), db, conway, inference: new MockInferenceClient() };
  });
  afterEach(() => db.close());

  const send = (cents: number) => transfer.execute({ to_address: "0x1111111111111111111111111111111111111111", amount_cents: cents }, ctx);

  it("blocks a transfer that would leave less than the configured reserve, and moves no money", async () => {
    ctx.config.treasuryPolicy = { ...DEFAULT_TREASURY_POLICY, minimumReserveCents: 300 };
    conway.creditsCents = 500;
    const result = await send(250); // within the half-balance guard, but leaves 250 < 300
    expect(result).toMatch(/^Blocked: .*minimum reserve of \$3\.00/);
    expect(conway.creditsCents).toBe(500);
  });

  it("allows a transfer that leaves exactly the reserve", async () => {
    ctx.config.treasuryPolicy = { ...DEFAULT_TREASURY_POLICY, minimumReserveCents: 300 };
    conway.creditsCents = 500;
    expect(await send(200)).not.toMatch(/^Blocked/);
    expect(conway.creditsCents).toBe(300);
  });

  it("uses the default reserve when the config has no treasury policy", async () => {
    ctx.config.treasuryPolicy = undefined;
    conway.creditsCents = 150;
    expect(await send(60)).toMatch(/minimum reserve/); // leaves 90 < default 100
    expect(conway.creditsCents).toBe(150);
  });

  it("defaults to a reserve small enough that a $5 agent can still fund a child", () => {
    expect(DEFAULT_TREASURY_POLICY.minimumReserveCents).toBe(100);
    expect(reserveShortfall(500, 250, DEFAULT_TREASURY_POLICY)).toBeNull();
    expect(reserveShortfall(150, 60, DEFAULT_TREASURY_POLICY)).toMatch(/minimum reserve of \$1\.00/);
    expect(reserveShortfall(150, 60, undefined)).toMatch(/minimum reserve of \$1\.00/);
  });
});
