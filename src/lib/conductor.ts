import { useCallback, useEffect, useState } from "react";

import type { ConductorSuggestion } from "../../shared/conductor.ts";
import { ApiError, fetchConductorSuggestions } from "./api.ts";

/** How often the list is read again when no event said it changed (a missed event, a PC that came back). */
export const CONDUCTOR_POLL_MS = 30_000;

type Listener = () => void;
const listeners = new Set<Listener>();

/** The machine stream said the cards changed (App owns that stream); every list reads them again. */
export function notifyConductorChanged(): void {
  for (const listener of [...listeners]) listener();
}

export interface ConductorList {
  suggestions: ConductorSuggestion[];
  /** the section has nothing to say: the server has no conductor (404 from an older server, 503 when its file is unreadable) */
  unavailable: boolean;
  /** a read that failed for any other reason: shown, not turned into an empty list */
  error: string | null;
  refresh(): void;
}

/** The conductor's cards, read on mount, on the stream's word, when the page returns, and every CONDUCTOR_POLL_MS. */
export function useConductorList(enabled: boolean): ConductorList {
  const [suggestions, setSuggestions] = useState<ConductorSuggestion[]>([]);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((value) => value + 1), []);
  useEffect(() => {
    if (!enabled) return;
    listeners.add(refresh);
    const timer = window.setInterval(refresh, CONDUCTOR_POLL_MS);
    const visible = (): void => { if (document.visibilityState === "visible") refresh(); };
    document.addEventListener("visibilitychange", visible);
    return () => { listeners.delete(refresh); window.clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
  }, [enabled, refresh]);
  useEffect(() => {
    if (!enabled) return;
    const abort = new AbortController();
    fetchConductorSuggestions(abort.signal).then((list) => {
      setSuggestions((previous) => JSON.stringify(previous) === JSON.stringify(list) ? previous : list);
      setUnavailable(false);
      setError(null);
    }).catch((reason: unknown) => {
      if (abort.signal.aborted) return;
      if (reason instanceof ApiError && (reason.status === 404 || reason.status === 503)) { setUnavailable(true); setError(null); return; }
      setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => abort.abort();
  }, [enabled, tick]);
  return { suggestions, unavailable, error, refresh };
}
