import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MAX_CLOSED_SUGGESTIONS, MAX_MESSAGE_CHARS, MAX_OPEN_SUGGESTIONS, MAX_SUMMARY_CHARS, type SuggestionRequest } from "../shared/conductor.ts";
import type { Machine, MachineEvent } from "../shared/machines.ts";
import { ConductorError, ConductorEvents, ConductorStore, followMachines, parseAnswer, parseSuggestionRequest, reconcileCards } from "./conductor.ts";

const known = (id: string) => id === "local" || id === "pc-2";
const answerBody = { machine_id: "local", pane_id: "p_1", kind: "answer", summary: "Allow the push", prompt_id: "abc123", answer: { option_index: 0 } };
const messageBody = { machine_id: "local", pane_id: "p_1", kind: "message", summary: "Next step", text: "Run the tests." };

function rejects(body: unknown, code: string, status?: number): void {
  try {
    parseSuggestionRequest(body, known);
  } catch (error) {
    expect(error).toBeInstanceOf(ConductorError);
    expect((error as ConductorError).code).toBe(code);
    if (status !== undefined) expect((error as ConductorError).status).toBe(status);
    return;
  }
  throw new Error(`accepted ${JSON.stringify(body)}`);
}

describe("parseSuggestionRequest", () => {
  it("accepts an answer and a message and trims their words", () => {
    expect(parseSuggestionRequest({ ...answerBody, summary: "  Allow the push  " }, known)).toEqual({ ...answerBody, summary: "Allow the push" } as SuggestionRequest);
    expect(parseSuggestionRequest(messageBody, known)).toEqual(messageBody as SuggestionRequest);
  });

  it("refuses a body that is not an object, an unknown PC, and a bad kind", () => {
    rejects(null, "invalid_body");
    rejects([], "invalid_body");
    rejects({ ...messageBody, machine_id: "nope" }, "unknown_machine", 404);
    rejects({ ...messageBody, kind: "keys" }, "invalid_suggestion");
    rejects({ ...messageBody, kind: undefined }, "invalid_suggestion");
  });

  it("holds every text to its type and length", () => {
    rejects({ ...messageBody, summary: "" }, "invalid_suggestion");
    rejects({ ...messageBody, summary: "   " }, "invalid_suggestion");
    rejects({ ...messageBody, summary: 7 }, "invalid_suggestion");
    rejects({ ...messageBody, summary: "x".repeat(MAX_SUMMARY_CHARS + 1) }, "invalid_suggestion");
    expect(parseSuggestionRequest({ ...messageBody, summary: "x".repeat(MAX_SUMMARY_CHARS) }, known).summary).toHaveLength(MAX_SUMMARY_CHARS);
    rejects({ ...messageBody, text: "x".repeat(MAX_MESSAGE_CHARS + 1) }, "invalid_suggestion");
    expect(parseSuggestionRequest({ ...messageBody, text: "x".repeat(MAX_MESSAGE_CHARS) }, known).text).toHaveLength(MAX_MESSAGE_CHARS);
    rejects({ ...messageBody, pane_id: "" }, "invalid_suggestion");
    rejects({ ...messageBody, pane_id: "p".repeat(201) }, "invalid_suggestion");
  });

  it("keeps control characters out of a summary but lets a message have its lines", () => {
    rejects({ ...messageBody, summary: "bad\u001b[31m" }, "invalid_suggestion");
    rejects({ ...messageBody, text: "bad\u0000text" }, "invalid_suggestion");
    expect(parseSuggestionRequest({ ...messageBody, text: "line one\nline two\tindented" }, known).text).toBe("line one\nline two\tindented");
  });

  it("requires the fields of its own kind and refuses the other kind's", () => {
    rejects({ ...answerBody, prompt_id: undefined }, "invalid_suggestion");
    rejects({ ...answerBody, answer: undefined }, "invalid_suggestion");
    rejects({ ...answerBody, text: "also text" }, "invalid_suggestion");
    rejects({ ...messageBody, text: undefined }, "invalid_suggestion");
    rejects({ ...messageBody, prompt_id: "abc" }, "invalid_suggestion");
    rejects({ ...messageBody, answer: { option_index: 0 } }, "invalid_suggestion");
  });
});

describe("parseAnswer", () => {
  it("takes exactly one form", () => {
    expect(parseAnswer({ option_index: 2 })).toEqual({ option_index: 2 });
    expect(parseAnswer({ option_indices: [0, 2] })).toEqual({ option_indices: [0, 2] });
    expect(parseAnswer({ custom_text: "  use staging " })).toEqual({ custom_text: "use staging" });
    for (const bad of [{}, { option_index: 0, custom_text: "x" }, { option_index: 0, option_indices: [1] }, "0", null]) {
      expect(() => parseAnswer(bad)).toThrow(ConductorError);
    }
  });

  it("checks the numbers and the typed text", () => {
    for (const bad of [{ option_index: -1 }, { option_index: 1.5 }, { option_index: "1" }, { option_index: 100000 }, { option_indices: [] }, { option_indices: [1, 1] }, { option_indices: [-1] }, { option_indices: "1" }, { custom_text: "" }, { custom_text: "x".repeat(501) }, { custom_text: "a\nb" }, { custom_text: "a\u0003b" }]) {
      expect(() => parseAnswer(bad)).toThrow(ConductorError);
    }
  });
});

describe("ConductorStore", () => {
  let dir: string;
  let ids: number;
  let changes: Array<{ open: number; revision: number; added?: string }>;
  const open = (overrides: Partial<SuggestionRequest> = {}): SuggestionRequest => parseSuggestionRequest({ ...messageBody, ...overrides }, known);
  const make = () => new ConductorStore({
    stateDir: dir,
    id: () => `id-${++ids}`,
    now: () => new Date("2026-10-09T10:00:00.000Z"),
    onChange: (count, revision, cause) => changes.push({ open: count, revision, added: cause.added?.id }),
  });
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "herdr-conductor-store-")); ids = 0; changes = []; });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("adds an open card, announces it and writes the file private", () => {
    const store = make();
    const card = store.add(open());
    expect(card).toMatchObject({ id: "id-1", status: "open", kind: "message", created_at: "2026-10-09T10:00:00.000Z" });
    expect(changes).toEqual([{ open: 1, revision: 1, added: "id-1" }]);
    const file = join(dir, "conductor-suggestions.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8"))).toHaveLength(1);
    expect(readFileSync(file, "utf8").endsWith("\n")).toBe(true);
  });

  it("replaces the open card of the same pane and kind and keeps other kinds, panes and PCs apart", () => {
    const store = make();
    store.add(open());
    store.add(open({ text: "Run the linter." }));
    expect(store.list("open").map((card) => card.text)).toEqual(["Run the linter."]);
    store.add(open({ pane_id: "p_2" }));
    store.add(open({ machine_id: "pc-2" }));
    store.add(parseSuggestionRequest(answerBody, known), "Yes");
    expect(store.list("open")).toHaveLength(4);
    expect(store.list("open").find((card) => card.kind === "answer")?.answer_label).toBe("Yes");
  });

  it("does not replace a card the user already settled", () => {
    const store = make();
    const first = store.add(open());
    store.close(first.id, "dismissed");
    store.add(open());
    expect(store.list().map((card) => card.status)).toEqual(["dismissed", "open"]);
  });

  it("refuses the card past the open limit, and a replacement still goes through", () => {
    const store = make();
    for (let i = 0; i < MAX_OPEN_SUGGESTIONS; i++) store.add(open({ pane_id: `p_${i}` }));
    expect(() => store.add(open({ pane_id: "one-too-many" }))).toThrow(expect.objectContaining({ code: "suggestion_limit", status: 409 }));
    expect(store.openCount()).toBe(MAX_OPEN_SUGGESTIONS);
    expect(store.add(open({ pane_id: "p_0", text: "Updated." })).status).toBe("open");
    expect(store.openCount()).toBe(MAX_OPEN_SUGGESTIONS);
  });

  it("closes an open card once and says what happened to it", () => {
    const store = make();
    const card = store.add(open());
    expect(store.close(card.id, "approved")).toMatchObject({ status: "approved", resolved_at: "2026-10-09T10:00:00.000Z" });
    expect(() => store.close(card.id, "dismissed")).toThrow(expect.objectContaining({ code: "suggestion_closed", status: 409 }));
    expect(() => store.close("missing", "dismissed")).toThrow(expect.objectContaining({ code: "suggestion_not_found", status: 404 }));
  });

  it("lets a stale card be dismissed, and an answer the browser just gave be approved after the agent moved on", () => {
    const store = make();
    const message = store.add(open());
    store.staleWhere("local", "p_1", () => true, "agent_working");
    expect(store.get(message.id)).toMatchObject({ status: "stale", stale_reason: "agent_working" });
    expect(() => store.close(message.id, "approved")).toThrow(expect.objectContaining({ code: "suggestion_closed" }));
    expect(store.close(message.id, "dismissed").status).toBe("dismissed");

    const answer = store.add(parseSuggestionRequest(answerBody, known), "Yes");
    store.staleWhere("local", "p_1", (item) => item.kind === "answer", "agent_moved_on");
    const approved = store.close(answer.id, "approved");
    expect(approved.status).toBe("approved");
    expect(approved.stale_reason).toBeUndefined();
  });

  it("marks a card stale with the browser's reason", () => {
    const store = make();
    const card = store.add(open());
    expect(store.close(card.id, "stale", "prompt_changed")).toMatchObject({ status: "stale", stale_reason: "prompt_changed" });
  });

  it("keeps the newest closed cards only", () => {
    const store = make();
    for (let i = 0; i < MAX_CLOSED_SUGGESTIONS + 5; i++) store.close(store.add(open({ pane_id: `p_${i}` })).id, "dismissed");
    const left = store.list();
    expect(left).toHaveLength(MAX_CLOSED_SUGGESTIONS);
    expect(left[0]!.pane_id).toBe("p_5");
  });

  it("survives a restart with its cards, and drops an entry that does not fit", () => {
    const first = make();
    const kept = first.add(open());
    first.add(parseSuggestionRequest(answerBody, known), "Yes");
    const file = join(dir, "conductor-suggestions.json");
    const saved = JSON.parse(readFileSync(file, "utf8")) as unknown[];
    writeFileSync(file, JSON.stringify([...saved, { id: "bad", status: "open", created_at: "x", kind: "message", machine_id: "local", pane_id: "p", summary: "no text" }, 7]));
    const second = make();
    expect(second.list().map((card) => card.id)).toEqual([kept.id, "id-2"]);
    expect(second.get("id-2")?.answer_label).toBe("Yes");
  });

  it("refuses to start over a file it cannot read, rather than emptying it", () => {
    writeFileSync(join(dir, "conductor-suggestions.json"), "{ not json");
    expect(() => make()).toThrow();
    writeFileSync(join(dir, "conductor-suggestions.json"), "{}");
    expect(() => make()).toThrow("not a list");
  });

  it("stales the cards of a PC that is gone", () => {
    const store = make();
    store.add(open({ machine_id: "pc-2" }));
    store.add(open());
    store.staleMachine("pc-2", "pc_removed");
    expect(store.list().map((card) => [card.machine_id, card.status, card.stale_reason])).toEqual([["pc-2", "stale", "pc_removed"], ["local", "open", undefined]]);
  });
});

describe("ConductorEvents", () => {
  it("numbers events and answers those after a number", () => {
    const events = new ConductorEvents();
    events.record("local", "p_1", "blocked");
    events.record("pc-2", "p_9", "idle");
    expect(events.current()).toBe(2);
    expect(events.since(0).events.map((event) => [event.seq, event.machine_id, event.pane_id, event.agent_status])).toEqual([[1, "local", "p_1", "blocked"], [2, "pc-2", "p_9", "idle"]]);
    expect(events.since(1).events).toHaveLength(1);
    expect(events.since(2)).toEqual({ seq: 2, events: [] });
  });

  it("says when the caller is ahead of it (a restart) and gives what it holds", () => {
    const events = new ConductorEvents();
    events.record("local", "p_1", "working");
    expect(events.since(50)).toEqual({ seq: 1, events: [{ seq: 1, machine_id: "local", pane_id: "p_1", agent_status: "working" }], reset: true });
  });

  it("holds a bounded buffer", () => {
    const events = new ConductorEvents();
    for (let i = 0; i < 700; i++) events.record("local", "p_1", "working");
    const held = events.since(0).events;
    expect(held).toHaveLength(500);
    expect(held[0]!.seq).toBe(201);
    expect(events.current()).toBe(700);
  });

  it("wakes a waiter on the next event, and answers empty at the deadline", async () => {
    const events = new ConductorEvents();
    const waiting = events.wait(0, 5000);
    events.record("local", "p_1", "blocked");
    expect((await waiting).events.map((event) => event.agent_status)).toEqual(["blocked"]);
    const started = Date.now();
    expect(await events.wait(1, 30)).toEqual({ seq: 1, events: [] });
    expect(Date.now() - started).toBeGreaterThanOrEqual(25);
  });

  it("answers at once when events are waiting, and when the caller gives up", async () => {
    const events = new ConductorEvents();
    events.record("local", "p_1", "blocked");
    expect((await events.wait(0, 5000)).events).toHaveLength(1);
    const abort = new AbortController();
    const waiting = events.wait(1, 5000, abort.signal);
    abort.abort();
    expect(await waiting).toEqual({ seq: 1, events: [] });
  });
});

describe("followMachines", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "herdr-conductor-follow-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function rig() {
    const listeners = new Set<(event: MachineEvent) => void>();
    const events = new ConductorEvents();
    const store = new ConductorStore({ stateDir: dir });
    const stop = followMachines({ subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); } }, events, store);
    const emit = (event: MachineEvent) => { for (const listener of listeners) listener(event); };
    const status = (machineId: string, paneId: string, agentStatus: string) => emit({ type: "machine-message", machine_id: machineId, message: { type: "pane-status", pane_id: paneId, agent_status: agentStatus } });
    return { events, store, stop, emit, status, listeners };
  }

  it("records status changes and pane ends from every PC", () => {
    const { events, status, emit } = rig();
    status("local", "p_1", "blocked");
    status("pc-2", "p_1", "working");
    emit({ type: "machine-message", machine_id: "local", message: { type: "pane-exited", pane_id: "p_1" } });
    emit({ type: "machine-message", machine_id: "local", message: { type: "session-changed" } });
    expect(events.since(0).events.map((event) => [event.machine_id, event.pane_id, event.agent_status])).toEqual([["local", "p_1", "blocked"], ["pc-2", "p_1", "working"], ["local", "p_1", "exited"]]);
  });

  it("calls off an answer card when the pane leaves blocked, but not for a PC with the same pane id", () => {
    const { store, status } = rig();
    store.add(parseSuggestionRequest(answerBody, known), "Yes");
    store.add(parseSuggestionRequest({ ...answerBody, machine_id: "pc-2" }, known), "Yes");
    status("local", "p_1", "blocked");
    status("local", "p_1", "unknown");
    expect(store.openCount()).toBe(2);
    status("local", "p_1", "working");
    expect(store.list().map((card) => [card.machine_id, card.status, card.stale_reason])).toEqual([["local", "stale", "agent_moved_on"], ["pc-2", "open", undefined]]);
  });

  it("calls off a message card when the pane goes back to work, not when it finishes", () => {
    const { store, status } = rig();
    store.add(parseSuggestionRequest(messageBody, known));
    status("local", "p_1", "idle");
    status("local", "p_1", "done");
    expect(store.openCount()).toBe(1);
    status("local", "p_1", "working");
    expect(store.list()[0]).toMatchObject({ status: "stale", stale_reason: "agent_working" });
  });

  it("calls off every card of a pane that ended, and of a PC that left the list", () => {
    const { store, emit } = rig();
    store.add(parseSuggestionRequest(messageBody, known));
    store.add(parseSuggestionRequest({ ...messageBody, pane_id: "p_2", machine_id: "pc-2" }, known));
    emit({ type: "machine-message", machine_id: "local", message: { type: "pane-exited", pane_id: "p_1" } });
    expect(store.list()[0]).toMatchObject({ status: "stale", stale_reason: "pane_ended" });
    emit({ type: "machines", machines: [] });
    expect(store.list()[1]).toMatchObject({ status: "stale", stale_reason: "pc_removed" });
  });

  it("stops listening", () => {
    const { listeners, stop } = rig();
    expect(listeners.size).toBe(1);
    stop();
    expect(listeners.size).toBe(0);
  });
});

describe("reconcileCards: restart and reconnect recovery", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "herdr-conductor-reconcile-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const machine = (id: string, state: Machine["state"], panes: Record<string, string>): Machine => ({
    id, name: id, kind: id === "local" ? "local" : "ssh", enabled: true, state, error: null,
    snapshot: { panes: Object.entries(panes).map(([pane_id, agent_status]) => ({ pane_id, agent_status })) } as unknown as Machine["snapshot"],
  });
  const seed = (store: ConductorStore) => {
    store.add(parseSuggestionRequest({ ...answerBody, pane_id: "a" }, known), "Yes");
    store.add(parseSuggestionRequest({ ...messageBody, pane_id: "m" }, known));
    store.add(parseSuggestionRequest({ ...messageBody, pane_id: "gone" }, known));
    store.add(parseSuggestionRequest({ ...answerBody, pane_id: "a", machine_id: "pc-2" }, known), "Yes");
  };
  const states = (store: ConductorStore) => store.list().map((card) => `${card.machine_id}/${card.pane_id}/${card.kind}:${card.status}${card.stale_reason ? `:${card.stale_reason}` : ""}`);

  it("after a restart, calls off what the first connected roster shows has gone by", () => {
    seed(new ConductorStore({ stateDir: dir }));
    const restarted = new ConductorStore({ stateDir: dir });
    expect(restarted.openCount()).toBe(4);
    const listeners: Array<(event: MachineEvent) => void> = [];
    followMachines({ subscribe: (listener) => { listeners.push(listener); return () => {}; } }, new ConductorEvents(), restarted);
    listeners[0]!({ type: "machines", machines: [machine("local", "connected", { a: "idle", m: "working" }), machine("pc-2", "connected", { a: "blocked" })] });
    expect(states(restarted)).toEqual([
      "local/a/answer:stale:agent_moved_on", "local/m/message:stale:agent_working", "local/gone/message:stale:pane_ended", "pc-2/a/answer:open",
    ]);
  });

  it("keeps a card whose pane is still as it was", () => {
    const store = new ConductorStore({ stateDir: dir });
    seed(store);
    reconcileCards(store, [machine("local", "connected", { a: "blocked", m: "idle", gone: "done" })]);
    expect(states(store).filter((entry) => entry.startsWith("local")).every((entry) => entry.endsWith(":open"))).toBe(true);
  });

  it("takes no cached roster of a PC that is not connected for proof of anything", () => {
    const store = new ConductorStore({ stateDir: dir });
    seed(store);
    reconcileCards(store, [machine("local", "reconnecting", {}), machine("pc-2", "disconnected", { a: "idle" })]);
    expect(store.openCount()).toBe(4);
    // once the PC reconnects and its roster arrives, the cards are reconciled
    reconcileCards(store, [machine("local", "connected", { a: "blocked", m: "idle", gone: "done" }), machine("pc-2", "connected", { a: "idle" })]);
    expect(states(store)).toContain("pc-2/a/answer:stale:agent_moved_on");
    expect(store.openCount()).toBe(3);
  });

  it("skips a connected PC whose roster has not loaded", () => {
    const store = new ConductorStore({ stateDir: dir });
    seed(store);
    reconcileCards(store, [{ ...machine("local", "connected", {}), snapshot: null }]);
    expect(store.openCount()).toBe(4);
  });

  it("tracks the newest event number of each pane apart per PC", () => {
    const events = new ConductorEvents();
    expect(events.paneSeq("local", "p")).toBe(0);
    events.record("local", "p", "idle");
    const first = events.paneSeq("local", "p");
    events.record("pc-2", "p", "idle");
    expect(events.paneSeq("local", "p")).toBe(first);
    events.record("local", "p", "working");
    expect(events.paneSeq("local", "p")).toBeGreaterThan(first);
  });
});
