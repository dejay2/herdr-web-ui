import { describe, expect, it } from "bun:test";
import type { TailscalePeers } from "../shared/machines.ts";
import { handleMachineRequest } from "./machine-api.ts";
import type { MachineManager } from "./machines.ts";

// The route never touches the manager, so a manager that throws on any use proves it is not read as a machine id.
const manager = new Proxy({}, { get: (_, key) => { throw new Error(`manager.${String(key)} must not be used`); } }) as unknown as MachineManager;
const get = (readPeers: () => Promise<TailscalePeers>, init: RequestInit = {}) =>
  handleMachineRequest(new Request("http://localhost:7317/api/machines/tailscale", init), manager, undefined, readPeers);

describe("GET /api/machines/tailscale", () => {
  it("answers the injected reader, not a machine lookup", async () => {
    const answer: TailscalePeers = { state: "running", peers: [{ name: "box", dns_name: "box.example.ts.net", address: "box.example.ts.net", os: "linux", online: true, tags: [] }] };
    const response = await get(async () => answer);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(answer);
  });

  it("answers a failed read as an error body, never an empty list", async () => {
    const response = await get(async () => { throw new Error("boom"); });
    expect(response.status).toBe(502);
    const body = await response.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe("tailscale_unavailable");
    expect(typeof body.error.message).toBe("string");
  });

  it("refuses other methods and a foreign origin", async () => {
    expect((await get(async () => ({ state: "missing", peers: [] }), { method: "POST", headers: { "x-herdr-machine": "1" } })).status).toBe(405);
    expect((await get(async () => ({ state: "missing", peers: [] }), { headers: { origin: "http://evil.example" } })).status).toBe(403);
  });
});
