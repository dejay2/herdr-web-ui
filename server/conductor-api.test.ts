import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CONDUCTOR_HEADER, type ConductorPane, type ConductorSuggestion } from "../shared/conductor.ts";
import type { Machine } from "../shared/machines.ts";
import type { HerdrPane, InteractivePrompt } from "../shared/protocol.ts";
import { ConductorError, ConductorEvents, ConductorStore } from "./conductor.ts";
import { checkAnswer, handleConductorRequest, paneColumns, reduceTurns, showsSecretPrompt, type ConductorDeps } from "./conductor-api.ts";

const pane = (id: string, over: Partial<HerdrPane> = {}): HerdrPane => ({ pane_id: id, agent: "claude", agent_status: "blocked", cwd: "/work/app", label: null, title: "Fix the build", focused: false, revision: 1, tab_id: "t1", terminal_id: "term", workspace_id: "w1", ...over }) as HerdrPane;
const machine = (id: string, name: string, panes: HerdrPane[], state: Machine["state"] = "connected"): Machine => ({ id, name, kind: id === "local" ? "local" : "ssh", enabled: true, state, error: null, snapshot: { panes } as Machine["snapshot"] });
const prompt = (over: Partial<InteractivePrompt> = {}): InteractivePrompt => ({ id: "prompt-1", agent: "claude", kind: "approval", title: "Allow?", question: "Allow git push?", body: "git push", options: [{ label: "Yes", description: null }, { label: "No", description: "stop here" }], multi_select: false, custom_option_index: null, ...over });

const origin = "http://127.0.0.1:7317";
let dir: string;
let calls: Array<{ machineId: string; path: string; params: Record<string, string> }>;
let screens: Record<string, string>;
let prompts: Record<string, InteractivePrompt | null>;
let conversations: Record<string, unknown>;
let deps: ConductorDeps;
let roster: Machine[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "herdr-conductor-api-"));
  calls = [];
  screens = {};
  prompts = {};
  conversations = {};
  roster = [machine("local", "workstation", [pane("p_1"), pane("p_2", { agent: null, agent_status: "unknown", label: "Shell" })]), machine("pc-2", "laptop", [pane("p_1", { agent: "codex", agent_status: "idle" })], "reconnecting")];
  deps = {
    store: new ConductorStore({ stateDir: dir }),
    events: new ConductorEvents(),
    machines: { list: () => roster },
    readPane: async (machineId, path, params) => {
      calls.push({ machineId, path, params });
      const key = `${machineId}/${params["pane_id"]}`;
      if (path === "pane/read") return { read: { text: params["source"] === "detection" ? screens[key] ?? "$ " : screens[key] ?? "recent output" } };
      if (path === "pane/prompt") return { prompt: prompts[key] ?? null, suggestion: null };
      if (path === "pane/conversation") {
        if (conversations[key] instanceof Error) throw conversations[key];
        return conversations[key] ?? { source: "scrollback", turns: [] };
      }
      throw new Error(`unexpected ${path}`);
    },
  };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> => {
  const request = new Request(`${origin}${path}`, { method, headers: { ...(method === "POST" ? { [CONDUCTOR_HEADER]: "1", "content-type": "application/json" } : {}), ...headers }, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) });
  return handleConductorRequest(request, new URL(request.url), deps);
};
const json = async <T = any>(response: Response): Promise<T> => response.json() as Promise<T>;
const errorOf = async (response: Response) => (await json<{ error: { code: string; message: string } }>(response)).error;

describe("overview", () => {
  it("lists every PC's panes compactly, with the newest event number", async () => {
    deps.events.record("local", "p_1", "blocked");
    const body = await json(await call("GET", "/api/conductor/overview"));
    expect(body.seq).toBe(1);
    expect(body.machines).toEqual([
      { machine_id: "local", name: "workstation", state: "connected", panes: [
        { pane_id: "p_1", agent: "claude", agent_status: "blocked", cwd: "/work/app", label: "Fix the build" },
        { pane_id: "p_2", agent: null, agent_status: "unknown", cwd: "/work/app", label: "Shell" },
      ] },
      { machine_id: "pc-2", name: "laptop", state: "reconnecting", panes: [{ pane_id: "p_1", agent: "codex", agent_status: "idle", cwd: "/work/app", label: "Fix the build" }] },
    ]);
  });

  it("can leave out the shells", async () => {
    const body = await json(await call("GET", "/api/conductor/overview?agents_only=1"));
    expect(body.machines[0].panes.map((entry: { pane_id: string }) => entry.pane_id)).toEqual(["p_1"]);
  });
});

describe("pane", () => {
  it("answers the prompt and the last three text turns, dropping thinking, tools and empty turns", async () => {
    prompts["local/p_1"] = prompt();
    conversations["local/p_1"] = { source: "claude-transcript", turns: [
      { role: "user", parts: [{ kind: "text", text: "first" }] },
      { role: "assistant", parts: [{ kind: "thinking", text: "secret reasoning" }, { kind: "text", text: "second" }] },
      { role: "user", parts: [{ kind: "text", text: "third" }] },
      { role: "assistant", parts: [{ kind: "tool", name: "Bash", summary: "ls", input: "ls", output: "files" }] },
      { role: "assistant", parts: [{ kind: "text", text: "fourth" }, { kind: "tool", name: "Bash", summary: "x", input: "x", output: "SECRET OUTPUT" }] },
    ] };
    const body = await json<ConductorPane>(await call("GET", "/api/conductor/pane?machine_id=local&pane_id=p_1"));
    expect(body.turns).toEqual([{ role: "assistant", text: "second" }, { role: "user", text: "third" }, { role: "assistant", text: "fourth" }]);
    expect(body.screen).toBeNull();
    expect(body.prompt).toEqual({ id: "prompt-1", kind: "approval", title: "Allow?", question: "Allow git push?", body: "git push", options: [{ label: "Yes", description: null }, { label: "No", description: "stop here" }], multi_select: false, custom_option_index: null });
    expect(JSON.stringify(body)).not.toContain("secret reasoning");
    expect(JSON.stringify(body)).not.toContain("SECRET OUTPUT");
    expect(body).toMatchObject({ machine_id: "local", pane_id: "p_1", agent: "claude", agent_status: "blocked", cwd: "/work/app" });
  });

  it("reads the right PC: the same pane id on another PC is another pane", async () => {
    prompts["pc-2/p_1"] = prompt({ id: "other" });
    const body = await json<ConductorPane>(await call("GET", "/api/conductor/pane?machine_id=pc-2&pane_id=p_1"));
    expect(body.prompt?.id).toBe("other");
    expect(body.agent).toBe("codex");
    expect(calls.every((entry) => entry.machineId === "pc-2")).toBe(true);
  });

  it("keeps each turn short, newest words kept", () => {
    const turns = reduceTurns([{ role: "assistant", parts: [{ kind: "text", text: `${"a".repeat(3000)}END` }] }]);
    expect(turns[0]!.text.length).toBeLessThanOrEqual(1500);
    expect(turns[0]!.text.startsWith("…")).toBe(true);
    expect(turns[0]!.text.endsWith("END")).toBe(true);
    expect(reduceTurns("nope")).toEqual([]);
    expect(reduceTurns([null, { role: "system", parts: [] }, { role: "user", parts: "x" }])).toEqual([]);
  });

  it("falls back to a short screen read for a pane with no transcript, and asks for few lines", async () => {
    screens["local/p_2"] = "last line\n\n";
    const body = await json<ConductorPane>(await call("GET", "/api/conductor/pane?machine_id=local&pane_id=p_2"));
    expect(body.screen).toBe("last line");
    expect(body.turns).toEqual([]);
    const read = calls.find((entry) => entry.path === "pane/read")!;
    expect(read.params).toEqual({ pane_id: "p_2", source: "recent", format: "text", lines: "40" });
  });

  it("falls back to the screen when the transcript cannot be read, but a failed screen is an error", async () => {
    conversations["local/p_1"] = new ConductorError("pane_read_failed", "no transcript store", 502);
    expect((await json<ConductorPane>(await call("GET", "/api/conductor/pane?machine_id=local&pane_id=p_1"))).screen).toBe("recent output");
    deps.readPane = async (_machine, path) => { if (path === "pane/prompt") return { prompt: null }; throw new ConductorError("machine_offline", "This PC is disconnected", 503); };
    const response = await call("GET", "/api/conductor/pane?machine_id=local&pane_id=p_1");
    expect(response.status).toBe(503);
    expect((await errorOf(response)).code).toBe("machine_offline");
  });

  it("does not turn a failed prompt read into 'no prompt'", async () => {
    deps.readPane = async () => { throw new ConductorError("machine_unavailable", "The PC did not answer", 502); };
    const response = await call("GET", "/api/conductor/pane?machine_id=local&pane_id=p_1");
    expect(response.status).toBe(502);
  });

  it("names what is missing or unknown", async () => {
    expect((await errorOf(await call("GET", "/api/conductor/pane?pane_id=p_1"))).code).toBe("missing_machine_id");
    expect((await errorOf(await call("GET", "/api/conductor/pane?machine_id=local"))).code).toBe("missing_pane_id");
    const unknownMachine = await call("GET", "/api/conductor/pane?machine_id=zz&pane_id=p_1");
    expect([unknownMachine.status, (await errorOf(unknownMachine)).code]).toEqual([404, "unknown_machine"]);
    const unknownPane = await call("GET", "/api/conductor/pane?machine_id=local&pane_id=nope");
    expect([unknownPane.status, (await errorOf(unknownPane)).code]).toEqual([404, "pane_not_found"]);
  });
});

describe("events", () => {
  it("answers what is buffered at once", async () => {
    deps.events.record("local", "p_1", "blocked");
    expect(await json<unknown>(await call("GET", "/api/conductor/events?since=0"))).toEqual({ seq: 1, events: [{ seq: 1, machine_id: "local", pane_id: "p_1", agent_status: "blocked" }] });
  });

  it("waits for the next one, up to the timeout, and caps the timeout at 30 s", async () => {
    const started = Date.now();
    expect(await json<unknown>(await call("GET", "/api/conductor/events?since=0&timeout=0.05"))).toEqual({ seq: 0, events: [] });
    expect(Date.now() - started).toBeGreaterThanOrEqual(40);
    const waiting = call("GET", "/api/conductor/events?since=0&timeout=500");
    deps.events.record("pc-2", "p_9", "done");
    expect((await json(await waiting)).events[0].agent_status).toBe("done");
  });

  it("refuses a since or timeout that is not a number", async () => {
    for (const query of ["since=-1", "since=x", "since=1.5", "timeout=-2", "timeout=soon"]) {
      expect((await call("GET", `/api/conductor/events?${query}`)).status).toBe(400);
    }
  });
});

describe("suggestions", () => {
  const messageBody = { machine_id: "local", pane_id: "p_2", kind: "message", summary: "Run the tests", text: "Please run the tests." };
  const answerBody = { machine_id: "local", pane_id: "p_1", kind: "answer", summary: "Allow the push", prompt_id: "prompt-1", answer: { option_index: 0 } };

  it("creates a message card on an existing pane", async () => {
    const response = await call("POST", "/api/conductor/suggestions", messageBody);
    expect(response.status).toBe(201);
    expect(await json<ConductorSuggestion>(response)).toMatchObject({ kind: "message", status: "open", text: "Please run the tests." });
    expect((await json(await call("GET", "/api/conductor/suggestions?status=open"))).suggestions).toHaveLength(1);
  });

  it("creates an answer card that names the option in the prompt's words", async () => {
    prompts["local/p_1"] = prompt();
    const card = await json<ConductorSuggestion>(await call("POST", "/api/conductor/suggestions", answerBody));
    expect(card).toMatchObject({ kind: "answer", prompt_id: "prompt-1", answer: { option_index: 0 }, answer_label: "Yes" });
  });

  it("refuses a different prompt, no prompt, and an answer the prompt cannot take", async () => {
    const none = await call("POST", "/api/conductor/suggestions", answerBody);
    expect([none.status, (await errorOf(none)).code]).toEqual([409, "no_prompt"]);
    prompts["local/p_1"] = prompt({ id: "newer" });
    const changed = await call("POST", "/api/conductor/suggestions", answerBody);
    expect([changed.status, (await errorOf(changed)).code]).toEqual([409, "prompt_changed"]);
    prompts["local/p_1"] = prompt();
    for (const answer of [{ option_index: 5 }, { option_indices: [0] }, { custom_text: "do it" }]) {
      const refused = await call("POST", "/api/conductor/suggestions", { ...answerBody, answer });
      expect([refused.status, (await errorOf(refused)).code]).toEqual([400, "invalid_answer"]);
    }
    expect(deps.store.list()).toEqual([]);
  });

  it("checks an answer against the prompt's shape", () => {
    const multi = prompt({ multi_select: true });
    expect(checkAnswer(multi, { option_indices: [0, 1] })).toBe("Yes, No");
    expect(() => checkAnswer(multi, { option_index: 0 })).toThrow(ConductorError);
    expect(() => checkAnswer(multi, { custom_text: "x" })).toThrow(ConductorError);
    expect(checkAnswer(prompt({ custom_option_index: 2 }), { custom_text: "use staging" })).toBe("use staging");
  });

  it("never takes a card for a pane that asks for a password", async () => {
    prompts["local/p_1"] = prompt();
    for (const asked of ["[sudo] password for jay:", "Enter passphrase for key '/home/jay/.ssh/id_ed25519':"]) {
      screens["local/p_1"] = screens["local/p_2"] = `$ sudo ls\n${asked}`;
      for (const body of [messageBody, answerBody, { ...answerBody, answer: { custom_text: "hunter2" } }]) {
        const response = await call("POST", "/api/conductor/suggestions", body);
        expect([response.status, (await errorOf(response)).code]).toEqual([422, "secret_prompt"]);
      }
    }
    expect(deps.store.list()).toEqual([]);
  });

  it("refuses a card for a pane or PC it does not know, and a failed look at the screen is not a pass", async () => {
    expect((await call("POST", "/api/conductor/suggestions", { ...messageBody, machine_id: "zz" })).status).toBe(404);
    const missing = await call("POST", "/api/conductor/suggestions", { ...messageBody, pane_id: "nope" });
    expect([missing.status, (await errorOf(missing)).code]).toEqual([404, "pane_not_found"]);
    deps.readPane = async () => { throw new ConductorError("machine_unavailable", "The PC did not answer", 502); };
    expect((await call("POST", "/api/conductor/suggestions", messageBody)).status).toBe(502);
    expect(deps.store.list()).toEqual([]);
  });

  it("refuses a mutation without the conductor header, from another site, and a body that is not JSON", async () => {
    const bare = new Request(`${origin}/api/conductor/suggestions`, { method: "POST", body: JSON.stringify(messageBody) });
    const noHeader = await handleConductorRequest(bare, new URL(bare.url), deps);
    expect([noHeader.status, (await errorOf(noHeader)).code]).toEqual([403, "invalid_conductor_request"]);
    expect((await call("POST", "/api/conductor/suggestions", messageBody, { origin: "https://evil.example" })).status).toBe(403);
    expect((await call("POST", "/api/conductor/suggestions", messageBody, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    const notJson = await call("POST", "/api/conductor/suggestions", "{ nope");
    expect([notJson.status, (await errorOf(notJson)).code]).toEqual([400, "invalid_json"]);
    const huge = await call("POST", "/api/conductor/suggestions", JSON.stringify({ ...messageBody, text: "x".repeat(70_000) }));
    expect(huge.status).toBe(413);
    expect(deps.store.list()).toEqual([]);
  });

  it("approves and dismisses once, and approving sends nothing to any pane", async () => {
    const created = await json<ConductorSuggestion>(await call("POST", "/api/conductor/suggestions", messageBody));
    const readsBefore = calls.length;
    const approved = await json<ConductorSuggestion>(await call("POST", `/api/conductor/suggestions/${created.id}/approve`, {}));
    expect(approved.status).toBe("approved");
    // the only pane access a conductor route has is reading; approve touches no pane at all
    expect(calls).toHaveLength(readsBefore);
    expect(calls.every((entry) => entry.path.startsWith("pane/") && ["pane/read", "pane/prompt", "pane/conversation"].includes(entry.path))).toBe(true);
    const again = await call("POST", `/api/conductor/suggestions/${created.id}/dismiss`, {});
    expect([again.status, (await errorOf(again)).code]).toEqual([409, "suggestion_closed"]);
    expect((await call("POST", "/api/conductor/suggestions/nope/approve", {})).status).toBe(404);
  });

  it("marks a card stale only with a reason it knows", async () => {
    const created = await json<ConductorSuggestion>(await call("POST", "/api/conductor/suggestions", messageBody));
    expect((await call("POST", `/api/conductor/suggestions/${created.id}/stale`, { reason: "because" })).status).toBe(400);
    const stale = await json<ConductorSuggestion>(await call("POST", `/api/conductor/suggestions/${created.id}/stale`, { reason: "prompt_changed" }));
    expect(stale).toMatchObject({ status: "stale", stale_reason: "prompt_changed" });
    expect((await call("POST", `/api/conductor/suggestions/${created.id}/dismiss`, {})).status).toBe(200);
  });

  it("filters the list by status and refuses another word", async () => {
    await call("POST", "/api/conductor/suggestions", messageBody);
    expect((await json(await call("GET", "/api/conductor/suggestions?status=dismissed"))).suggestions).toEqual([]);
    expect((await call("GET", "/api/conductor/suggestions?status=weird")).status).toBe(400);
  });

  it("sees a passphrase prompt that wrapped at the pane's width (40 columns)", async () => {
    const asked = "Enter passphrase for key '/home/jay/.ssh/id_ed25519':";
    // herdr's screen read keeps the wrap as two rows: the first as wide as the pane
    screens["local/p_2"] = `$ ssh host\n${asked.slice(0, 40)}\n${asked.slice(40)}`;
    expect(asked.length).toBeGreaterThan(40);
    const refused = await call("POST", "/api/conductor/suggestions", messageBody);
    expect([refused.status, (await errorOf(refused)).code]).toEqual([422, "secret_prompt"]);
    // the same two rows of ordinary prose are no secret prompt
    screens["local/p_2"] = "Building the project and then\nrunning the tests";
    expect((await call("POST", "/api/conductor/suggestions", messageBody)).status).toBe(201);
  });

  it("sees a passphrase prompt wrapped after a space the trim removed (25 columns)", async () => {
    const screen = "Enter passphrase for key\n'/tmp/key':";
    expect(paneColumns(screen)).toBe(24);
    expect(showsSecretPrompt(screen)).toBe(true);
    expect(showsSecretPrompt(screen, 25)).toBe(true);
    expect(showsSecretPrompt("Building the project\nand running tests")).toBe(false);
    screens["local/p_2"] = screen;
    const refused = await call("POST", "/api/conductor/suggestions", messageBody);
    expect([refused.status, (await errorOf(refused)).code]).toEqual([422, "secret_prompt"]);
  });

  it("measures the width from the read itself", () => {
    expect(paneColumns("short\nthe longest row  \nmid")).toBe(15);
    expect(paneColumns("")).toBe(1);
  });

  it("refuses a card whose pane reported something while it was being read", async () => {
    const original = deps.readPane;
    deps.readPane = ((inner) => async (machineId, path, params) => {
      const answer = await inner(machineId, path, params);
      if (path === "pane/read") deps.events.record("local", "p_2", "idle");
      return answer;
    })(deps.readPane);
    const refused = await call("POST", "/api/conductor/suggestions", messageBody);
    expect([refused.status, (await errorOf(refused)).code]).toEqual([409, "pane_changed"]);
    expect(deps.store.list()).toEqual([]);
    // an event of another pane, or of the same pane on another PC, does not disturb it
    deps.readPane = ((inner) => async (machineId, path, params) => {
      const answer = await inner(machineId, path, params);
      if (path === "pane/read") { deps.events.record("local", "p_1", "idle"); deps.events.record("pc-2", "p_2", "idle"); }
      return answer;
    })(original);
    expect((await call("POST", "/api/conductor/suggestions", messageBody)).status).toBe(201);
  });

  it("rechecks the pane's status after the reads: an answer needs it still blocked, a message not busy, and it must exist", async () => {
    const during = (change: () => void) => {
      const inner = deps.readPane;
      deps.readPane = async (machineId, path, params) => { const answer = await inner(machineId, path, params); if (path === "pane/prompt" || path === "pane/read") change(); return answer; };
    };
    const set = (paneId: string, status: string) => { roster[0]!.snapshot!.panes.find((entry) => entry.pane_id === paneId)!.agent_status = status; };
    prompts["local/p_1"] = prompt();
    during(() => set("p_1", "idle"));
    const answer = await call("POST", "/api/conductor/suggestions", answerBody);
    expect([answer.status, (await errorOf(answer)).code]).toEqual([409, "pane_not_blocked"]);
    deps.readPane = (async (_machineId, path) => path === "pane/read" ? { read: { text: "$ " } } : { prompt: null }) as ConductorDeps["readPane"];
    during(() => set("p_2", "working"));
    const message = await call("POST", "/api/conductor/suggestions", messageBody);
    expect([message.status, (await errorOf(message)).code]).toEqual([409, "pane_busy"]);
    set("p_2", "unknown");
    deps.readPane = (async (_machineId, path) => path === "pane/read" ? { read: { text: "$ " } } : { prompt: null }) as ConductorDeps["readPane"];
    during(() => { roster[0]!.snapshot!.panes = roster[0]!.snapshot!.panes.filter((entry) => entry.pane_id !== "p_2"); });
    const gone = await call("POST", "/api/conductor/suggestions", messageBody);
    expect([gone.status, (await errorOf(gone)).code]).toEqual([404, "pane_not_found"]);
    expect(deps.store.list()).toEqual([]);
  });

  it("answers a message card for a blocked pane with a clear refusal, and an answer card for an idle one", async () => {
    const busy = await call("POST", "/api/conductor/suggestions", { ...messageBody, pane_id: "p_1" });
    expect([busy.status, (await errorOf(busy)).code]).toEqual([409, "pane_busy"]);
    prompts["pc-2/p_1"] = prompt();
    const idle = await call("POST", "/api/conductor/suggestions", { ...answerBody, machine_id: "pc-2" });
    expect([idle.status, (await errorOf(idle)).code]).toEqual([409, "pane_not_blocked"]);
  });

  it("claims a card once: a second approve, from another tab or a retry, is suggestion_closed", async () => {
    const created = await json<ConductorSuggestion>(await call("POST", "/api/conductor/suggestions", messageBody));
    const results = await Promise.all([1, 2, 3].map(() => call("POST", `/api/conductor/suggestions/${created.id}/approve`, {})));
    expect(results.map((response) => response.status).sort()).toEqual([200, 409, 409]);
    for (const response of results) if (response.status === 409) expect((await errorOf(response)).code).toBe("suggestion_closed");
  });

  it("answers an unknown route with the JSON envelope, and a wrong method plainly", async () => {
    const unknown = await call("GET", "/api/conductor/nothing");
    expect([unknown.status, (await errorOf(unknown)).code]).toEqual([404, "not_found"]);
    expect((await call("GET", "/api/conductor/suggestions/x/approve")).status).toBe(404);
    expect((await call("POST", "/api/conductor/overview", {})).status).toBe(400);
  });
});
