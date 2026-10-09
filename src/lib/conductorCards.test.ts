import { beforeEach, describe, expect, it } from "bun:test";

import type { ConductorSuggestion } from "../../shared/conductor.ts";
import { answerFor, forgetInsertedDrafts, insertSuggestedDraft, openCount, orderSuggestions, withSuggestedText } from "./conductorCards.ts";

const card = (over: Partial<ConductorSuggestion>): ConductorSuggestion => ({ id: "a", machine_id: "local", pane_id: "p_1", kind: "message", summary: "s", created_at: "2026-10-09T10:00:00.000Z", status: "open", text: "hi", ...over });

describe("answerFor", () => {
  it("hands the prompt-answer route the one form the card carries", () => {
    expect(answerFor(card({ kind: "answer", answer: { option_index: 0 } }))).toEqual({ option_index: 0 });
    expect(answerFor(card({ kind: "answer", answer: { option_indices: [1, 2] } }))).toEqual({ option_indices: [1, 2] });
    expect(answerFor(card({ kind: "answer", answer: { custom_text: "staging" } }))).toEqual({ custom_text: "staging" });
  });

  it("has none for a message, or an answer card without one", () => {
    expect(answerFor(card({ kind: "message" }))).toBeNull();
    expect(answerFor(card({ kind: "answer", answer: undefined }))).toBeNull();
    expect(answerFor(card({ kind: "answer", answer: {} }))).toBeNull();
  });

  it("copies the indices, so a later edit of the card cannot reach the request", () => {
    const source = card({ kind: "answer", answer: { option_indices: [1] } });
    const answer = answerFor(source)!;
    answer.option_indices!.push(9);
    expect(source.answer?.option_indices).toEqual([1]);
  });
});

describe("withSuggestedText", () => {
  it("is the text alone in an empty composer", () => {
    expect(withSuggestedText("", "Run the tests.")).toBe("Run the tests.");
    expect(withSuggestedText("  \n ", "Run the tests.")).toBe("Run the tests.");
  });

  it("keeps what the user already wrote and adds the suggestion on a new line", () => {
    expect(withSuggestedText("also check the lint", "Run the tests.")).toBe("also check the lint\nRun the tests.");
    expect(withSuggestedText("also check the lint\n\n", "Run the tests.")).toBe("also check the lint\nRun the tests.");
  });
});

describe("orderSuggestions", () => {
  it("puts open cards first, each group oldest first", () => {
    const list = [
      card({ id: "stale-old", status: "stale", created_at: "2026-10-09T09:00:00.000Z" }),
      card({ id: "open-new", created_at: "2026-10-09T10:05:00.000Z" }),
      card({ id: "open-old", created_at: "2026-10-09T10:01:00.000Z" }),
      card({ id: "stale-new", status: "stale", created_at: "2026-10-09T09:30:00.000Z" }),
    ];
    expect(orderSuggestions(list).map((entry) => entry.id)).toEqual(["open-old", "open-new", "stale-old", "stale-new"]);
    expect(list[0]!.id).toBe("stale-old");
  });

  it("counts only the cards waiting for a tap", () => {
    expect(openCount([card({}), card({ status: "stale" }), card({})])).toBe(2);
    expect(openCount([])).toBe(0);
  });
});

describe("insertSuggestedDraft", () => {
  const drafts = new Map<string, string>();
  const set = (key: string, update: (draft: string) => string) => { drafts.set(key, update(drafts.get(key) ?? "")); };
  beforeEach(() => { drafts.clear(); forgetInsertedDrafts(); });

  it("writes the text once per suggestion, however often it is reached", () => {
    expect(insertSuggestedDraft(set, "k", "s1", "Run the tests.")).toBe(true);
    expect(insertSuggestedDraft(set, "k", "s1", "Run the tests.")).toBe(false);
    expect(insertSuggestedDraft(set, "k", "s1", "Run the tests.")).toBe(false);
    expect(drafts.get("k")).toBe("Run the tests.");
  });

  it("lets two overlapping approvals of one card add it once, and two cards add both after what was typed", () => {
    drafts.set("k", "typed already");
    const overlapping = [insertSuggestedDraft(set, "k", "s1", "First."), insertSuggestedDraft(set, "k", "s1", "First.")];
    expect(overlapping).toEqual([true, false]);
    insertSuggestedDraft(set, "k", "s2", "Second.");
    expect(drafts.get("k")).toBe("typed already\nFirst.\nSecond.");
  });
});
