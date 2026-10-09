import { describe, expect, it, spyOn } from "bun:test";
import { decideAccess, type AccessInput } from "./access.ts";
import { parseSoleTailnetLogin, parseTailscalePeers, TailscaleUnavailableError, parseTailscale, parseTailscaleIp, TailnetIdentitySource, type TailnetIdentity } from "./tailscale.ts";

const status = (state = "Running", dns = "pc.example.ts.net.") => JSON.stringify({ BackendState: state, Self: { DNSName: dns } });
/** a `tailscale serve status --json` document: listeners by port, and one "/" proxy per host:port */
const serve = (tcp: Record<string, { HTTPS?: boolean; HTTP?: boolean }>, web: Record<string, string>) =>
  JSON.stringify({ TCP: tcp, Web: Object.fromEntries(Object.entries(web).map(([key, proxy]) => [key, { Handlers: { "/": { Proxy: proxy } } }])) });

/** a `tailscale status --json` document: this PC, then one peer per `[userId, tags]`, as the real one is shaped; `User` names each login by id */
const tailnet = (self: [number, string[] | undefined], peers: [number, string[] | undefined][] = [], state = "Running") => JSON.stringify({
  BackendState: state,
  Self: { DNSName: "pc.example.ts.net.", UserID: self[0], ...(self[1] ? { Tags: self[1] } : {}) },
  Peer: Object.fromEntries(peers.map(([userId, tags], index) => [`key${index}`, { DNSName: `peer${index}.example.ts.net.`, UserID: userId, ...(tags ? { Tags: tags } : {}) }])),
  User: Object.fromEntries([self[0], ...peers.map(([userId]) => userId)].map((userId) => [String(userId), { LoginName: `user${userId}@example.com` }])),
});

/** a status as Tailscale writes it, with ids past 2^53: this PC's user, and one peer owned by `peer` */
const BIG_ID = "15633668397603135";
const NEXT_ID = "15633668397603136";
const bigIds = (peer: string) => `{"BackendState":"Running","Self":{"UserID":${BIG_ID}},"Peer":{"k":{"UserID":${peer}}},"User":{"${BIG_ID}":{"LoginName":"me@example.com"},"${NEXT_ID}":{"LoginName":"them@example.com"}}}`;

describe("parseSoleTailnetLogin", () => {
  it("names the login a tailnet one login owns, phones and offline peers included", () => {
    // the shape of the reported tailnet: this Mac plus six of the owner's own untagged devices
    expect(parseSoleTailnetLogin(tailnet([7511875822626835, undefined], Array.from({ length: 6 }, () => [7511875822626835, undefined] as [number, undefined])))).toBe("user7511875822626835@example.com");
    expect(parseSoleTailnetLogin(tailnet([42, undefined]))).toBe("user42@example.com");
    // an id past 2^53 names its login by the digits written, not by the double they round to
    expect(parseSoleTailnetLogin(bigIds(BIG_ID))).toBe("me@example.com");
  });

  it("names no login where a second login or any tag exists", () => {
    expect(parseSoleTailnetLogin(tailnet([42, undefined], [[42, undefined], [43, undefined]]))).toBeNull();
    expect(parseSoleTailnetLogin(tailnet([42, undefined], [[42, undefined], [42, ["tag:ci"]]]))).toBeNull();
    expect(parseSoleTailnetLogin(tailnet([42, ["tag:server"]], [[42, undefined]]))).toBeNull();
    // two logins whose ids round to the same double are still two logins
    expect(parseSoleTailnetLogin(bigIds(NEXT_ID))).toBeNull();
    // a peer the status names no owner for is not proof of anything
    expect(parseSoleTailnetLogin(JSON.stringify({ BackendState: "Running", Self: { UserID: 42 }, Peer: { k: { DNSName: "p.example.ts.net." } } }))).toBeNull();
  });

  it("names no login the status does not state, nor from a status it could not read, or a daemon that is not running", () => {
    expect(parseSoleTailnetLogin(JSON.stringify({ BackendState: "Running", Self: { UserID: 42 } }))).toBeNull();
    expect(parseSoleTailnetLogin(tailnet([42, undefined], [], "Stopped"))).toBeNull();
    expect(parseSoleTailnetLogin(tailnet([42, undefined], [], "NeedsLogin"))).toBeNull();
    expect(parseSoleTailnetLogin(JSON.stringify({ BackendState: "Running" }))).toBeNull();
    expect(parseSoleTailnetLogin("not json")).toBeNull();
    expect(parseSoleTailnetLogin(null)).toBeNull();
  });
});

/** the access decision for a no-login request that `tailscale serve` forwarded, with the operator's serve-only switch on */
const HOST = "pc.example.ts.net";
const serveRequest = (identity: TailnetIdentity, host: string | null = HOST) => {
  const input: AccessInput = { loopback: true, forwarded: true, funnel: false, tailscaleLogin: null, host, tokenMatched: false, device: null, ...identity, serveOnly: true, tokenConfigured: false, gated: false };
  const access = decideAccess(input);
  return access.level === "full" ? access.via : `refused:${access.reason}`;
};

/** a source whose cache holds `status` (none, when undefined) as read `minutesAgo` minutes ago, and whose reads from then on answer `read` */
async function withCachedStatus(status: string | null | undefined, minutesAgo: number, read: () => Promise<string | null>, body: (source: TailnetIdentitySource) => Promise<void>): Promise<void> {
  let warm = status !== undefined ? status : null;
  const source = new TailnetIdentitySource(async () => {
    if (warm !== null) { const first = warm; warm = null; return first; }
    return read();
  });
  if (status !== undefined) await source.freshIdentity(null);
  const start = Date.now();
  const clock = spyOn(Date, "now").mockImplementation(() => start + minutesAgo * 60_000);
  try { await body(source); } finally { clock.mockRestore(); }
}

describe("freshIdentity", () => {
  it("refuses the owner's grant once a node is tagged, even inside the cache's TTL", async () => {
    for (const minutesAgo of [2, 6]) {
      await withCachedStatus(tailnet([42, undefined]), minutesAgo, async () => tailnet([42, undefined], [[42, ["tag:server"]]]), async (source) => {
        expect(serveRequest(await source.freshIdentity(HOST))).toBe("refused:pairing_required");
      });
    }
  });

  it("grants the owner when the fresh read proves one login owns the tailnet, from a warm sole cache or an empty one", async () => {
    for (const status of [tailnet([42, undefined]), undefined]) {
      await withCachedStatus(status, 2, async () => tailnet([42, undefined]), async (source) => {
        expect(serveRequest(await source.freshIdentity(HOST))).toBe("tailscale");
      });
    }
  });

  it("withdraws the sole-login proof when the fresh read fails, and keeps pairing the stranger", async () => {
    await withCachedStatus(tailnet([42, undefined]), 2, async () => null, async (source) => {
      expect(serveRequest(await source.freshIdentity(HOST))).toBe("refused:pairing_required");
    });
  });

  it("shares one status read among concurrent owner grants", async () => {
    let reads = 0;
    await withCachedStatus(tailnet([42, undefined]), 0, async () => { reads += 1; await new Promise((done) => setTimeout(done, 5)); return tailnet([42, undefined]); }, async (source) => {
      const identities = await Promise.all([1, 2, 3, 4, 5].map(() => source.freshIdentity(HOST)));
      expect(identities.map((identity) => serveRequest(identity))).toEqual(["tailscale", "tailscale", "tailscale", "tailscale", "tailscale"]);
      expect(reads).toBe(1);
    });
  });

  it("reads once for a tagged node's first request, and its later polls pair without reading", async () => {
    let reads = 0;
    await withCachedStatus(tailnet([42, undefined]), 0, async () => { reads += 1; return tailnet([42, undefined], [[42, ["tag:server"]]]); }, async (source) => {
      expect(serveRequest(await source.freshIdentity(HOST))).toBe("refused:pairing_required");
      expect(serveRequest(await source.freshIdentity(HOST))).toBe("refused:pairing_required");
      expect(reads).toBe(1);
    });
  });

  it("reads again after a status the daemon had not finished writing, so a Mac that wakes grants on its next request", async () => {
    await withCachedStatus(tailnet([42, undefined], [], "Starting"), 2, async () => tailnet([42, undefined]), async (source) => {
      expect(serveRequest(await source.freshIdentity(HOST))).toBe("tailscale");
    });
  });

  it("keeps a negative a settled status itself states, once the daemon finished coming up", async () => {
    let reads = 0;
    await withCachedStatus(tailnet([42, undefined], [], "Starting"), 2, async () => { reads += 1; return tailnet([42, undefined], [[42, ["tag:server"]]]); }, async (source) => {
      expect(serveRequest(await source.freshIdentity(HOST))).toBe("refused:pairing_required");
      expect(serveRequest(await source.freshIdentity(HOST))).toBe("refused:pairing_required");
      expect(reads).toBe(1);
    });
  });
});

describe("the owner's grant read, by Host and by outcome", () => {
  it("answers a request addressed to another name from the cache, without reading the status", async () => {
    let reads = 0;
    await withCachedStatus(tailnet([42, undefined]), 0, async () => { reads += 1; return tailnet([42, undefined]); }, async (source) => {
      expect(serveRequest(await source.freshIdentity("evil.example"), "evil.example")).toBe("refused:pairing_required");
      expect(reads).toBe(0);
    });
  });

  it("grants on the read after a failed one, and pairs while the read before it failed", async () => {
    let call = 0;
    await withCachedStatus(tailnet([42, undefined]), 0, async () => (call += 1) === 1 ? null : tailnet([42, undefined]), async (source) => {
      expect(serveRequest(await source.freshIdentity(HOST))).toBe("refused:pairing_required");
      expect(serveRequest(await source.freshIdentity(HOST))).toBe("tailscale");
    });
  });

  it("pairs on the retry when the read after a failed one finds a node tagged", async () => {
    let call = 0;
    await withCachedStatus(tailnet([42, undefined]), 0, async () => (call += 1) === 1 ? null : tailnet([42, undefined], [[42, ["tag:server"]]]), async (source) => {
      expect(serveRequest(await source.freshIdentity(HOST))).toBe("refused:pairing_required");
      expect(serveRequest(await source.freshIdentity(HOST))).toBe("refused:pairing_required");
      expect(call).toBe(2);
    });
  });
});

describe("parseTailscaleIp", () => {
  it("picks this PC's IPv4 tailnet address, and nothing when there is none", () => {
    expect(parseTailscaleIp(JSON.stringify({ Self: { TailscaleIPs: ["fd7a:115c:a1e0::1", "100.64.0.7"] } }))).toBe("100.64.0.7");
    expect(parseTailscaleIp(JSON.stringify({ Self: { TailscaleIPs: ["fd7a:115c:a1e0::1"] } }))).toBeNull();
    expect(parseTailscaleIp(JSON.stringify({ Self: {} }))).toBeNull();
    expect(parseTailscaleIp("not json")).toBeNull();
    expect(parseTailscaleIp(null)).toBeNull();
  });
});

describe("parseTailscale", () => {
  it("reports a PC without the CLI", () => {
    expect(parseTailscale(null, 7317)).toEqual({ state: "missing", dns_name: null, serving_url: null, serve_command: null, serve_url: null });
  });

  it("reports a daemon that did not answer, or is not connected", () => {
    for (const output of [{ status: null, serve: null }, { status: "not json", serve: null }, { status: status("NeedsLogin"), serve: null }, { status: status("Stopped"), serve: serve({}, {}) }]) {
      expect(parseTailscale(output, 7317).state).toBe("stopped");
      expect(parseTailscale(output, 7317).serve_command).toBeNull();
    }
  });

  it("finds the HTTPS listener that already proxies this server, and strips the DNS dot", () => {
    const output = { status: status(), serve: serve(
      { "443": { HTTPS: true }, "17317": { HTTPS: true } },
      { "pc.example.ts.net:443": "http://127.0.0.1:8787", "pc.example.ts.net:17317": "http://127.0.0.1:7317" },
    ) };
    expect(parseTailscale(output, 7317)).toEqual({ state: "running", dns_name: "pc.example.ts.net", serving_url: "https://pc.example.ts.net:17317", serve_command: null, serve_url: null });
  });

  it("names no port for 443, and accepts localhost as this machine", () => {
    const output = { status: status(), serve: serve({ "443": { HTTPS: true } }, { "pc.example.ts.net:443": "http://localhost:7317/" }) };
    expect(parseTailscale(output, 7317).serving_url).toBe("https://pc.example.ts.net");
  });

  it("suggests 443 when nothing is served, even when serve status failed", () => {
    for (const serveOutput of [null, serve({}, {})]) {
      expect(parseTailscale({ status: status(), serve: serveOutput }, 7317)).toEqual({
        state: "running", dns_name: "pc.example.ts.net", serving_url: null,
        serve_command: "tailscale serve --bg --https=443 http://127.0.0.1:7317", serve_url: "https://pc.example.ts.net",
      });
    }
  });

  it("skips the ports other services already use", () => {
    const output = { status: status(), serve: serve({ "443": { HTTPS: true }, "8443": { HTTPS: true } }, { "pc.example.ts.net:443": "http://127.0.0.1:8787", "pc.example.ts.net:8443": "http://127.0.0.1:3019/status" }) };
    const access = parseTailscale(output, 7317);
    expect(access.serving_url).toBeNull();
    expect(access.serve_command).toBe("tailscale serve --bg --https=7317 http://127.0.0.1:7317");
    expect(access.serve_url).toBe("https://pc.example.ts.net:7317");
  });

  it("does not count an HTTP listener, another path or another port as serving this server", () => {
    const output = { status: status(), serve: JSON.stringify({
      TCP: { "80": { HTTP: true }, "8443": { HTTPS: true }, "9000": { HTTPS: true } },
      Web: {
        "pc.example.ts.net:80": { Handlers: { "/": { Proxy: "http://127.0.0.1:7317" } } },
        "pc.example.ts.net:8443": { Handlers: { "/ui": { Proxy: "http://127.0.0.1:7317" } } },
        "pc.example.ts.net:9000": { Handlers: { "/": { Proxy: "http://127.0.0.1:7318" } } },
      },
    }) };
    const access = parseTailscale(output, 7317);
    expect(access.serving_url).toBeNull();
    expect(access.serve_command).toBe("tailscale serve --bg --https=443 http://127.0.0.1:7317");
  });

  it("gives a command but no address when MagicDNS reports no name", () => {
    const access = parseTailscale({ status: status("Running", ""), serve: null }, 7317);
    expect(access.dns_name).toBeNull();
    expect(access.serve_command).toBe("tailscale serve --bg --https=443 http://127.0.0.1:7317");
    expect(access.serve_url).toBeNull();
  });
});

describe("parseTailscalePeers", () => {
  const status = (peers: Record<string, unknown>, backend = "Running") => JSON.stringify({ BackendState: backend, Self: { DNSName: "me.example.ts.net.", HostName: "me", TailscaleIPs: ["100.64.0.1"] }, Peer: peers });

  it("lists peers without this PC, strips the trailing dot and sorts online first, then by name", () => {
    const parsed = parseTailscalePeers(status({
      a: { DNSName: "zeta.example.ts.net.", HostName: "zeta", OS: "linux", Online: true, TailscaleIPs: ["100.64.0.2"] },
      b: { DNSName: "alpha.example.ts.net.", HostName: "alpha", OS: "macOS", Online: false, TailscaleIPs: ["100.64.0.3"], Tags: ["tag:ci"] },
      c: { DNSName: "beta.example.ts.net.", HostName: "beta", OS: "linux", Online: true, TailscaleIPs: ["100.64.0.4"] },
    }));
    expect(parsed.state).toBe("running");
    expect(parsed.peers.map((peer) => peer.name)).toEqual(["beta", "zeta", "alpha"]);
    expect(parsed.peers[0]).toEqual({ name: "beta", dns_name: "beta.example.ts.net", address: "beta.example.ts.net", os: "linux", online: true, tags: [] });
    expect(parsed.peers[2]!.tags).toEqual(["tag:ci"]);
    expect(parsed.peers.some((peer) => peer.name === "me")).toBe(false);
  });

  it("falls back to the first IPv4 address when a peer has no DNS name", () => {
    const [peer] = parseTailscalePeers(status({ a: { HostName: "box", Online: true, TailscaleIPs: ["fd7a:115c::1", "100.64.0.9"] } })).peers;
    expect(peer).toMatchObject({ name: "box", dns_name: "", address: "100.64.0.9" });
  });

  it("drops a peer whose address could reach ssh as an option or shell syntax", () => {
    const parsed = parseTailscalePeers(status({
      a: { DNSName: "-oProxyCommand=evil.example.ts.net.", HostName: "x", Online: true },
      b: { DNSName: "a b;rm.example.ts.net.", HostName: "y", Online: true },
      c: { HostName: "no-address", Online: true, TailscaleIPs: [] },
      d: { DNSName: "ok.example.ts.net.", HostName: "ok", Online: true },
    }));
    expect(parsed.peers.map((peer) => peer.name)).toEqual(["ok"]);
  });

  it("reports a stopped Tailscale with no peers", () => {
    expect(parseTailscalePeers(status({ a: { DNSName: "x.example.ts.net." } }, "Stopped"))).toEqual({ state: "stopped", peers: [] });
  });

  it("throws, rather than answering an empty list, when the status is missing or not JSON", () => {
    expect(() => parseTailscalePeers(null)).toThrow(TailscaleUnavailableError);
    expect(() => parseTailscalePeers("not json")).toThrow(TailscaleUnavailableError);
  });

  it("caps the list", () => {
    const many = Object.fromEntries(Array.from({ length: 250 }, (_, i) => [String(i), { DNSName: `h${i}.example.ts.net.`, HostName: `h${i}`, Online: true }]));
    expect(parseTailscalePeers(status(many)).peers).toHaveLength(200);
  });
});
