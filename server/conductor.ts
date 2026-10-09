/**
 * The conductor's state: the suggestion cards and the buffer of status changes the conductor
 * agent waits on. SUGGEST ONLY. Nothing here, and nothing a conductor route does, sends a key or a
 * line to a pane; an approval only records that a human tapped (the browser acts, see
 * shared/conductor.ts).
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

import {
  CONTROL_CHARS,
  MAX_CLOSED_SUGGESTIONS,
  MAX_CUSTOM_ANSWER_CHARS,
  MAX_MESSAGE_CHARS,
  MAX_OPEN_SUGGESTIONS,
  MAX_PANE_ID_CHARS,
  MAX_SUMMARY_CHARS,
  type ConductorEvent,
  type ConductorEvents as ConductorEventsAnswer,
  type ConductorSuggestion,
  type SuggestionAnswer,
  type SuggestionRequest,
  STALE_REASONS,
  type StaleReason,
  type SuggestionStatus,
} from "../shared/conductor.ts";
import type { Machine, MachineEvent } from "../shared/machines.ts";
import { isJsonObject } from "./http.ts";

export class ConductorError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message);
    this.name = "ConductorError";
  }
}

const ANSWER_CONTROL = /[\x00-\x1f\x7f-\x9f]/;
const MAX_OPTION_INDEX = 1000;
const MAX_OPTION_INDICES = 64;
const MAX_PROMPT_ID_CHARS = 200;

function text(value: unknown, field: string, max: number, options: { multiline?: boolean } = {}): string {
  if (typeof value !== "string") throw new ConductorError("invalid_suggestion", `${field} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) throw new ConductorError("invalid_suggestion", `${field} is required`);
  if (trimmed.length > max) throw new ConductorError("invalid_suggestion", `${field} is longer than ${max} characters`);
  if ((options.multiline ? CONTROL_CHARS : ANSWER_CONTROL).test(trimmed)) throw new ConductorError("invalid_suggestion", `${field} holds control characters`);
  return trimmed;
}

function index(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > MAX_OPTION_INDEX) throw new ConductorError("invalid_suggestion", `${field} must be a small non-negative integer`);
  return value;
}

/** Exactly one answer form, each checked for shape and size. */
export function parseAnswer(value: unknown): SuggestionAnswer {
  if (!isJsonObject(value)) throw new ConductorError("invalid_suggestion", "answer must be an object");
  const present = ["option_index", "option_indices", "custom_text"].filter((key) => value[key] !== undefined);
  if (present.length !== 1) throw new ConductorError("invalid_suggestion", "answer needs exactly one of option_index, option_indices, custom_text");
  if (value["option_index"] !== undefined) return { option_index: index(value["option_index"], "option_index") };
  if (value["option_indices"] !== undefined) {
    const indices = value["option_indices"];
    if (!Array.isArray(indices) || indices.length === 0 || indices.length > MAX_OPTION_INDICES) throw new ConductorError("invalid_suggestion", "option_indices must be a short non-empty array");
    const parsed = indices.map((entry) => index(entry, "option_indices"));
    if (new Set(parsed).size !== parsed.length) throw new ConductorError("invalid_suggestion", "option_indices must not repeat");
    return { option_indices: parsed };
  }
  return { custom_text: text(value["custom_text"], "custom_text", MAX_CUSTOM_ANSWER_CHARS) };
}

/**
 * A suggestion as the POST body gives it, checked at the edge. `knownMachine` says whether the id
 * names a PC this server manages. Kind-specific fields are required for their kind and refused for
 * the other, so a card never carries text it was not asked to carry.
 */
export function parseSuggestionRequest(body: unknown, knownMachine: (machineId: string) => boolean): SuggestionRequest {
  if (!isJsonObject(body)) throw new ConductorError("invalid_body", "expected a JSON object");
  const machineId = text(body["machine_id"], "machine_id", 100);
  if (!knownMachine(machineId)) throw new ConductorError("unknown_machine", `no PC ${machineId}`, 404);
  const paneId = text(body["pane_id"], "pane_id", MAX_PANE_ID_CHARS);
  const summary = text(body["summary"], "summary", MAX_SUMMARY_CHARS);
  const kind = body["kind"];
  if (kind === "answer") {
    if (body["text"] !== undefined) throw new ConductorError("invalid_suggestion", "an answer suggestion carries no text");
    const promptId = text(body["prompt_id"], "prompt_id", MAX_PROMPT_ID_CHARS);
    return { machine_id: machineId, pane_id: paneId, kind, summary, prompt_id: promptId, answer: parseAnswer(body["answer"]) };
  }
  if (kind === "message") {
    if (body["prompt_id"] !== undefined || body["answer"] !== undefined) throw new ConductorError("invalid_suggestion", "a message suggestion carries no prompt_id or answer");
    return { machine_id: machineId, pane_id: paneId, kind, summary, text: text(body["text"], "text", MAX_MESSAGE_CHARS, { multiline: true }) };
  }
  throw new ConductorError("invalid_suggestion", 'kind must be "answer" or "message"');
}

function isStatus(value: unknown): value is SuggestionStatus {
  return value === "open" || value === "approved" || value === "dismissed" || value === "stale";
}

/** A card read back from the file: anything that does not fit is dropped, never half-trusted. */
function readSuggestion(value: unknown): ConductorSuggestion | null {
  if (!isJsonObject(value) || typeof value["id"] !== "string" || typeof value["created_at"] !== "string" || !isStatus(value["status"])) return null;
  try {
    const request = parseSuggestionRequest(value, () => true);
    const suggestion: ConductorSuggestion = { ...request, id: value["id"], created_at: value["created_at"], status: value["status"] };
    if (typeof value["answer_label"] === "string") suggestion.answer_label = value["answer_label"].slice(0, MAX_SUMMARY_CHARS);
    if (STALE_REASONS.includes(value["stale_reason"] as StaleReason)) suggestion.stale_reason = value["stale_reason"] as StaleReason;
    if (typeof value["resolved_at"] === "string") suggestion.resolved_at = value["resolved_at"];
    return suggestion;
  } catch {
    return null;
  }
}

export interface ConductorStoreOptions {
  stateDir: string;
  now?: () => Date;
  id?: () => string;
  /** called after every change, with the number of open cards and a counter that moves with every change */
  onChange?: (open: number, revision: number, cause: { added?: ConductorSuggestion }) => void;
}

/**
 * The cards, persisted to `<stateDir>/conductor-suggestions.json` (temp file + rename, 0600).
 * An open card is unique per (machine_id, pane_id, kind): a new one replaces the old. At most
 * MAX_OPEN_SUGGESTIONS cards are open; a post beyond that is refused rather than dropping a card
 * the user has not seen, and the conductor is told so. Closed cards are kept (newest
 * MAX_CLOSED_SUGGESTIONS) so the list can say what happened to them.
 */
export class ConductorStore {
  private items: ConductorSuggestion[] = [];
  private revision = 0;
  private readonly path: string;
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(private readonly options: ConductorStoreOptions) {
    this.path = join(options.stateDir, "conductor-suggestions.json");
    this.now = options.now ?? (() => new Date());
    this.newId = options.id ?? (() => randomUUID());
    let raw: string | undefined;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (raw !== undefined) {
      // an unreadable file is not an empty one: the cards stay where they are for recovery
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error(`${this.path} is not a list of suggestions; restore or delete it`);
      this.items = parsed.flatMap((entry) => { const item = readSuggestion(entry); return item ? [item] : []; });
    }
  }

  list(status?: SuggestionStatus): ConductorSuggestion[] {
    return (status ? this.items.filter((item) => item.status === status) : [...this.items]).map((item) => ({ ...item }));
  }

  get(id: string): ConductorSuggestion | undefined {
    const item = this.items.find((candidate) => candidate.id === id);
    return item ? { ...item } : undefined;
  }

  openCount(): number {
    return this.items.filter((item) => item.status === "open").length;
  }

  /** Adds a card, replacing the open one for the same (machine_id, pane_id, kind). */
  add(request: SuggestionRequest, answerLabel?: string): ConductorSuggestion {
    const replaced = this.items.findIndex((item) => item.status === "open" && item.machine_id === request.machine_id && item.pane_id === request.pane_id && item.kind === request.kind);
    if (replaced < 0 && this.openCount() >= MAX_OPEN_SUGGESTIONS) {
      throw new ConductorError("suggestion_limit", `${MAX_OPEN_SUGGESTIONS} suggestions are open; wait for the user to approve or dismiss some`, 409);
    }
    const suggestion: ConductorSuggestion = { ...request, id: this.newId(), created_at: this.now().toISOString(), status: "open", ...(answerLabel ? { answer_label: answerLabel.slice(0, MAX_SUMMARY_CHARS) } : {}) };
    const next = [...this.items];
    if (replaced >= 0) next.splice(replaced, 1);
    next.push(suggestion);
    this.commit(this.trimmed(next), { added: suggestion });
    return { ...suggestion };
  }

  /**
   * Moves an open card to a closed state. Anything but an open card is a conflict, with two
   * exceptions for a stale one: it can be dismissed (it stays on the list, saying why, until someone
   * clears it), and an answer card gone stale because the agent moved on can still be approved,
   * since the browser's own answer is what moved the agent on before its approval arrived.
   */
  close(id: string, status: Exclude<SuggestionStatus, "open">, reason?: StaleReason): ConductorSuggestion {
    const found = this.items.find((item) => item.id === id);
    if (!found) throw new ConductorError("suggestion_not_found", "no such suggestion", 404);
    const allowed = found.status === "open"
      || (found.status === "stale" && status === "dismissed")
      || (found.status === "stale" && status === "approved" && found.kind === "answer" && found.stale_reason === "agent_moved_on");
    if (!allowed) throw new ConductorError("suggestion_closed", `this suggestion is already ${found.status}`, 409);
    const { stale_reason: _earlier, ...kept } = found;
    const closed: ConductorSuggestion = {
      ...(status === "dismissed" && _earlier ? found : kept),
      status, resolved_at: this.now().toISOString(),
      ...(status === "stale" && reason ? { stale_reason: reason } : {}),
    };
    this.commit(this.trimmed(this.items.map((item) => item.id === id ? closed : item)), {});
    return { ...closed };
  }

  /** Marks the open cards of a pane stale when `matches` says what they suggested has gone by. */
  staleWhere(machineId: string, paneId: string, matches: (item: ConductorSuggestion) => boolean, reason: StaleReason): void {
    const at = this.now().toISOString();
    let changed = false;
    const next = this.items.map((item) => {
      if (item.status !== "open" || item.machine_id !== machineId || item.pane_id !== paneId || !matches(item)) return item;
      changed = true;
      return { ...item, status: "stale" as const, stale_reason: reason, resolved_at: at };
    });
    if (changed) this.commit(this.trimmed(next), {});
  }

  /** Marks every open card of a PC stale, e.g. when the PC was removed. */
  staleMachine(machineId: string, reason: StaleReason): void {
    const at = this.now().toISOString();
    let changed = false;
    const next = this.items.map((item) => {
      if (item.status !== "open" || item.machine_id !== machineId) return item;
      changed = true;
      return { ...item, status: "stale" as const, stale_reason: reason, resolved_at: at };
    });
    if (changed) this.commit(this.trimmed(next), {});
  }

  private trimmed(items: ConductorSuggestion[]): ConductorSuggestion[] {
    const closed = items.filter((item) => item.status !== "open");
    if (closed.length <= MAX_CLOSED_SUGGESTIONS) return items;
    const drop = new Set(closed.slice(0, closed.length - MAX_CLOSED_SUGGESTIONS).map((item) => item.id));
    return items.filter((item) => !drop.has(item.id));
  }

  /** Written before the change is announced: a card the file does not hold is never shown. */
  private commit(next: ConductorSuggestion[], cause: { added?: ConductorSuggestion }): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, this.path);
    this.items = next;
    this.revision += 1;
    this.options.onChange?.(this.openCount(), this.revision, cause);
  }
}

const MAX_BUFFERED_EVENTS = 500;

/**
 * The status changes the conductor waits on: a bounded buffer fed from the one status source
 * (the collector's frames reach MachineManager for the local PC, and a remote bridge's
 * observer for the rest). This opens no subscription of its own.
 */
export class ConductorEvents {
  private events: ConductorEvent[] = [];
  private seq = 0;
  private waiters = new Set<() => void>();
  /** the counter value at each pane's newest event: never repeats, so a change during a read shows */
  private paneSeqs = new Map<string, number>();

  /** Moves whenever the pane reports a status or ends; 0 for a pane never heard of. */
  paneSeq(machineId: string, paneId: string): number {
    return this.paneSeqs.get(JSON.stringify([machineId, paneId])) ?? 0;
  }

  record(machineId: string, paneId: string, agentStatus: string): ConductorEvent {
    this.seq += 1;
    const event: ConductorEvent = { seq: this.seq, machine_id: machineId, pane_id: paneId, agent_status: agentStatus };
    this.events.push(event);
    const key = JSON.stringify([machineId, paneId]);
    this.paneSeqs.delete(key);
    this.paneSeqs.set(key, this.seq);
    if (this.paneSeqs.size > 10_000) this.paneSeqs.delete(this.paneSeqs.keys().next().value!);
    if (this.events.length > MAX_BUFFERED_EVENTS) this.events.splice(0, this.events.length - MAX_BUFFERED_EVENTS);
    for (const wake of [...this.waiters]) wake();
    return event;
  }

  current(): number {
    return this.seq;
  }

  since(since: number): ConductorEventsAnswer {
    // a counter ahead of ours is from before a restart: say so and give what we hold
    if (since > this.seq) return { seq: this.seq, events: [...this.events], reset: true };
    return { seq: this.seq, events: this.events.filter((event) => event.seq > since) };
  }

  /** Resolves with the events after `since` as soon as there is one, or empty at the deadline or abort. */
  async wait(since: number, timeoutMs: number, signal?: AbortSignal): Promise<ConductorEventsAnswer> {
    const ready = this.since(since);
    if (ready.events.length > 0 || ready.reset || timeoutMs <= 0 || signal?.aborted) return ready;
    await new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        this.waiters.delete(done);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      this.waiters.add(done);
      signal?.addEventListener("abort", done, { once: true });
    });
    return this.since(since);
  }
}

/**
 * Cards left open across a restart, or across a reconnect that replayed no events, are checked
 * against the roster of every CONNECTED PC: a pane that is gone, an answer card whose pane is no
 * longer blocked, a message card whose pane is working. A PC that is not connected is skipped: its
 * cached roster is no proof of anything.
 */
export function reconcileCards(store: ConductorStore, machines: readonly Machine[]): void {
  for (const machine of machines) {
    if (machine.state !== "connected" || !machine.snapshot) continue;
    const status = new Map(machine.snapshot.panes.map((pane) => [pane.pane_id, pane.agent_status]));
    for (const paneId of new Set(store.list("open").filter((item) => item.machine_id === machine.id).map((item) => item.pane_id))) {
      const current = status.get(paneId);
      if (current === undefined) {
        store.staleWhere(machine.id, paneId, () => true, "pane_ended");
        continue;
      }
      if (current === "idle" || current === "done" || current === "working") store.staleWhere(machine.id, paneId, (item) => item.kind === "answer", "agent_moved_on");
      if (current === "working") store.staleWhere(machine.id, paneId, (item) => item.kind === "message", "agent_working");
    }
  }
}

/**
 * Feeds the buffer, and calls off the cards a pane has outgrown, from the machine stream
 * MachineManager already keeps (local collector frames and each remote bridge's observer).
 * A card whose pane answered its prompt, or ended, can no longer be acted on; neither can a
 * message suggested for a pane that went back to work.
 */
export function followMachines(
  machines: { subscribe(listener: (event: MachineEvent) => void): () => void },
  events: ConductorEvents,
  store: ConductorStore,
): () => void {
  return machines.subscribe((event) => {
    if (event.type === "machines") {
      const known = new Set(event.machines.map((machine) => machine.id));
      for (const machineId of new Set(store.list("open").map((item) => item.machine_id))) {
        if (!known.has(machineId)) store.staleMachine(machineId, "pc_removed");
      }
      reconcileCards(store, event.machines);
      return;
    }
    if (event.type !== "machine-message") return;
    const message = event.message;
    if (message.type === "pane-status") {
      events.record(event.machine_id, message.pane_id, message.agent_status);
      const status = message.agent_status;
      if (status === "idle" || status === "done" || status === "working") {
        store.staleWhere(event.machine_id, message.pane_id, (item) => item.kind === "answer", "agent_moved_on");
      }
      if (status === "working") {
        store.staleWhere(event.machine_id, message.pane_id, (item) => item.kind === "message", "agent_working");
      }
    } else if (message.type === "pane-exited") {
      events.record(event.machine_id, message.pane_id, "exited");
      store.staleWhere(event.machine_id, message.pane_id, () => true, "pane_ended");
    }
  });
}
