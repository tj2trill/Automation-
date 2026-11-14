import { afterEach, describe, expect, it, vi } from "vitest";
import { getUsdcBalance } from "../conway/x402.js";

const OWNER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const account = (uiAmount: number | null) => ({ account: { data: { parsed: { info: { tokenAmount: { uiAmount } } } } } });

function stubRpc(reply: unknown, status = 200) {
  const calls: Array<{ url: string; body: any }> = [];
  vi.stubGlobal("fetch", async (url: any, init: any) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(JSON.stringify(reply), { status, headers: { "Content-Type": "application/json" } });
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.SOLANA_RPC_URL;
});

describe("Solana USDC balance", () => {
  it("asks the RPC for the owner's USDC token accounts and sums them", async () => {
    process.env.SOLANA_RPC_URL = "https://rpc.example.test";
    const calls = stubRpc({ jsonrpc: "2.0", id: 1, result: { value: [account(1.5), account(2.25), account(null)] } });
    expect(await getUsdcBalance(OWNER, "solana:mainnet", "solana")).toBe(3.75);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://rpc.example.test");
    expect(calls[0]!.body.method).toBe("getTokenAccountsByOwner");
    expect(calls[0]!.body.params).toEqual([OWNER, { mint: USDC_MINT }, { encoding: "jsonParsed", commitment: "confirmed" }]);
  });

  it("is zero when the wallet holds no USDC account", async () => {
    stubRpc({ jsonrpc: "2.0", id: 1, result: { value: [] } });
    expect(await getUsdcBalance(OWNER, "solana:mainnet", "solana")).toBe(0);
  });

  it("refuses an address that is not a 32-byte base58 key, without calling the RPC", async () => {
    const calls = stubRpc({});
    await expect(getUsdcBalance("not-a-solana-address!", "solana:mainnet", "solana")).rejects.toThrow(/Solana USDC balance check failed/);
    await expect(getUsdcBalance("0x1111111111111111111111111111111111111111", "solana:mainnet", "solana")).rejects.toThrow(/Solana USDC balance check failed/);
    expect(calls).toHaveLength(0);
  });

  it("reports an RPC error or a bad HTTP status instead of returning a balance", async () => {
    stubRpc({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "Invalid param" } });
    await expect(getUsdcBalance(OWNER, "solana:mainnet", "solana")).rejects.toThrow(/Invalid param/);
    stubRpc({ error: "rate limited" }, 429);
    await expect(getUsdcBalance(OWNER, "solana:mainnet", "solana")).rejects.toThrow(/429/);
  });
});
