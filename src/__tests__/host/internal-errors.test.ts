import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createConwayClient } from "../../conway/client.js";
import { clearTrustedInsecureOrigins, trustInsecureOrigin } from "../../conway/endpoint.js";
import { MICRO_PER_USD } from "../../host/store.js";
import { call, signIn, startTestHost, type TestHost } from "./helpers.js";

let host: TestHost;
let apiKey: string;
let sandboxId: string;

beforeAll(async () => {
  host = await startTestHost({ selection: { spawnProfitUsd: 0, deathGraceMinutes: 60 } });
  trustInsecureOrigin(host.url);
  const a = await signIn(host.url);
  apiKey = a.apiKey;
  host.store.topup(a.address, 10 * MICRO_PER_USD);
  const client = createConwayClient({ apiUrl: host.url, apiKey, sandboxId: "" });
  sandboxId = (await client.createSandbox({ name: "box", vcpu: 1, memoryMb: 512, diskGb: 5 })).id;
});
afterAll(async () => {
  await host.close();
  clearTrustedInsecureOrigins();
});

describe("internal errors on the agent API", () => {
  it("keeps the host's own error text out of the reply and in the host log, tied by a reference", async () => {
    const secret = "docker daemon unreachable at /home/operator/.docker/run/docker.sock";
    const real = host.driver.exec.bind(host.driver);
    host.driver.exec = async () => {
      throw new Error(secret);
    };
    try {
      const r = await call(host.url, "POST", `/v1/sandboxes/${sandboxId}/exec`, apiKey, { command: "echo hi" });
      expect(r.status).toBe(500);
      expect(r.json.code).toBe("internal");
      expect(r.text).not.toContain("operator");
      expect(r.text).not.toContain("docker");
      expect(r.json.ref).toMatch(/^[0-9a-f]{8}$/);
      expect(r.json.error).toContain(r.json.ref);
      const logged = host.logs.find((l) => l.includes(r.json.ref));
      expect(logged).toContain(secret);
    } finally {
      host.driver.exec = real;
    }
  });

  it("still tells an agent why a write inside its own container failed", async () => {
    const real = host.driver.writeFile.bind(host.driver);
    host.driver.writeFile = async () => {
      throw new Error("write /proc/x failed (exit 1): Permission denied");
    };
    try {
      const r = await call(host.url, "POST", `/v1/sandboxes/${sandboxId}/files/upload/json`, apiKey, { path: "/proc/x", content: "y" });
      expect(r.status).toBe(500);
      expect(r.json.error).toContain("Permission denied");
    } finally {
      host.driver.writeFile = real;
    }
  });
});
