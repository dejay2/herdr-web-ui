import type { ConductorSuggestion } from "../../shared/conductor.ts";
import type { PromptAnswer } from "../../shared/protocol.ts";

/** The answer a card carries, in the shape the prompt-answer route takes. */
export function answerFor(suggestion: ConductorSuggestion): Pick<PromptAnswer, "option_index" | "option_indices" | "custom_text"> | null {
  const answer = suggestion.answer;
  if (suggestion.kind !== "answer" || !answer) return null;
  if (answer.option_index !== undefined) return { option_index: answer.option_index };
  if (answer.option_indices !== undefined) return { option_indices: [...answer.option_indices] };
  if (answer.custom_text !== undefined) return { custom_text: answer.custom_text };
  return null;
}

/** A suggested message joins what is already in the composer; it never replaces the user's own text. */
export function withSuggestedText(draft: string, text: string): string {
  return draft.trim() ? `${draft.replace(/\s+$/, "")}\n${text}` : text;
}

/** Open cards first, then stale ones; oldest first within each, the order they were asked in. */
export function orderSuggestions(list: readonly ConductorSuggestion[]): ConductorSuggestion[] {
  const rank = (suggestion: ConductorSuggestion): number => suggestion.status === "open" ? 0 : 1;
  return [...list].sort((a, b) => rank(a) - rank(b) || a.created_at.localeCompare(b.created_at));
}

export function openCount(list: readonly ConductorSuggestion[]): number {
  return list.filter((suggestion) => suggestion.status === "open").length;
}
