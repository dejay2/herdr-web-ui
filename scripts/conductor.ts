#!/usr/bin/env bun
/**
 * The conductor's toolkit: eyes on every pane of every PC, and one way to speak: a suggestion card
 * the user approves or dismisses in the web UI. THERE IS NO COMMAND HERE THAT SENDS ANYTHING TO A
 * PANE, by design (conductor/CONDUCTOR.md).
 *
 *   conductor.ts overview [--agents-only]
 *   conductor.ts pane <machine_id> <pane_id>
 *   conductor.ts wait [--since N] [--timeout S]
 *   conductor.ts suggest-answer <machine_id> <pane_id> --prompt-id ID (--option N | --options N,M | --custom TEXT) --summary TEXT
 *   conductor.ts suggest-message <machine_id> <pane_id> (--text TEXT | --text-file PATH|-) --summary TEXT
 *   conductor.ts suggestions [--status open|approved|dismissed|stale]
 *
 * Output is one line of compact JSON on stdout. A failure prints {"error":{"code","message"}} on stderr
 * and exits 1 (2 for a misuse of this command). The server is found from HERDR_WEB_URL, else the
 * port in HERDR_WEB_PORT, PORT, the plugin's saved port or 7317 on HOST (default 127.0.0.1); a
 * HERDR_WEB_TOKEN is sent as a Bearer token.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { CONDUCTOR_HEADER } from "../shared/conductor.ts";
import { DEFAULT_PORT } from "../shared/protocol.ts";
import { savedPort } from "./plugin-port.ts";

export class UsageError extends Error {}

/** A server's refusal or an unreachable server, printed as the error envelope. */
export class CliFailure extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

type Env = Record<string, string | undefined>;

/** Where the web server listens, from the environment the way the plugin settles it. */
export function resolveOrigin(env: Env, home = homedir()): string {
  const url = env["HERDR_WEB_URL"];
  if (url) return url.replace(/\/+$/, "");
  const chosen = env["HERDR_WEB_PORT"] || env["PORT"];
  let port = chosen ? Number(chosen) : NaN;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    const stateDir = env["HERDR_WEB_STATE_DIR"] || join(env["XDG_CONFIG_HOME"] || join(home, ".config"), "herdr-web-ui");
    port = savedPort(join(stateDir, "plugin-port")) ?? DEFAULT_PORT;
  }
  const host = env["HOST"] || "127.0.0.1";
  const reachable = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${reachable}:${port}`;
}

export interface Parsed {
  command: string;
  positional: string[];
  flags: Map<string, string>;
}

const BOOLEAN_FLAGS = new Set(["agents-only"]);

/** `--name value`, `--name=value` and bare booleans. A value is taken as it is, also when it starts with dashes. */
export function parseArgs(argv: readonly string[], known: ReadonlySet<string>): Parsed {
  const [command, ...rest] = argv;
  if (!command) throw new UsageError("a command is required");
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (!arg.startsWith("--")) { positional.push(arg); continue; }
    const eq = arg.indexOf("=");
    const name = arg.slice(2, eq < 0 ? undefined : eq);
    if (!known.has(name)) throw new UsageError(`unknown option --${name}`);
    if (flags.has(name)) throw new UsageError(`--${name} given twice`);
    if (eq >= 0) { flags.set(name, arg.slice(eq + 1)); continue; }
    if (BOOLEAN_FLAGS.has(name)) { flags.set(name, "1"); continue; }
    const value = rest[++i];
    if (value === undefined) throw new UsageError(`--${name} needs a value`);
    flags.set(name, value);
  }
  return { command, positional, flags };
}

function required(flags: Map<string, string>, name: string): string {
  const value = flags.get(name);
  if (value === undefined || value.trim() === "") throw new UsageError(`--${name} is required`);
  return value;
}

function wholeNumber(value: string, name: string): number {
  if (!/^\d+$/.test(value)) throw new UsageError(`--${name} must be a whole number`);
  return Number(value);
}

function exactly(positional: readonly string[], names: readonly string[]): string[] {
  if (positional.length !== names.length) throw new UsageError(`expected ${names.map((name) => `<${name}>`).join(" ") || "no arguments"}`);
  return [...positional];
}

export interface Call {
  method: "GET" | "POST";
  path: string;
  body?: unknown;
  /** how long to wait for the answer, beyond the server's own long poll */
  waitMs?: number;
}

const COMMAND_FLAGS: Record<string, ReadonlySet<string>> = {
  overview: new Set(["agents-only"]),
  pane: new Set(),
  wait: new Set(["since", "timeout"]),
  "suggest-answer": new Set(["prompt-id", "option", "options", "custom", "summary"]),
  "suggest-message": new Set(["text", "text-file", "summary"]),
  suggestions: new Set(["status"]),
};

/** Turns a command line into the one request it stands for; throws UsageError for a misuse. */
export function planCall(argv: readonly string[], readText: (path: string) => string = (path) => readFileSync(path === "-" ? 0 : path, "utf8")): Call {
  const command = argv[0];
  const flagsFor = command ? COMMAND_FLAGS[command] : undefined;
  if (!flagsFor) throw new UsageError(command ? `unknown command ${command}` : "a command is required");
  const { positional, flags } = parseArgs(argv, flagsFor);
  switch (command) {
    case "overview":
      exactly(positional, []);
      return { method: "GET", path: `/api/conductor/overview${flags.has("agents-only") ? "?agents_only=1" : ""}` };
    case "pane": {
      const [machineId, paneId] = exactly(positional, ["machine_id", "pane_id"]);
      return { method: "GET", path: `/api/conductor/pane?${new URLSearchParams({ machine_id: machineId!, pane_id: paneId! })}` };
    }
    case "wait": {
      exactly(positional, []);
      const since = flags.has("since") ? wholeNumber(flags.get("since")!, "since") : 0;
      const timeout = flags.has("timeout") ? wholeNumber(flags.get("timeout")!, "timeout") : 25;
      return { method: "GET", path: `/api/conductor/events?since=${since}&timeout=${timeout}`, waitMs: Math.min(timeout, 30) * 1000 + 10_000 };
    }
    case "suggest-answer": {
      const [machineId, paneId] = exactly(positional, ["machine_id", "pane_id"]);
      const forms = ["option", "options", "custom"].filter((name) => flags.has(name));
      if (forms.length !== 1) throw new UsageError("give exactly one of --option, --options, --custom");
      const answer = flags.has("option") ? { option_index: wholeNumber(flags.get("option")!, "option") }
        : flags.has("options") ? { option_indices: flags.get("options")!.split(",").map((part) => wholeNumber(part.trim(), "options")) }
        : { custom_text: flags.get("custom")! };
      return { method: "POST", path: "/api/conductor/suggestions", body: { machine_id: machineId, pane_id: paneId, kind: "answer", summary: required(flags, "summary"), prompt_id: required(flags, "prompt-id"), answer } };
    }
    case "suggest-message": {
      const [machineId, paneId] = exactly(positional, ["machine_id", "pane_id"]);
      if (flags.has("text") === flags.has("text-file")) throw new UsageError("give exactly one of --text, --text-file");
      let text = flags.get("text");
      if (text === undefined) {
        try { text = readText(flags.get("text-file")!); } catch (error) { throw new UsageError(`cannot read the text file: ${error instanceof Error ? error.message : String(error)}`); }
      }
      return { method: "POST", path: "/api/conductor/suggestions", body: { machine_id: machineId, pane_id: paneId, kind: "message", summary: required(flags, "summary"), text } };
    }
    case "suggestions": {
      exactly(positional, []);
      const status = flags.get("status");
      if (status !== undefined && !["open", "approved", "dismissed", "stale"].includes(status)) throw new UsageError("--status must be open, approved, dismissed or stale");
      return { method: "GET", path: `/api/conductor/suggestions${status ? `?status=${status}` : ""}` };
    }
  }
  throw new UsageError(`unknown command ${command}`);
}

/** Sends the request and answers the parsed JSON, or throws a CliFailure carrying the server's own code. */
export async function send(origin: string, token: string | undefined, call: Call, fetcher: typeof fetch = fetch): Promise<unknown> {
  const headers: Record<string, string> = {};
  if (token) headers["authorization"] = `Bearer ${token}`;
  if (call.method === "POST") { headers["content-type"] = "application/json"; headers[CONDUCTOR_HEADER] = "1"; }
  let response: Response;
  try {
    response = await fetcher(`${origin}${call.path}`, {
      method: call.method,
      headers,
      ...(call.body === undefined ? {} : { body: JSON.stringify(call.body) }),
      redirect: "error",
      signal: AbortSignal.timeout(call.waitMs ?? 30_000),
    });
  } catch (error) {
    throw new CliFailure("unreachable", `cannot reach the herdr web server at ${origin}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const raw = await response.text();
  let body: unknown;
  try { body = raw ? JSON.parse(raw) : null; } catch { throw new CliFailure("bad_answer", `the server answered ${response.status} with something that is not JSON`); }
  if (!response.ok) {
    const detail = (body as { error?: { code?: unknown; message?: unknown } } | null)?.error;
    throw new CliFailure(typeof detail?.code === "string" ? detail.code : `http_${response.status}`, typeof detail?.message === "string" ? detail.message : `the server answered ${response.status}`);
  }
  return body;
}

/** Runs one command line; the process exit code, with the output already written. */
export async function main(argv: readonly string[], env: Env = process.env, write: (stream: "out" | "err", line: string) => void = (stream, line) => { (stream === "out" ? process.stdout : process.stderr).write(`${line}\n`); }): Promise<number> {
  try {
    const call = planCall(argv);
    write("out", JSON.stringify(await send(resolveOrigin(env), env["HERDR_WEB_TOKEN"] || undefined, call)));
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      write("err", JSON.stringify({ error: { code: "usage", message: error.message } }));
      return 2;
    }
    if (error instanceof CliFailure) {
      write("err", JSON.stringify({ error: { code: error.code, message: error.message } }));
      return 1;
    }
    write("err", JSON.stringify({ error: { code: "internal", message: error instanceof Error ? error.message : String(error) } }));
    return 1;
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
