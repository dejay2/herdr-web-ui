import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CONDUCTOR_HEADER, type ConductorEvents, type ConductorOverview, type ConductorPane, type ConductorSuggestion } from "../shared/conductor.ts";
import type { MachineEvent } from "../shared/machines.ts";
import { herdrRpc, paneSendText, workspaceClose, workspaceCreate } from "./herdr/client.ts";
import { DeviceStore } from "./devices.ts";
import { createServer } from "./index.ts";

/**
 * The conductor's HTTP surface against the REAL herdr of the test session and a real server: the
 * routes, the gate, the cards file and the machine stream. Its pane reads go the way production
 * goes (the server's own routes by its bridge token). The workspace is made and closed here; the
 * server keeps its state in a temp dir.
 */
const stateDir = mkdtempSync(join(tmpdir(), "herdr-web-ui-conductor-"));
let server: { port: number; stop: () => void };
let gated: { port: number; stop: () => void };
let gatedDir = "";
let workspaceId: string;
let paneId: string;
const base = () => `http://127.0.0.1:${server.port}`;
const post = (path: string, body: unknown, headers: Record<string, string> = { [CONDUCTOR_HEADER]: "1" }, root = base()) =>
  fetch(`${root}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const get = (path: string, init: RequestInit = {}) => fetch(`${base()}${path}`, init);
const errorCode = async (response: Response) => ((await response.json()) as { error: { code: string } }).error.code;

async function until<T>(read: () => Promise<T | null | false>, label: string, ms = 8000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await Bun.sleep(50);
  }
}

beforeAll(async () => {
  const created = await workspaceCreate({ cwd: tmpdir(), label: "herdr-web-ui-test-conductor" });
  workspaceId = created.workspace.workspace_id;
  paneId = created.root_pane.pane_id;
  server = createServer({ port: 0, stateDir, alertTiming: { short: 0, long: 0, longTurn: 0 }, pushLoopbackHttp: true });
  // the local roster loads a moment after the server starts
  await until(async () => ((await (await get("/api/conductor/overview")).json()) as ConductorOverview).machines[0]?.panes.some((pane) => pane.pane_id === paneId), "the pane in the roster");
});

afterAll(async () => {
  gated?.stop();
  server?.stop();
  await workspaceClose(workspaceId).catch(() => undefined);
  rmSync(stateDir, { recursive: true, force: true });
  if (gatedDir) rmSync(gatedDir, { recursive: true, force: true });
});

describe("conductor routes", () => {
  it("lists every PC's panes in the overview", async () => {
    const overview = (await (await get("/api/conductor/overview")).json()) as ConductorOverview;
    expect(typeof overview.seq).toBe("number");
    const local = overview.machines.find((machine) => machine.machine_id === "local")!;
    expect(local.state).toBe("connected");
    const entry = local.panes.find((pane) => pane.pane_id === paneId)!;
    expect(Object.keys(entry).sort()).toEqual(["agent", "agent_status", "cwd", "label", "pane_id"]);
  });

  it("reads a pane with no transcript as a short screen, through the server's own routes", async () => {
    const detail = (await (await get(`/api/conductor/pane?machine_id=local&pane_id=${encodeURIComponent(paneId)}`)).json()) as ConductorPane;
    expect(detail).toMatchObject({ machine_id: "local", pane_id: paneId, prompt: null, turns: [] });
    expect(typeof detail.screen).toBe("string");
    const unknown = await get(`/api/conductor/pane?machine_id=local&pane_id=nope-nope`);
    expect([unknown.status, await errorCode(unknown)]).toEqual([404, "pane_not_found"]);
  });

  it("answers a status change that happened, and nothing at the deadline", async () => {
    const before = ((await (await get("/api/conductor/overview")).json()) as ConductorOverview).seq;
    const empty = (await (await get(`/api/conductor/events?since=${before}&timeout=0.1`)).json()) as ConductorEvents;
    expect(empty.events).toEqual([]);
    // a status herdr is told of reaches the buffer through the collector and the machine stream: the
    // long poll that was already waiting is answered by it
    const waiting = get(`/api/conductor/events?since=${before}&timeout=8`);
    await herdrRpc("pane.report_agent", { pane_id: paneId, source: "manual", agent: "claude", state: "blocked" });
    const answered = (await (await waiting).json()) as ConductorEvents;
    expect(answered.events.some((event) => event.machine_id === "local" && event.pane_id === paneId && event.agent_status === "blocked")).toBe(true);
    expect(answered.seq).toBeGreaterThan(before);
    await herdrRpc("pane.report_agent", { pane_id: paneId, source: "manual", agent: "claude", state: "idle" });
    // a counter from before a restart is told so
    expect((await (await get("/api/conductor/events?since=99999999&timeout=0")).json())).toMatchObject({ reset: true });
    expect((await get("/api/conductor/events?since=abc")).status).toBe(400);
  });
});

describe("conductor suggestions", () => {
  it("creates, dedupes, approves and persists a message card, and announces it on the machine stream", async () => {
    // the earlier test left the pane reporting an agent: wait until the roster says it is at rest
    await until(async () => { const status = ((await (await get("/api/conductor/overview")).json()) as ConductorOverview).machines[0]?.panes.find((pane) => pane.pane_id === paneId)?.agent_status; return status !== undefined && status !== "working" && status !== "blocked"; }, "the pane at rest");
    const events: MachineEvent[] = [];
    const stream = new AbortController();
    const response = await get("/api/machines/events", { signal: stream.signal });
    const reader = response.body!.getReader();
    void (async () => {
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          buffer += decoder.decode(value, { stream: true });
          for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
            const frame = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            if (frame.startsWith("data: ")) events.push(JSON.parse(frame.slice(6)) as MachineEvent);
          }
        }
      } catch { /* aborted below */ }
    })();
    try {
      const body = { machine_id: "local", pane_id: paneId, kind: "message", summary: "Run the tests", text: "Please run the tests." };
      const created = await post("/api/conductor/suggestions", body);
      expect(created.status).toBe(201);
      const first = (await created.json()) as ConductorSuggestion;
      expect(first).toMatchObject({ status: "open", kind: "message", machine_id: "local", pane_id: paneId });
      const replaced = (await (await post("/api/conductor/suggestions", { ...body, text: "Run the linter." })).json()) as ConductorSuggestion;
      expect(replaced.id).not.toBe(first.id);
      const open = ((await (await get("/api/conductor/suggestions?status=open")).json()) as { suggestions: ConductorSuggestion[] }).suggestions;
      expect(open.map((card) => card.text)).toEqual(["Run the linter."]);
      await until(async () => events.some((event) => event.type === "conductor" && event.open === 1), "the conductor event");
      const file = join(stateDir, "conductor-suggestions.json");
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect((JSON.parse(readFileSync(file, "utf8")) as ConductorSuggestion[]).filter((card) => card.status === "open")).toHaveLength(1);
      const approved = await post(`/api/conductor/suggestions/${replaced.id}/approve`, {});
      expect(((await approved.json()) as ConductorSuggestion).status).toBe("approved");
      expect(await errorCode(await post(`/api/conductor/suggestions/${replaced.id}/dismiss`, {}))).toBe("suggestion_closed");
      await until(async () => events.some((event) => event.type === "conductor" && event.open === 0), "the closing event");
    } finally {
      stream.abort();
    }
  });

  it("refuses what is not a well-formed suggestion for a pane that exists", async () => {
    const message = { machine_id: "local", pane_id: paneId, kind: "message", summary: "s", text: "t" };
    expect(await errorCode(await post("/api/conductor/suggestions", message, {}))).toBe("invalid_conductor_request");
    expect((await post("/api/conductor/suggestions", message, { [CONDUCTOR_HEADER]: "1", origin: "https://evil.example" })).status).toBe(403);
    expect(await errorCode(await post("/api/conductor/suggestions", { ...message, machine_id: "no-such-pc" }))).toBe("unknown_machine");
    expect(await errorCode(await post("/api/conductor/suggestions", { ...message, pane_id: "gone" }))).toBe("pane_not_found");
    expect(await errorCode(await post("/api/conductor/suggestions", { ...message, summary: "x".repeat(501) }))).toBe("invalid_suggestion");
    expect(await errorCode(await post("/api/conductor/suggestions", { ...message, kind: "keys" }))).toBe("invalid_suggestion");
    // the pane shows no prompt: an answer has nothing to answer
    expect(await errorCode(await post("/api/conductor/suggestions", { machine_id: "local", pane_id: paneId, kind: "answer", summary: "s", prompt_id: "x", answer: { option_index: 0 } }))).toBe("no_prompt");
    expect((await get("/api/conductor/unknown")).status).toBe(404);
  });

  it("takes nothing for a pane that asks for a password", async () => {
    await paneSendText(paneId, "printf '[sudo] password for jay:\\n'; sleep 20\n");
    await until(async () => {
      const detail = (await (await get(`/api/conductor/pane?machine_id=local&pane_id=${encodeURIComponent(paneId)}`)).json()) as ConductorPane;
      return detail.screen?.includes("password for jay") === true;
    }, "the password line on the screen");
    const refused = await post("/api/conductor/suggestions", { machine_id: "local", pane_id: paneId, kind: "message", summary: "s", text: "hunter2" });
    expect([refused.status, await errorCode(refused)]).toEqual([422, "secret_prompt"]);
    // free the pane again for whatever runs after
    await paneSendText(paneId, "\u0003");
  });
});

describe("conductor and the token gate", () => {
  it("needs the token like every route, and still reads local panes for the conductor", async () => {
    gatedDir = mkdtempSync(join(tmpdir(), "herdr-web-ui-conductor-gated-"));
    gated = createServer({ port: 0, stateDir: gatedDir, token: "conductor-token" });
    const root = `http://127.0.0.1:${gated.port}`;
    expect((await fetch(`${root}/api/conductor/overview`)).status).toBe(401);
    expect((await fetch(`${root}/api/conductor/overview`, { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    const bearer = { authorization: "Bearer conductor-token" };
    await until(async () => ((await (await fetch(`${root}/api/conductor/overview`, { headers: bearer })).json()) as ConductorOverview).machines[0]?.panes.some((pane) => pane.pane_id === paneId), "the roster behind the token");
    // a post without the token is refused before anything is read
    expect((await post("/api/conductor/suggestions", { machine_id: "local", pane_id: paneId, kind: "message", summary: "s", text: "t" }, { [CONDUCTOR_HEADER]: "1" }, root)).status).toBe(401);
    const detail = await fetch(`${root}/api/conductor/pane?machine_id=local&pane_id=${encodeURIComponent(paneId)}`, { headers: bearer });
    expect(detail.status).toBe(200);
    const created = await post("/api/conductor/suggestions", { machine_id: "local", pane_id: paneId, kind: "message", summary: "s", text: "t" }, { ...bearer, [CONDUCTOR_HEADER]: "1" }, root);
    expect(created.status).toBe(201);
    expect(existsSync(join(gatedDir, "conductor-suggestions.json"))).toBe(true);
  });
});

describe("conductor and paired devices", () => {
  it("lets a watch device read the cards and refuses its every change, and refuses a revoked device", async () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-web-ui-conductor-devices-"));
    const store = new DeviceStore(root);
    const watch = store.pair(store.startPairing().code, "Watch", "watch")!;
    const revoked = store.pair(store.startPairing().code, "Gone", "watch")!;
    const app = createServer({ port: 0, stateDir: root, token: "conductor-devices", tailscaleOwner: null });
    const origin = `http://127.0.0.1:${app.port}`;
    const admin = { authorization: "Bearer conductor-devices" };
    const watcher = { cookie: `herdr_web_device=${watch.token}` };
    const body = { machine_id: "local", pane_id: paneId, kind: "message", summary: "s", text: "t" };
    try {
      await until(async () => ((await (await fetch(`${origin}/api/conductor/overview`, { headers: admin })).json()) as ConductorOverview).machines[0]?.panes.some((pane) => pane.pane_id === paneId), "the roster");
      const created = (await (await post("/api/conductor/suggestions", body, { ...admin, [CONDUCTOR_HEADER]: "1" }, origin)).json()) as ConductorSuggestion;
      const file = join(root, "conductor-suggestions.json");
      const before = readFileSync(file, "utf8");

      const list = await fetch(`${origin}/api/conductor/suggestions`, { headers: watcher });
      expect(list.status).toBe(200);
      expect(((await list.json()) as { suggestions: ConductorSuggestion[] }).suggestions.map((card) => card.id)).toEqual([created.id]);
      expect((await fetch(`${origin}/api/conductor/overview`, { headers: watcher })).status).toBe(200);

      const header = { ...watcher, [CONDUCTOR_HEADER]: "1" };
      for (const [path, payload] of [
        ["/api/conductor/suggestions", body],
        [`/api/conductor/suggestions/${created.id}/approve`, {}],
        [`/api/conductor/suggestions/${created.id}/dismiss`, {}],
        [`/api/conductor/suggestions/${created.id}/stale`, { reason: "pane_ended" }],
      ] as const) {
        const response = await post(path, payload, header, origin);
        expect([path, response.status, await errorCode(response)]).toEqual([path, 403, "read_only"]);
      }
      expect(readFileSync(file, "utf8")).toBe(before);
      expect(((JSON.parse(before) as ConductorSuggestion[])[0])!.status).toBe("open");

      // a revoked device is refused everywhere
      const id = (await (await fetch(`${origin}/api/devices`, { headers: admin })).json() as { devices: { id: string; label: string }[] }).devices.find((device) => device.label === "Gone")!.id;
      expect((await fetch(`${origin}/api/devices/${id}`, { method: "DELETE", headers: { ...admin, "x-herdr-machine": "1" } })).status).toBe(204);
      const gone = { cookie: `herdr_web_device=${revoked.token}` };
      expect((await fetch(`${origin}/api/conductor/suggestions`, { headers: gone })).status).toBe(401);
      expect((await post("/api/conductor/suggestions", body, { ...gone, [CONDUCTOR_HEADER]: "1" }, origin)).status).toBe(401);
      expect(readFileSync(file, "utf8")).toBe(before);
    } finally {
      app.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
