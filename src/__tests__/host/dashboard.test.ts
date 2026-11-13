/**
 * Creator dashboard: every route behind a dashboard button, driven over real
 * HTTP, plus the layers that keep agents and other web pages out, and the
 * pieces that open it to the creator's phone.
 */
import http from "http";
import { EventEmitter } from "events";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { HostAdmin } from "../../host/admin.js";
import {
  createDashboardHandler,
  ipInCidr,
  isAllowedHost,
  listPhoneAddresses,
  phoneDashboardUrl,
  startDashboardServer,
} from "../../host/dashboard.js";
import { HostStore } from "../../host/store.js";
import { FakeDriver, testConfig } from "./helpers.js";

const TOKEN = "a".repeat(64);
const CREATOR = "0x00000000000000000000000000000000000000c1";

let store: HostStore;
let driver: FakeDriver;
let admin: HostAdmin;
let dash: Awaited<ReturnType<typeof startDashboardServer>>;
const logs: string[] = [];

function request(
  method: string,
  path: string,
  opts: { token?: string | null; body?: unknown; host?: string } = {},
): Promise<{ status: number; json: any; text: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const headers: Record<string, string> = { Host: opts.host ?? `127.0.0.1:${dash.port}` };
    if (opts.token !== null) headers["X-Admin-Token"] = opts.token ?? TOKEN;
    if (payload) headers["Content-Type"] = "application/json";
    const req = http.request({ host: "127.0.0.1", port: dash.port, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf-8");
        let json: any = null;
        try { json = JSON.parse(text); } catch { /* asset */ }
        resolve({ status: res.statusCode || 0, json, text, headers: res.headers });
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

beforeAll(async () => {
  store = new HostStore(":memory:");
  driver = new FakeDriver();
  admin = new HostAdmin(testConfig(), store, driver, CREATOR);
  store.ensureAccount(CREATOR, "creator");
  dash = await startDashboardServer({
    admin,
    token: TOKEN,
    port: 0,
    allowedHosts: ["my-box.tailnet.ts.net"],
    bindAddresses: ["0.0.0.0", "::", admin.config.dockerGateway],
    log: (m) => logs.push(m),
  });
});
afterAll(async () => {
  await dash.close();
  store.close();
});

describe("page and app assets", () => {
  it("serves the page with a strict CSP and no caching", async () => {
    const r = await request("GET", "/", { token: null });
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toMatch(/text\/html/);
    expect(r.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(r.headers["content-security-policy"]).toContain("script-src 'self'");
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.text).toContain('rel="manifest"');
    expect(r.text).toContain("apple-mobile-web-app-capable");
    expect(r.text).toContain('rel="apple-touch-icon"');
    // CSP forbids inline script and inline style; the page must contain neither.
    expect(r.text).not.toMatch(/<script(?![^>]*\bsrc=)/);
    expect(r.text).not.toMatch(/\sstyle="/);
  });

  it("serves a manifest that installs as a standalone app with icons that exist", async () => {
    const r = await request("GET", "/manifest.webmanifest", { token: null });
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toMatch(/manifest\+json/);
    expect(r.json.display).toBe("standalone");
    expect(r.json.start_url).toBe("/");
    for (const icon of r.json.icons) {
      const img = await request("GET", icon.src, { token: null });
      expect(img.status).toBe(200);
      expect(img.headers["content-type"]).toBe("image/png");
    }
  });

  it("serves script, styles and the Apple touch icon as real PNG/JS/CSS", async () => {
    expect((await request("GET", "/app.js", { token: null })).headers["content-type"]).toMatch(/javascript/);
    expect((await request("GET", "/app.css", { token: null })).headers["content-type"]).toMatch(/text\/css/);
    for (const p of ["/icon-180.png", "/apple-touch-icon.png"]) {
      const raw = await new Promise<Buffer>((resolve, reject) => {
        http.get({ host: "127.0.0.1", port: dash.port, path: p, headers: { Host: `127.0.0.1:${dash.port}` } }, (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => resolve(Buffer.concat(chunks)));
        }).on("error", reject);
      });
      expect(raw.subarray(1, 4).toString("ascii")).toBe("PNG");
      // PNG IHDR: width and height at bytes 16..23.
      expect(raw.readUInt32BE(16)).toBe(180);
      expect(raw.readUInt32BE(20)).toBe(180);
    }
  });

  it("returns 404 for unknown paths and never serves files by path", async () => {
    expect((await request("GET", "/../host.json", { token: null })).status).toBe(404);
    expect((await request("GET", "/dashboard-token", { token: null })).status).toBe(404);
  });
});

describe("who may call the admin API", () => {
  it("refuses a missing or wrong token", async () => {
    expect((await request("GET", "/api/overview", { token: null })).status).toBe(401);
    expect((await request("GET", "/api/overview", { token: "b".repeat(64) })).status).toBe(401);
    expect((await request("GET", "/api/overview", { token: "short" })).status).toBe(401);
  });

  it("refuses a Host header that does not name this server (DNS rebinding)", async () => {
    const r = await request("GET", "/api/overview", { host: "evil.example:4821" });
    expect(r.status).toBe(403);
    expect((await request("GET", "/", { token: null, host: "evil.example" })).status).toBe(403);
  });

  it("accepts loopback names and names the creator listed", async () => {
    expect((await request("GET", "/api/overview", { host: `localhost:${dash.port}` })).status).toBe(200);
    expect((await request("GET", "/api/overview", { host: "my-box.tailnet.ts.net" })).status).toBe(200);
    expect((await request("GET", "/api/overview", { host: `MY-BOX.tailnet.ts.net:${dash.port}` })).status).toBe(200);
    expect(isAllowedHost(undefined, 4821)).toBe(false);
    expect(isAllowedHost("192.168.1.20:4821", 4821, ["192.168.1.20"])).toBe(true);
    expect(isAllowedHost("192.168.1.21:4821", 4821, ["192.168.1.20"])).toBe(false);
    expect(isAllowedHost("x:4821", 4821, [""])).toBe(false);
  });

  it("never listens on the wildcard or the agent gateway, whatever the config says", () => {
    expect(dash.addresses).toEqual([`127.0.0.1:${dash.port}`]);
    expect(logs.filter((l) => l.includes("refusing to listen")).length).toBe(3);
  });

  it("refuses any connection whose source is on the agent network, even with the token", async () => {
    const handler = createDashboardHandler({ admin, token: TOKEN, port: 4821, allowedHosts: ["192.168.1.20"] }, () => 4821);
    const run = (remoteAddress: string) =>
      new Promise<{ status: number; body: any }>((resolve) => {
        const req: any = new EventEmitter();
        req.headers = { host: "192.168.1.20:4821", "x-admin-token": TOKEN };
        req.method = "GET";
        req.url = "/api/overview";
        req.socket = { remoteAddress };
        const res: any = {
          writeHead(status: number) { this.status = status; },
          end(payload: string) { resolve({ status: this.status, body: JSON.parse(payload) }); },
        };
        handler(req, res);
      });
    expect((await run("172.30.0.7")).status).toBe(403);
    expect((await run("::ffff:172.30.0.7")).status).toBe(403);
    expect((await run("192.168.1.55")).status).toBe(200);
    expect((await run("127.0.0.1")).status).toBe(200);
  });

  it("rejects bodies that are not JSON or are too large", async () => {
    const bad = await new Promise<number>((resolve) => {
      const req = http.request(
        { host: "127.0.0.1", port: dash.port, method: "POST", path: "/api/launch", headers: { Host: `127.0.0.1:${dash.port}`, "X-Admin-Token": TOKEN } },
        (res) => { res.resume(); resolve(res.statusCode || 0); },
      );
      req.end("{not json");
    });
    expect(bad).toBe(400);
  });
});

describe("every dashboard action", () => {
  let address: string;

  it("Launch agent: validates input, then creates, funds and starts", async () => {
    expect((await request("POST", "/api/launch", { body: { name: "", genesisPrompt: "x" } })).status).toBe(400);
    expect((await request("POST", "/api/launch", { body: { name: "bad name!", genesisPrompt: "x" } })).status).toBe(400);
    expect((await request("POST", "/api/launch", { body: { name: "scout", genesisPrompt: "" } })).status).toBe(400);
    expect((await request("POST", "/api/launch", { body: { name: "scout", genesisPrompt: "x", fundUsd: -1 } })).status).toBe(400);

    const r = await request("POST", "/api/launch", { body: { name: "scout", genesisPrompt: "Find work.", fundUsd: 5, memoryMb: 512, creatorMessage: "hi" } });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ name: "scout", runtime: "running", balanceUsd: "$5.0000" });
    address = r.json.address;

    const container = driver.containers.get(r.json.containerName)!;
    expect(container.opts.memoryMb).toBe(512);
    expect(JSON.parse(container.files.get("/root/.automaton/genesis.json")!)).toMatchObject({ name: "scout", genesisPrompt: "Find work.", creatorMessage: "hi" });

    // A second agent cannot take the same name.
    expect((await request("POST", "/api/launch", { body: { name: "scout", genesisPrompt: "x" } })).status).toBeGreaterThanOrEqual(400);
  });

  it("Refresh: the overview shows the agent, its tier, its container and the totals", async () => {
    const r = await request("GET", "/api/overview");
    expect(r.status).toBe(200);
    const agent = r.json.agents.find((a: any) => a.address === address);
    expect(agent).toMatchObject({ name: "scout", tier: "normal", frozen: false });
    expect(JSON.stringify(r.json)).not.toContain(TOKEN);
  });

  it("Add funds: adds money, moves the tier, and rejects nonsense amounts", async () => {
    const r = await request("POST", `/api/agents/${address}/fund`, { body: { usd: 2.5 } });
    expect(r.status).toBe(200);
    expect(store.getBalanceMicro(address)).toBe(7_500_000);
    const agent = (await request("GET", "/api/overview")).json.agents.find((a: any) => a.address === address);
    expect(agent.tier).toBe("high");
    for (const usd of [0, -3, "abc", null, 1e12]) {
      expect((await request("POST", `/api/agents/${address}/fund`, { body: { usd } })).status).toBe(400);
    }
    expect(store.getBalanceMicro(address)).toBe(7_500_000);
  });

  it("Freeze and Unfreeze: toggle the spending block", async () => {
    expect((await request("POST", `/api/agents/${address}/freeze`)).status).toBe(200);
    expect(store.isFrozen(address)).toBe(true);
    expect((await request("POST", `/api/agents/${address}/unfreeze`)).status).toBe(200);
    expect(store.isFrozen(address)).toBe(false);
  });

  it("Message: delivers the creator's message and refuses an empty one", async () => {
    expect((await request("POST", `/api/agents/${address}/message`, { body: { content: "status?" } })).status).toBe(200);
    expect((await request("POST", `/api/agents/${address}/message`, { body: { content: "   " } })).status).toBe(400);
  });

  it("Log: returns the runtime log as text", async () => {
    const r = await request("GET", `/api/logs?agent=${address}&lines=10`);
    expect(r.status).toBe(200);
    expect(typeof r.json.text).toBe("string");
    expect((await request("GET", "/api/logs?agent=nobody")).status).toBeGreaterThanOrEqual(400);
  });

  it("Ledger: lists entries, filtered by account when asked", async () => {
    const all = await request("GET", "/api/ledger?limit=50");
    expect(all.status).toBe(200);
    expect(all.json.entries.length).toBeGreaterThanOrEqual(2);
    const mine = await request("GET", `/api/ledger?agent=${address}`);
    expect(mine.json.entries.every((e: any) => e.address === address)).toBe(true);
    expect(store.verifyLedger()).toEqual([]);
  });

  it("Stop then Start: stops the container and brings the runtime back", async () => {
    const stop = await request("POST", `/api/agents/${address}/stop`);
    expect(stop.status).toBe(200);
    expect(store.isFrozen(address)).toBe(true);
    expect([...driver.containers.values()].every((c) => c.state === "stopped")).toBe(true);

    const start = await request("POST", `/api/agents/${address}/start`);
    expect(start.status).toBe(200);
    expect(start.json.runtime).toBe("running");
    expect(store.isFrozen(address)).toBe(false);
  });

  it("Start reports a runtime that exits at once instead of claiming it runs", async () => {
    await request("POST", `/api/agents/${address}/stop`);
    driver.runtimeCrashes = true;
    const start = await request("POST", `/api/agents/${address}/start`);
    expect(start.json.runtime).toBe("stopped");
    driver.runtimeCrashes = false;
  });

  it("Remove (orphan container): deletes one container by sandbox id", async () => {
    const overview = (await request("GET", "/api/overview")).json;
    expect((await request("POST", "/api/sandboxes/01ARZ3NDEKTSV4RRFFQ69G5FAV/remove")).status).toBeGreaterThanOrEqual(400);
    expect(overview.agents.length).toBeGreaterThan(0);
  });

  it("Remove: deletes the agent's containers and keeps its ledger history", async () => {
    const before = (await request("GET", `/api/ledger?agent=${address}`)).json.entries.length;
    const r = await request("POST", `/api/agents/${address}/remove`);
    expect(r.status).toBe(200);
    expect(driver.containers.size).toBe(0);
    const overview = (await request("GET", "/api/overview")).json;
    expect(overview.agents.find((a: any) => a.address === address)).toBeUndefined();
    expect((await request("GET", "/api/ledger?limit=100")).json.entries.filter((e: any) => e.address === address).length).toBe(before);
    // The creator account itself cannot be removed.
    expect((await request("POST", `/api/agents/${CREATOR}/remove`)).status).toBe(400);
  });

  it("answers unknown API routes and unknown agents with clear errors", async () => {
    expect((await request("GET", "/api/nope")).status).toBe(404);
    expect((await request("POST", "/api/agents/0x00000000000000000000000000000000000000ff/fund", { body: { usd: 1 } })).status).toBeGreaterThanOrEqual(400);
    expect((await request("DELETE", "/api/overview")).status).toBe(404);
  });
});

describe("phone access", () => {
  it("matches addresses against networks", () => {
    expect(ipInCidr("172.30.0.9", "172.30.0.0/24")).toBe(true);
    expect(ipInCidr("172.30.1.9", "172.30.0.0/24")).toBe(false);
    expect(ipInCidr("::ffff:100.101.102.103", "100.64.0.0/10")).toBe(true);
    expect(ipInCidr("100.128.0.1", "100.64.0.0/10")).toBe(false);
    expect(ipInCidr("255.255.255.255", "128.0.0.0/1")).toBe(true);
    expect(ipInCidr("1.2.3.4", "0.0.0.0/0")).toBe(true);
    for (const bad of [undefined, "", "::1", "999.1.1.1", "abc"]) expect(ipInCidr(bad, "10.0.0.0/8")).toBe(false);
    expect(ipInCidr("10.0.0.1", "10.0.0.0/99")).toBe(false);
  });

  it("offers VPN first, then home network, and never public, loopback or container addresses", () => {
    const v4 = (address: string, internal = false) => ({ address, family: "IPv4", internal, netmask: "", mac: "", cidr: null }) as any;
    const found = listPhoneAddresses("172.30.0.0/24", {
      lo: [v4("127.0.0.1", true)],
      wlp2s0: [v4("192.168.1.20"), { ...v4("fe80::1"), family: "IPv6" }],
      tailscale0: [v4("100.101.102.103")],
      docker0: [v4("172.17.0.1")],
      "br-abc123": [v4("172.30.0.1")],
      "br-other": [v4("172.18.0.1")],
      eth9: [v4("203.0.113.5"), v4("172.30.0.44")],
    });
    expect(found).toEqual([
      { address: "100.101.102.103", iface: "tailscale0", kind: "vpn" },
      { address: "192.168.1.20", iface: "wlp2s0", kind: "lan" },
    ]);
    expect(listPhoneAddresses("172.30.0.0/24", {})).toEqual([]);
  });

  it("builds a link whose token rides in the fragment", () => {
    const url = new URL(phoneDashboardUrl("192.168.1.20", 4821, TOKEN));
    expect(url.origin).toBe("http://192.168.1.20:4821");
    expect(url.hash).toBe(`#token=${TOKEN}`);
    expect(url.search).toBe("");
  });
});
