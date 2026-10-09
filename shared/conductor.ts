/**
 * The conductor: one master agent, running in an ordinary pane, that watches every pane on every
 * PC and SUGGESTS what to do. It never sends anything to a pane. A suggestion is a card; a human
 * tap is the only thing that acts on it (an answer goes through the existing prompt-answer route
 * from the browser, a message becomes an unsent draft the user sends themselves).
 *
 * Routes (connection server only; a remote bridge does not carry them), all behind the usual
 * token gate. Mutations need same-origin AND `x-herdr-conductor: 1`; a paired watch device is
 * read-only. Every PC's panes are addressed by (machine_id, pane_id): a pane_id alone is unique
 * only on its own PC.
 *   GET  /api/conductor/overview[?agents_only=1]      -> ConductorOverview
 *   GET  /api/conductor/pane?machine_id=&pane_id=     -> ConductorPane
 *   GET  /api/conductor/events?since=&timeout=        -> ConductorEvents (long poll, timeout <= 30 s)
 *   GET  /api/conductor/suggestions[?status=open]     -> { suggestions: ConductorSuggestion[] }
 *   POST /api/conductor/suggestions                   -> 201 ConductorSuggestion (SuggestionRequest)
 *   POST /api/conductor/suggestions/<id>/approve      -> ConductorSuggestion (marks status only)
 *   POST /api/conductor/suggestions/<id>/dismiss      -> ConductorSuggestion
 *   POST /api/conductor/suggestions/<id>/stale { reason?: StaleReason } -> ConductorSuggestion (the browser's
 *        answer attempt met 409 prompt_changed)
 * New suggestions reach the browser as `{ type: "conductor", open, revision }` on the machines SSE
 * stream (/api/machines/events) and as a web push whose tag is `herdr-conductor-<id>`.
 */

export const CONDUCTOR_HEADER = "x-herdr-conductor";
export const MAX_SUMMARY_CHARS = 500;
export const MAX_MESSAGE_CHARS = 8000;
export const MAX_CUSTOM_ANSWER_CHARS = 500;
export const MAX_PANE_ID_CHARS = 200;
/** a POST that would make more than this many suggestions open is refused (409 suggestion_limit) */
export const MAX_OPEN_SUGGESTIONS = 100;
/** approved, dismissed and stale suggestions kept for the card list's history, oldest dropped */
export const MAX_CLOSED_SUGGESTIONS = 100;
export const MAX_EVENT_WAIT_SECONDS = 30;

/**
 * Why a card went stale, as a code the browser words in the user's language:
 * prompt_changed (an approval met 409), agent_moved_on (the pane left `blocked`), agent_working
 * (a message suggested for a pane that went back to work), pane_ended, pc_removed.
 */
export const STALE_REASONS = ["prompt_changed", "agent_moved_on", "agent_working", "pane_ended", "pc_removed"] as const;
export type StaleReason = (typeof STALE_REASONS)[number];

export type SuggestionKind = "answer" | "message";
export type SuggestionStatus = "open" | "approved" | "dismissed" | "stale";

/** Exactly one of the three is present. */
export interface SuggestionAnswer {
  option_index?: number;
  option_indices?: number[];
  custom_text?: string;
}

export interface ConductorSuggestion {
  id: string;
  machine_id: string;
  pane_id: string;
  kind: SuggestionKind;
  summary: string;
  created_at: string;
  status: SuggestionStatus;
  /** kind "answer": the prompt this answers; the browser sends it with the answer and a 409 makes the card stale */
  prompt_id?: string;
  answer?: SuggestionAnswer;
  /** what the answer says in the prompt's own words (the option labels, or the typed text), for the card */
  answer_label?: string;
  /** kind "message": the draft the browser puts in the composer, never sent by the bridge */
  text?: string;
  /** set with status "stale": why the card can no longer be acted on */
  stale_reason?: StaleReason;
  resolved_at?: string;
}

/** POST /api/conductor/suggestions body. */
export interface SuggestionRequest {
  machine_id: string;
  pane_id: string;
  kind: SuggestionKind;
  summary: string;
  prompt_id?: string;
  answer?: SuggestionAnswer;
  text?: string;
}

export interface ConductorOverviewPane {
  pane_id: string;
  agent: string | null;
  agent_status: string;
  cwd: string | null;
  /** the user's label for the pane, else its title */
  label: string | null;
}

export interface ConductorOverviewMachine {
  machine_id: string;
  name: string;
  state: string;
  panes: ConductorOverviewPane[];
}

export interface ConductorOverview {
  /** the newest status-change number: start `events?since=` from here */
  seq: number;
  machines: ConductorOverviewMachine[];
}

export interface ConductorTurn {
  role: "user" | "assistant";
  text: string;
}

/** The prompt on screen, reduced to what deciding an answer needs. */
export interface ConductorPrompt {
  id: string;
  kind: string;
  title: string;
  question: string;
  body: string | null;
  options: { label: string; description: string | null }[];
  multi_select: boolean;
  /** index of the "type your own answer" option, or null */
  custom_option_index: number | null;
}

export interface ConductorPane {
  machine_id: string;
  pane_id: string;
  agent: string | null;
  agent_status: string;
  cwd: string | null;
  label: string | null;
  prompt: ConductorPrompt | null;
  /** the last turns of the agent's transcript, text only (thinking and tool output are dropped) */
  turns: ConductorTurn[];
  /** a short read of the screen, only for a pane with no transcript */
  screen: string | null;
}

export interface ConductorEvent {
  seq: number;
  machine_id: string;
  pane_id: string;
  agent_status: string;
}

/**
 * `seq` is the newest event's number (0 before any). `reset` is true when `since` was ahead of
 * this server's counter (it restarted): the events listed are everything it still holds.
 */
export interface ConductorEvents {
  seq: number;
  events: ConductorEvent[];
  reset?: true;
}

/** Control characters never belong in a summary line, an answer or a pane id. */
export const CONTROL_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/;
