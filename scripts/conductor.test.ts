import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CONDUCTOR_HEADER } from "../shared/conductor.ts";
import { CLI_PLACEHOLDER, conductorLaunch, splitCommand } from "./conductor-launch.ts";
import { CliFailure, main, parseArgs, planCall, resolveOrigin, send, UsageError } from "./conductor.ts";

describe("resolveOrigin", () => {
  const home = mkdtempSync(join(tmpdir(), "herdr-conductor-home-"));
  afterEach(() => rmSync(join(home, ".config"), { recursive: true, force: true }));

  it("takes a full URL first, then HERDR_WEB_PORT, then PORT, then the default", () => {
    expect(resolveOrigin({ HERDR_WEB_URL: "http://10.0.0.5:9000/", HERDR_WEB_PORT: "1" }, home)).toBe("http://10.0.0.5:9000");
    expect(resolveOrigin({ HERDR_WEB_PORT: "8123", PORT: "9" }, home)).toBe("http://127.0.0.1:8123");
    expect(resolveOrigin({ PORT: "9001" }, home)).toBe("http://127.0.0.1:9001");
    expect(resolveOrigin({}, home)).toBe("http://127.0.0.1:7317");
  });

  it("reads the port the plugin settled on when no port is set", () => {
    const state = join(home, ".config", "herdr-web-ui");
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, "plugin-port"), "27317\n");
    expect(resolveOrigin({}, home)).toBe("http://127.0.0.1:27317");
    expect(resolveOrigin({ HERDR_WEB_STATE_DIR: join(home, "elsewhere") }, home)).toBe("http://127.0.0.1:7317");
    expect(resolveOrigin({ HERDR_WEB_PORT: "nonsense" }, home)).toBe("http://127.0.0.1:27317");
  });

  it("reaches a server bound to every address through loopback, and brackets an IPv6 host", () => {
    expect(resolveOrigin({ HOST: "0.0.0.0", PORT: "7317" }, home)).toBe("http://127.0.0.1:7317");
    expect(resolveOrigin({ HOST: "::", PORT: "7317" }, home)).toBe("http://127.0.0.1:7317");
    expect(resolveOrigin({ HOST: "fd7a::1", PORT: "7317" }, home)).toBe("http://[fd7a::1]:7317");
    expect(resolveOrigin({ HOST: "100.64.0.2", PORT: "7317" }, home)).toBe("http://100.64.0.2:7317");
  });
});

describe("parseArgs", () => {
  it("reads flags with a value, with =, and as booleans, leaving the rest positional", () => {
    const parsed = parseArgs(["suggest-message", "local", "p_1", "--text", "--starts with dashes", "--summary=ok"], new Set(["text", "summary"]));
    expect(parsed.positional).toEqual(["local", "p_1"]);
    expect([...parsed.flags]).toEqual([["text", "--starts with dashes"], ["summary", "ok"]]);
    expect(parseArgs(["overview", "--agents-only"], new Set(["agents-only"])).flags.get("agents-only")).toBe("1");
  });

  it("refuses an unknown option, a repeated one and a missing value", () => {
    expect(() => parseArgs(["x", "--nope"], new Set(["a"]))).toThrow(UsageError);
    expect(() => parseArgs(["x", "--a", "1", "--a", "2"], new Set(["a"]))).toThrow("twice");
    expect(() => parseArgs(["x", "--a"], new Set(["a"]))).toThrow("needs a value");
    expect(() => parseArgs([], new Set())).toThrow("command");
  });
});

describe("planCall", () => {
  it("plans each read as a GET", () => {
    expect(planCall(["overview"])).toEqual({ method: "GET", path: "/api/conductor/overview" });
    expect(planCall(["overview", "--agents-only"]).path).toBe("/api/conductor/overview?agents_only=1");
    expect(planCall(["pane", "pc 2", "p/1"]).path).toBe("/api/conductor/pane?machine_id=pc+2&pane_id=p%2F1");
    expect(planCall(["suggestions"]).path).toBe("/api/conductor/suggestions");
    expect(planCall(["suggestions", "--status", "open"]).path).toBe("/api/conductor/suggestions?status=open");
  });

  it("plans a wait that outlasts the server's long poll", () => {
    expect(planCall(["wait"])).toMatchObject({ method: "GET", path: "/api/conductor/events?since=0&timeout=25", waitMs: 35_000 });
    expect(planCall(["wait", "--since", "12", "--timeout", "5"])).toMatchObject({ path: "/api/conductor/events?since=12&timeout=5", waitMs: 15_000 });
    expect(planCall(["wait", "--timeout", "300"]).waitMs).toBe(40_000);
  });

  it("plans an answer suggestion in each of its three forms, and only one", () => {
    const base = ["suggest-answer", "local", "p_1", "--prompt-id", "abc", "--summary", "Allow it"];
    expect(planCall([...base, "--option", "1"])).toEqual({ method: "POST", path: "/api/conductor/suggestions", body: { machine_id: "local", pane_id: "p_1", kind: "answer", summary: "Allow it", prompt_id: "abc", answer: { option_index: 1 } } });
    expect((planCall([...base, "--options", "0, 2"]).body as any).answer).toEqual({ option_indices: [0, 2] });
    expect((planCall([...base, "--custom", "use staging"]).body as any).answer).toEqual({ custom_text: "use staging" });
    expect(() => planCall(base)).toThrow("exactly one");
    expect(() => planCall([...base, "--option", "0", "--custom", "x"])).toThrow("exactly one");
    expect(() => planCall([...base, "--option", "first"])).toThrow("whole number");
    expect(() => planCall(["suggest-answer", "local", "p_1", "--option", "0", "--summary", "s"])).toThrow("--prompt-id");
    expect(() => planCall(["suggest-answer", "local", "--prompt-id", "a", "--option", "0", "--summary", "s"])).toThrow("<machine_id> <pane_id>");
  });

  it("plans a message suggestion from text or from a file", () => {
    const read = (path: string) => path === "-" ? "from stdin" : `contents of ${path}`;
    expect(planCall(["suggest-message", "local", "p_1", "--text", "Run the tests", "--summary", "Next"], read).body).toEqual({ machine_id: "local", pane_id: "p_1", kind: "message", summary: "Next", text: "Run the tests" });
    expect((planCall(["suggest-message", "local", "p_1", "--text-file", "-", "--summary", "Next"], read).body as any).text).toBe("from stdin");
    expect(() => planCall(["suggest-message", "local", "p_1", "--summary", "Next"], read)).toThrow("exactly one");
    expect(() => planCall(["suggest-message", "local", "p_1", "--text", "a", "--text-file", "b", "--summary", "Next"], read)).toThrow("exactly one");
    expect(() => planCall(["suggest-message", "local", "p_1", "--text-file", "x", "--summary", "s"], () => { throw new Error("ENOENT"); })).toThrow("cannot read the text file");
  });

  it("offers no command that sends to a pane", () => {
    for (const name of ["send", "input", "keys", "answer", "type", "approve"]) expect(() => planCall([name, "local", "p_1"])).toThrow("unknown command");
  });

  it("refuses a command it does not know and a status it does not know", () => {
    expect(() => planCall([])).toThrow("required");
    expect(() => planCall(["suggestions", "--status", "all"])).toThrow("--status");
    expect(() => planCall(["overview", "extra"])).toThrow("no arguments");
  });
});

describe("send and main against a server", () => {
  const seen: Array<{ method: string; url: string; headers: Headers; body: string }> = [];
  let server: ReturnType<typeof Bun.serve> | undefined;
  afterEach(() => { server?.stop(true); server = undefined; seen.length = 0; });
  const serve = (respond: (path: string) => Response) => {
    server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
      seen.push({ method: request.method, url: request.url, headers: request.headers, body: await request.text() });
      return respond(new URL(request.url).pathname);
    } });
    return `http://127.0.0.1:${server.port}`;
  };

  it("sends the bearer token on a read and the conductor header on a post, and returns the JSON", async () => {
    const origin = serve(() => Response.json({ ok: true }));
    expect(await send(origin, "secret", { method: "GET", path: "/api/conductor/overview" })).toEqual({ ok: true });
    expect(await send(origin, undefined, { method: "POST", path: "/api/conductor/suggestions", body: { a: 1 } })).toEqual({ ok: true });
    expect(seen[0]!.headers.get("authorization")).toBe("Bearer secret");
    expect(seen[0]!.headers.get(CONDUCTOR_HEADER)).toBeNull();
    expect(seen[1]!.headers.get("authorization")).toBeNull();
    expect(seen[1]!.headers.get(CONDUCTOR_HEADER)).toBe("1");
    expect(seen[1]!.body).toBe('{"a":1}');
  });

  it("turns the server's refusal into a failure with its own code", async () => {
    const origin = serve(() => Response.json({ error: { code: "prompt_changed", message: "different prompt" } }, { status: 409 }));
    await expect(send(origin, undefined, { method: "GET", path: "/x" })).rejects.toMatchObject({ code: "prompt_changed", message: "different prompt" });
    const plain = serve(() => new Response("<html>nope</html>", { status: 502 }));
    await expect(send(plain, undefined, { method: "GET", path: "/x" })).rejects.toMatchObject({ code: "bad_answer" });
  });

  it("reports an unreachable server honestly", async () => {
    const closed = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
    const origin = `http://127.0.0.1:${closed.port}`;
    closed.stop(true);
    const error = await send(origin, undefined, { method: "GET", path: "/x" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CliFailure);
    expect((error as CliFailure).code).toBe("unreachable");
  });

  it("main prints compact JSON and exits 0, prints the error envelope and exits 1, or 2 for misuse", async () => {
    const origin = serve((path) => path.endsWith("/overview") ? Response.json({ seq: 3, machines: [] }) : Response.json({ error: { code: "no_prompt", message: "the pane shows no prompt to answer" } }, { status: 409 }));
    const out: string[] = [];
    const err: string[] = [];
    const write = (stream: "out" | "err", line: string) => { (stream === "out" ? out : err).push(line); };
    const env = { HERDR_WEB_URL: origin, HERDR_WEB_TOKEN: "t" };
    expect(await main(["overview"], env, write)).toBe(0);
    expect(out).toEqual(['{"seq":3,"machines":[]}']);
    expect(await main(["suggest-answer", "local", "p_1", "--prompt-id", "a", "--option", "0", "--summary", "s"], env, write)).toBe(1);
    expect(JSON.parse(err[0]!)).toEqual({ error: { code: "no_prompt", message: "the pane shows no prompt to answer" } });
    expect(await main(["bogus"], env, write)).toBe(2);
    expect(JSON.parse(err[1]!).error.code).toBe("usage");
    expect(await main(["overview"], { HERDR_WEB_URL: "http://127.0.0.1:1" }, write)).toBe(1);
    expect(JSON.parse(err[2]!).error.code).toBe("unreachable");
  });
});

describe("the conductor pane's launch", () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-conductor-root-"));
  mkdirSync(join(root, "conductor"), { recursive: true });
  writeFileSync(join(root, "conductor", "CONDUCTOR.md"), `Run ${CLI_PLACEHOLDER} overview, then ${CLI_PLACEHOLDER} wait.\n`);

  it("splits a command into words, honouring quotes", () => {
    expect(splitCommand("claude")).toEqual(["claude"]);
    expect(splitCommand(`claude --model "claude opus" --flag='a b'  x`)).toEqual(["claude", "--model", "claude opus", "--flag=a b", "x"]);
    expect(splitCommand(`say ""`)).toEqual(["say", ""]);
    expect(() => splitCommand(`claude "open`)).toThrow("unclosed");
  });

  it("starts Claude Code by default with the brief as its first message, the toolkit's real path written in", () => {
    const launch = conductorLaunch({}, root, "/opt/bun/bin/bun");
    expect(launch.cwd).toBe(join(root, "conductor"));
    expect(launch.argv[0]).toBe("claude");
    expect(launch.argv).toHaveLength(2);
    expect(launch.argv[1]).toBe(`Run /opt/bun/bin/bun ${join(root, "scripts", "conductor.ts")} overview, then /opt/bun/bin/bun ${join(root, "scripts", "conductor.ts")} wait.\n`);
  });

  it("takes the command from HERDR_WEB_CONDUCTOR_CMD and quotes a path with spaces", () => {
    const launch = conductorLaunch({ HERDR_WEB_CONDUCTOR_CMD: "codex --yolo" }, root, "/Applications/My Bun/bun");
    expect(launch.argv.slice(0, 2)).toEqual(["codex", "--yolo"]);
    expect(launch.argv[2]).toContain('"/Applications/My Bun/bun"');
    expect(conductorLaunch({ HERDR_WEB_CONDUCTOR_CMD: "   " }, root, "bun").argv[0]).toBe("claude");
  });

  it("fails clearly when the brief is missing", () => {
    expect(() => conductorLaunch({}, join(root, "nowhere"), "bun")).toThrow();
  });
});
