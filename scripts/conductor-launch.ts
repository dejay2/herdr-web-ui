/**
 * What the "Start conductor" pane runs: an ordinary AI agent (Claude Code unless
 * HERDR_WEB_CONDUCTOR_CMD says another) in the conductor folder, given conductor/CONDUCTOR.md as
 * its first message. Kept apart from plugin.ts, whose imports start the plugin.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_CONDUCTOR_CMD = "claude";
/** the brief names the toolkit by this placeholder; the launch writes in the real command */
export const CLI_PLACEHOLDER = "{{CONDUCTOR}}";

/** Whitespace-separated words, with single or double quotes around a word that holds spaces. */
export function splitCommand(text: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: string | null = null;
  let started = false;
  for (const ch of text) {
    if (quote !== null) {
      if (ch === quote) quote = null; else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch; started = true;
    } else if (/\s/.test(ch)) {
      if (started) { words.push(current); current = ""; started = false; }
    } else {
      current += ch; started = true;
    }
  }
  if (quote !== null) throw new Error(`HERDR_WEB_CONDUCTOR_CMD has an unclosed ${quote} quote`);
  if (started) words.push(current);
  return words;
}

const shellWord = (value: string): string => /[\s"'$`\\]/.test(value) ? `"${value.replace(/(["\\$`])/g, "\\$1")}"` : value;

export interface ConductorLaunch {
  /** the agent command and its words; the last one is the brief */
  argv: string[];
  cwd: string;
}

/**
 * @param root the release's own checkout (scripts/ and conductor/ live there)
 * @param execPath the Bun that runs the toolkit, an absolute path so the agent's shell needs no PATH for it
 */
export function conductorLaunch(env: Record<string, string | undefined>, root: string, execPath: string): ConductorLaunch {
  const command = splitCommand((env["HERDR_WEB_CONDUCTOR_CMD"] ?? "").trim() || DEFAULT_CONDUCTOR_CMD);
  if (command.length === 0) throw new Error("HERDR_WEB_CONDUCTOR_CMD is empty");
  const cwd = join(root, "conductor");
  const toolkit = `${shellWord(execPath)} ${shellWord(join(root, "scripts", "conductor.ts"))}`;
  const brief = readFileSync(join(cwd, "CONDUCTOR.md"), "utf8").replaceAll(CLI_PLACEHOLDER, toolkit);
  return { argv: [...command, brief], cwd };
}
