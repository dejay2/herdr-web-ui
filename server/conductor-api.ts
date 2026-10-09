/**
 * /api/conductor/*: the conductor agent's eyes (overview, pane, events) and its one way to speak
 * (a suggestion card). No route here sends a key or a line to a pane. The routes are catalogued in
 * shared/conductor.ts.
 */

import {
  CONDUCTOR_HEADER,
  MAX_EVENT_WAIT_SECONDS,
  STALE_REASONS,
  type StaleReason,
  type ConductorOverview,
  type ConductorOverviewPane,
  type ConductorPane,
  type ConductorPrompt,
  type ConductorTurn,
  type SuggestionRequest,
  type SuggestionStatus,
} from "../shared/conductor.ts";
import type { Machine } from "../shared/machines.ts";
import type { HerdrPane, InteractivePrompt } from "../shared/protocol.ts";
import { secretPrompt } from "../shared/secret-prompt.ts";
import { ConductorError, ConductorStore, ConductorEvents, parseSuggestionRequest } from "./conductor.ts";
import { badRequest, errorResponse, isJsonObject, jsonResponse } from "./http.ts";
import { sameOrigin } from "./machine-security.ts";

/** Reads one pane GET on one PC (local or through its bridge) and answers the parsed JSON, or throws a ConductorError. */
export type PaneReader = (machineId: string, path: string, params: Record<string, string>) => Promise<unknown>;

export interface ConductorDeps {
  store: ConductorStore;
  events: ConductorEvents;
  machines: { list(): Machine[] };
  readPane: PaneReader;
}

const MAX_BODY_BYTES = 64 * 1024;
const TURN_TEXT_CHARS = 1500;
const TURNS = 3;
const SCREEN_LINES = 40;
const SCREEN_CHARS = 4000;
const DEFAULT_WAIT_SECONDS = 25;
const STATUSES: ReadonlySet<string> = new Set<SuggestionStatus>(["open", "approved", "dismissed", "stale"]);

function failure(error: ConductorError): Response {
  return jsonResponse({ error: { code: error.code, message: error.message } }, error.status);
}

function paneLabel(pane: HerdrPane): string | null {
  return pane.label?.trim() || pane.title?.trim() || pane.terminal_title_stripped?.trim() || pane.terminal_title?.trim() || null;
}

function compactPane(pane: HerdrPane): ConductorOverviewPane {
  return { pane_id: pane.pane_id, agent: pane.agent ?? null, agent_status: pane.agent_status, cwd: pane.cwd ?? null, label: paneLabel(pane) };
}

export function overview(machines: readonly Machine[], seq: number, agentsOnly: boolean): ConductorOverview {
  return {
    seq,
    machines: machines.map((machine) => ({
      machine_id: machine.id,
      name: machine.name,
      state: machine.state,
      panes: (machine.snapshot?.panes ?? []).filter((pane) => !agentsOnly || Boolean(pane.agent)).map(compactPane),
    })),
  };
}

/** The tail of a text: the newest words of a long reply are the ones that matter. */
function tail(value: string, max: number): string {
  return value.length <= max ? value : `…${value.slice(value.length - max + 1)}`;
}

/** Text parts only: no thinking, no tool calls or their output, no images. */
export function reduceTurns(turns: unknown): ConductorTurn[] {
  if (!Array.isArray(turns)) return [];
  const reduced: ConductorTurn[] = [];
  for (const turn of turns) {
    if (!isJsonObject(turn) || (turn["role"] !== "user" && turn["role"] !== "assistant") || !Array.isArray(turn["parts"])) continue;
    const text = turn["parts"]
      .flatMap((part) => isJsonObject(part) && part["kind"] === "text" && typeof part["text"] === "string" ? [part["text"].trim()] : [])
      .filter(Boolean)
      .join("\n");
    if (text) reduced.push({ role: turn["role"], text: tail(text, TURN_TEXT_CHARS) });
  }
  return reduced.slice(-TURNS);
}

function reducePrompt(prompt: InteractivePrompt): ConductorPrompt {
  return {
    id: prompt.id, kind: prompt.kind, title: prompt.title, question: prompt.question, body: prompt.body,
    options: prompt.options.map((option) => ({ label: option.label, description: option.description })),
    multi_select: prompt.multi_select, custom_option_index: prompt.custom_option_index,
  };
}

function promptOf(body: unknown): InteractivePrompt | null {
  if (!isJsonObject(body)) throw new ConductorError("bad_pane_answer", "the PC answered the prompt read with something else", 502);
  const prompt = body["prompt"];
  if (prompt === null || prompt === undefined) return null;
  if (!isJsonObject(prompt) || typeof prompt["id"] !== "string" || !Array.isArray(prompt["options"])) throw new ConductorError("bad_pane_answer", "the PC answered the prompt read with something else", 502);
  return prompt as unknown as InteractivePrompt;
}

function screenOf(body: unknown): string {
  const read = isJsonObject(body) ? body["read"] : undefined;
  if (!isJsonObject(read) || typeof read["text"] !== "string") throw new ConductorError("bad_pane_answer", "the PC answered the screen read with something else", 502);
  return read["text"];
}

function findPane(machines: readonly Machine[], machineId: string, paneId: string): { machine: Machine; pane: HerdrPane } {
  const machine = machines.find((candidate) => candidate.id === machineId);
  if (!machine) throw new ConductorError("unknown_machine", `no PC ${machineId}`, 404);
  const pane = machine.snapshot?.panes.find((candidate) => candidate.pane_id === paneId);
  if (!pane) throw new ConductorError("pane_not_found", `pane ${paneId} is not on ${machine.name}`, 404);
  return { machine, pane };
}

async function paneDetail(deps: ConductorDeps, machineId: string, paneId: string): Promise<ConductorPane> {
  const { pane } = findPane(deps.machines.list(), machineId, paneId);
  const [promptBody, conversation] = await Promise.all([
    deps.readPane(machineId, "pane/prompt", { pane_id: paneId }),
    deps.readPane(machineId, "pane/conversation", { pane_id: paneId }).then((body) => ({ body }), (error: unknown) => ({ error })),
  ]);
  const prompt = promptOf(promptBody);
  let turns: ConductorTurn[] = [];
  let screen: string | null = null;
  const transcript = "body" in conversation && isJsonObject(conversation.body) && conversation.body["source"] !== "scrollback" ? conversation.body : null;
  if (transcript) turns = reduceTurns(transcript["turns"]);
  if (!transcript || turns.length === 0) {
    // no transcript: a short look at the screen instead. A failed read is an error, not an empty screen.
    const read = await deps.readPane(machineId, "pane/read", { pane_id: paneId, source: "recent", format: "text", lines: String(SCREEN_LINES) });
    screen = tail(screenOf(read).trimEnd(), SCREEN_CHARS);
  }
  return { machine_id: machineId, pane_id: paneId, agent: pane.agent ?? null, agent_status: pane.agent_status, cwd: pane.cwd ?? null, label: paneLabel(pane), prompt: prompt ? reducePrompt(prompt) : null, turns, screen };
}

/** What the card says the answer is, in the prompt's own words; throws when the answer cannot fit the prompt. */
export function checkAnswer(prompt: InteractivePrompt, answer: NonNullable<SuggestionRequest["answer"]>): string {
  const labelOf = (position: number): string => {
    const option = prompt.options[position];
    if (!option) throw new ConductorError("invalid_answer", `option ${position} is outside the ${prompt.options.length} options on screen`);
    return option.label;
  };
  if (answer.custom_text !== undefined) {
    if (prompt.multi_select || prompt.custom_option_index === null) throw new ConductorError("invalid_answer", "this prompt does not accept a typed answer");
    return answer.custom_text;
  }
  if (answer.option_indices !== undefined) {
    if (!prompt.multi_select) throw new ConductorError("invalid_answer", "this prompt takes one option, not several");
    return answer.option_indices.map(labelOf).join(", ");
  }
  if (prompt.multi_select) throw new ConductorError("invalid_answer", "this prompt takes several options (option_indices)");
  return labelOf(answer.option_index!);
}

async function createSuggestion(deps: ConductorDeps, body: unknown): Promise<Response> {
  const machines = deps.machines.list();
  const request = parseSuggestionRequest(body, (id) => machines.some((machine) => machine.id === id));
  findPane(machines, request.machine_id, request.pane_id);
  // moves if the pane reports anything while the reads below are under way
  const seenSeq = deps.events.paneSeq(request.machine_id, request.pane_id);
  // a password or passphrase prompt is never something an agent may answer or talk over
  const screen = screenOf(await deps.readPane(request.machine_id, "pane/read", { pane_id: request.pane_id, source: "detection", format: "text" }));
  const layoutWidth = findPane(deps.machines.list(), request.machine_id, request.pane_id).machine.snapshot?.layouts?.flatMap((layout) => layout.panes).find((entry) => entry.pane_id === request.pane_id)?.rect.width;
  if (showsSecretPrompt(screen, layoutWidth)) throw new ConductorError("secret_prompt", "the pane is asking for a password or passphrase; nothing is suggested for it", 422);
  let label: string | undefined;
  if (request.kind === "answer") {
    const prompt = promptOf(await deps.readPane(request.machine_id, "pane/prompt", { pane_id: request.pane_id }));
    if (!prompt) throw new ConductorError("no_prompt", "the pane shows no prompt to answer", 409);
    if (prompt.id !== request.prompt_id) throw new ConductorError("prompt_changed", "the pane shows a different prompt now; read it again", 409);
    label = checkAnswer(prompt, request.answer!);
  }
  // the reads took time: the pane may have moved on since the roster the checks above used
  if (deps.events.paneSeq(request.machine_id, request.pane_id) !== seenSeq) throw new ConductorError("pane_changed", "the pane changed while it was being read; read it again", 409);
  const { pane } = findPane(deps.machines.list(), request.machine_id, request.pane_id);
  if (request.kind === "answer" && pane.agent_status !== "blocked") throw new ConductorError("pane_not_blocked", `the pane is ${pane.agent_status}, not waiting on a prompt`, 409);
  if (request.kind === "message" && (pane.agent_status === "working" || pane.agent_status === "blocked")) throw new ConductorError("pane_busy", `the pane is ${pane.agent_status}; a message suits an idle or finished agent`, 409);
  return jsonResponse(deps.store.add(request, label), 201);
}

/**
 * The pane's width in columns, which joining a wrapped prompt line needs. A read carries no width
 * and the layout rect is not the terminal's current size (server/AGENTS.md), so it is the longest
 * row of the read itself: a row that wrapped reached the right edge, and none is longer.
 */
export function paneColumns(screen: string): number {
  return Math.max(1, ...screen.split(/\r?\n/).map((row) => row.trimEnd().length));
}

async function readJson(request: Request): Promise<unknown> {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) throw new ConductorError("body_too_large", "the request body is too large", 413);
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) throw new ConductorError("body_too_large", "the request body is too large", 413);
  try { return raw ? JSON.parse(raw) : {}; } catch { throw new ConductorError("invalid_json", "request body must be JSON"); }
}

function wholeSeconds(value: string | null, field: string, fallback: number): number {
  if (value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new ConductorError("invalid_" + field, `${field} must be a non-negative number`);
  return parsed;
}

/**
 * Handles /api/conductor/*; the caller has applied the token gate, the same-origin rule and the
 * watch-device rule. Mutations need the conductor header too.
 */
export async function handleConductorRequest(request: Request, url: URL, deps: ConductorDeps): Promise<Response> {
  const parts = url.pathname.slice("/api/conductor".length).split("/").filter(Boolean);
  const route = parts[0];
  try {
    if (request.method !== "GET" && request.method !== "HEAD") {
      if (!sameOrigin(request) || request.headers.get(CONDUCTOR_HEADER) !== "1") {
        return jsonResponse({ error: { code: "invalid_conductor_request", message: `Conductor changes need the ${CONDUCTOR_HEADER}: 1 header from this app` } }, 403);
      }
    }
    if (route === "overview" && parts.length === 1) {
      if (request.method !== "GET") return badRequest("method_not_allowed", "use GET");
      return jsonResponse(overview(deps.machines.list(), deps.events.current(), url.searchParams.get("agents_only") === "1"));
    }
    if (route === "pane" && parts.length === 1) {
      if (request.method !== "GET") return badRequest("method_not_allowed", "use GET");
      const machineId = url.searchParams.get("machine_id");
      const paneId = url.searchParams.get("pane_id");
      if (!machineId) return badRequest("missing_machine_id", "machine_id query parameter is required");
      if (!paneId) return badRequest("missing_pane_id", "pane_id query parameter is required");
      return jsonResponse(await paneDetail(deps, machineId, paneId));
    }
    if (route === "events" && parts.length === 1) {
      if (request.method !== "GET") return badRequest("method_not_allowed", "use GET");
      const since = wholeSeconds(url.searchParams.get("since"), "since", 0);
      if (!Number.isSafeInteger(since)) throw new ConductorError("invalid_since", "since must be a whole number");
      const seconds = Math.min(wholeSeconds(url.searchParams.get("timeout"), "timeout", DEFAULT_WAIT_SECONDS), MAX_EVENT_WAIT_SECONDS);
      return jsonResponse(await deps.events.wait(since, seconds * 1000, request.signal), 200, { "cache-control": "no-store" });
    }
    if (route === "suggestions") {
      if (parts.length === 1) {
        if (request.method === "GET") {
          const status = url.searchParams.get("status");
          if (status !== null && !STATUSES.has(status)) return badRequest("invalid_status", "status must be open, approved, dismissed or stale");
          return jsonResponse({ suggestions: deps.store.list((status ?? undefined) as SuggestionStatus | undefined) }, 200, { "cache-control": "no-store" });
        }
        if (request.method === "POST") return await createSuggestion(deps, await readJson(request));
        return badRequest("method_not_allowed", "use GET or POST");
      }
      if (parts.length === 3 && request.method === "POST") {
        const id = parts[1]!;
        const action = parts[2];
        if (action === "approve") return jsonResponse(deps.store.close(id, "approved"));
        if (action === "dismiss") return jsonResponse(deps.store.close(id, "dismissed"));
        if (action === "stale") {
          const body = await readJson(request);
          const given = isJsonObject(body) ? body["reason"] : undefined;
          if (given !== undefined && !STALE_REASONS.includes(given as StaleReason)) throw new ConductorError("invalid_reason", `reason must be one of ${STALE_REASONS.join(", ")}`);
          return jsonResponse(deps.store.close(id, "stale", (given ?? "prompt_changed") as StaleReason));
        }
      }
    }
    return jsonResponse({ error: { code: "not_found", message: `unknown endpoint ${url.pathname}` } }, 404);
  } catch (error) {
    if (error instanceof ConductorError) return failure(error);
    return errorResponse(error);
  }
}

/**
 * Whether the screen ends in a password prompt at ANY plausible pane width (fail closed). The read
 * carries no width; the layout rect is not the current size, so it is only one more candidate. The
 * inferred width is the longest trimmed row, and a row that wrapped after a space lost it to the
 * trim, so one and two columns more are tried too.
 */
export function showsSecretPrompt(screen: string, layoutWidth?: number): boolean {
  const inferred = paneColumns(screen);
  const widths = new Set([inferred, inferred + 1, inferred + 2]);
  if (layoutWidth !== undefined && Number.isInteger(layoutWidth) && layoutWidth > 0) widths.add(layoutWidth);
  return [...widths].some((columns) => secretPrompt(screen, columns) !== null);
}
