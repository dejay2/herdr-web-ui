import { useId, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, ChevronRight, X } from "lucide-react";

import type { ConductorSuggestion, StaleReason } from "../../shared/conductor.ts";
import type { Machine } from "../../shared/machines.ts";
import { answerPanePrompt, ApiError, closeConductorSuggestion } from "../lib/api.ts";
import type { PaneView } from "../lib/actions.ts";
import { composerDraftKey, composerDrafts } from "../lib/composerDraft.ts";
import { useConductorList } from "../lib/conductor.ts";
import { answerFor, insertSuggestedDraft, openCount, orderSuggestions } from "../lib/conductorCards.ts";
import { type Translate, useT } from "../lib/i18n.ts";
import { sidebarAgents, paneMark } from "../lib/sidebarAgents.ts";
import { useSettings } from "../lib/settings.ts";
import { AgentMark } from "./AgentMark.tsx";
import { displayPaneTitle } from "./Sidebar.tsx";
import "./ConductorSidebar.css";

/** the width under which the sidebar is a drawer (src/styles.css) */
const DRAWER_QUERY = "(max-width: 768px)";

/** Why a card can no longer be acted on, in words. An unknown code (a newer server) still reads. */
export function staleWords(reason: StaleReason | undefined, t: Translate): string {
  switch (reason) {
    case "prompt_changed": return t("The prompt changed before it was approved");
    case "agent_moved_on": return t("The agent moved on from that prompt");
    case "agent_working": return t("The agent started working again");
    case "pane_ended": return t("The pane ended");
    case "pc_removed": return t("The PC was removed");
    default: return t("This suggestion is no longer valid");
  }
}

export interface ConductorSidebarProps {
  machines: Machine[];
  selectedMachineId: string;
  selectedPaneId: string | null;
  onSelect(machineId: string, paneId: string | null, view?: PaneView): void;
}

/**
 * The master agent's suggestions, one card each, across every PC. SUGGEST ONLY: a card acts on
 * nothing until a tap on Approve. An answer is sent from here through the ordinary prompt-answer
 * route (a 409 makes the card stale); a message only becomes a draft in that pane's composer, which
 * the user sends. The bridge itself never sends either.
 */
export function ConductorSidebar({ machines, selectedMachineId, selectedPaneId, onSelect }: ConductorSidebarProps) {
  const t = useT();
  const listId = useId();
  const { settings } = useSettings();
  const list = useConductorList(settings.showConductor);
  const [collapsed, setCollapsed] = useState(() => window.matchMedia?.(DRAWER_QUERY).matches === true);
  const cards = useMemo(() => orderSuggestions(list.suggestions), [list.suggestions]);
  const open = openCount(list.suggestions);
  if (!settings.showConductor || list.unavailable) return null;
  return <section className={`conductor-sidebar${collapsed ? " is-collapsed" : ""}${cards.length === 0 ? " is-empty" : ""}`} aria-label={t("Conductor")}>
    <button type="button" className="conductor-section-toggle sidebar-section-label" aria-expanded={!collapsed} aria-controls={listId} onClick={() => setCollapsed(!collapsed)}>
      {collapsed ? <ChevronRight className="conductor-section-caret" aria-hidden="true" /> : <ChevronDown className="conductor-section-caret" aria-hidden="true" />}
      <span>{t("Conductor")}</span>
      {open > 0 && <span className="conductor-section-count" aria-label={t("{count} open", { count: open })}>{open}</span>}
    </button>
    <div className="conductor-contents" id={listId} hidden={collapsed}>
      {list.error && <p className="conductor-error" role="alert">{t("Could not load suggestions")}</p>}
      {cards.length === 0 && !list.error ? <p className="conductor-empty" role="status">{t("No suggestions")}</p> : <ul className="conductor-list">
        {cards.map((suggestion) => <SuggestionCard
          key={suggestion.id}
          suggestion={suggestion}
          machines={machines}
          selected={suggestion.machine_id === selectedMachineId && suggestion.pane_id === selectedPaneId}
          onSelect={onSelect}
          onChanged={list.refresh}
        />)}
      </ul>}
    </div>
  </section>;
}

interface CardProps {
  suggestion: ConductorSuggestion;
  machines: Machine[];
  selected: boolean;
  onSelect: ConductorSidebarProps["onSelect"];
  onChanged(): void;
}

function SuggestionCard({ suggestion, machines, selected, onSelect, onChanged }: CardProps) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  /** this browser learned the prompt changed (a 409), whether or not the server could be told */
  const [outdated, setOutdated] = useState(false);
  // one request at a time: the state disables the buttons, the ref refuses a second tap before that render
  const inFlight = useRef(false);
  const machine = machines.find((candidate) => candidate.id === suggestion.machine_id);
  const entry = sidebarAgents(machine?.snapshot ?? null).find((candidate) => candidate.pane.pane_id === suggestion.pane_id);
  const pane = machine?.snapshot?.panes.find((candidate) => candidate.pane_id === suggestion.pane_id);
  const title = pane?.label?.trim() || entry?.agent?.title?.trim() || pane?.title?.trim() || (pane ? displayPaneTitle(pane) : suggestion.pane_id);
  const stale = suggestion.status === "stale" || outdated;
  const online = machine?.state === "connected";

  const run = async (work: () => Promise<void>): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setNote(null);
    try { await work(); } finally { inFlight.current = false; setBusy(false); onChanged(); }
  };
  const failed = (error: unknown): string => error instanceof ApiError ? error.detail : error instanceof Error ? error.message : String(error);

  const approve = (): Promise<void> => run(async () => {
    if (suggestion.kind === "answer") {
      const answer = answerFor(suggestion);
      if (!answer || !suggestion.prompt_id) { setNote(t("This suggestion cannot be approved")); return; }
      try {
        await answerPanePrompt({ pane_id: suggestion.pane_id, prompt_id: suggestion.prompt_id, ...answer }, suggestion.machine_id);
      } catch (error) {
        // the screen moved on since the conductor looked: the card says so, nothing was sent
        if (error instanceof ApiError && error.status === 409 && error.code === "prompt_changed") {
          // outdated here at once, whether or not the server could be told
          setOutdated(true);
          try { await closeConductorSuggestion(suggestion.id, "stale", "prompt_changed"); }
          catch (staleError) { setNote(t("Could not mark it outdated: {error}", { error: failed(staleError) })); }
          return;
        }
        setNote(t("Could not approve: {error}", { error: failed(error) }));
        return;
      }
      try {
        await closeConductorSuggestion(suggestion.id, "approve");
      } catch (error) {
        setNote(t("Done, but the card could not be closed: {error}", { error: failed(error) }));
      }
      return;
    }
    // A message has no prompt id to gate it, so the server claims the card (open to approved, once)
    // BEFORE the draft is written: a failed claim writes nothing, and a second tab or tap finds it closed.
    try {
      await closeConductorSuggestion(suggestion.id, "approve");
    } catch (error) {
      setNote(t("Could not approve: {error}", { error: failed(error) }));
      return;
    }
    // never sent from here: the text waits in that pane's composer for the user's own Send
    insertSuggestedDraft((key, update) => composerDrafts.set(key, update), composerDraftKey(suggestion.machine_id, suggestion.pane_id), suggestion.id, suggestion.text ?? "");
    onSelect(suggestion.machine_id, suggestion.pane_id, "chat");
  });

  const dismiss = (): Promise<void> => run(async () => {
    try { await closeConductorSuggestion(suggestion.id, "dismiss"); }
    catch (error) { setNote(t("Could not dismiss: {error}", { error: failed(error) })); }
  });

  const context = [machines.length > 1 ? machine?.name : null, entry?.agentLabel].filter(Boolean).join(" · ");
  return <li className={`conductor-card${stale ? " is-stale" : ""}${selected ? " is-selected" : ""}`} data-machine={suggestion.machine_id} data-pane={suggestion.pane_id}>
    <button type="button" className="conductor-card-open" disabled={!online} aria-current={selected ? "true" : undefined} title={[title, context, suggestion.pane_id].filter(Boolean).join("\n")} onClick={() => onSelect(suggestion.machine_id, suggestion.pane_id)}>
      <span className="sidebar-mark" aria-hidden="true">{entry ? <AgentMark agent={paneMark(entry) ?? ""} size={18} /> : null}</span>
      <span className="conductor-card-copy">
        <span className="conductor-card-title">{title}</span>
        {context && <span className="conductor-card-context">{context}</span>}
      </span>
    </button>
    <p className="conductor-card-summary">{suggestion.summary}</p>
    {suggestion.kind === "answer" && suggestion.answer_label && <p className="conductor-card-detail"><span className="conductor-card-label">{t("Answer")}</span> {suggestion.answer_label}</p>}
    {suggestion.kind === "message" && <>
      <p className="conductor-card-detail conductor-card-quote"><span className="conductor-card-label">{t("Draft message")}</span> {suggestion.text}</p>
      {!stale && <p className="conductor-card-hint">{t("Approve puts this in the composer as a draft. You press Send.")}</p>}
    </>}
    {stale && <p className="conductor-card-stale" role="status">{staleWords(suggestion.status === "stale" ? suggestion.stale_reason : "prompt_changed", t)}</p>}
    {note && <p className="conductor-card-note" role="alert">{note}</p>}
    <div className="conductor-card-actions">
      {!stale && <button type="button" className="btn btn-primary conductor-approve" disabled={busy || !online} onClick={() => void approve()}><Check aria-hidden="true" />{t("Approve")}</button>}
      <button type="button" className="btn conductor-dismiss" disabled={busy} onClick={() => void dismiss()}><X aria-hidden="true" />{t("Dismiss")}</button>
    </div>
  </li>;
}
