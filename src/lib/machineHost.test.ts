import { describe, expect, it } from "bun:test";
import { destinationHost, peerIsAdded } from "./machineHost.ts";

describe("destinationHost", () => {
  it("drops the user and IPv6 brackets and lower-cases", () => {
    expect(destinationHost("Me@Box.Example.TS.net")).toBe("box.example.ts.net");
    expect(destinationHost("me@[fd7a:115c::9]")).toBe("fd7a:115c::9");
    expect(destinationHost("devbox")).toBe("devbox");
  });
});

describe("peerIsAdded", () => {
  const peer = { address: "box.example.ts.net", dns_name: "box.example.ts.net", ips: ["100.64.0.9", "fd7a:115c::9"] };
  it("matches by MagicDNS name, by IPv4 or by bracketed IPv6", () => {
    expect(peerIsAdded(peer, new Set([destinationHost("me@BOX.example.ts.net")]))).toBe(true);
    expect(peerIsAdded(peer, new Set([destinationHost("me@100.64.0.9")]))).toBe(true);
    expect(peerIsAdded(peer, new Set([destinationHost("[fd7a:115c::9]")]))).toBe(true);
  });
  it("does not match another host", () => {
    expect(peerIsAdded(peer, new Set(["other.example.ts.net", "100.64.0.8"]))).toBe(false);
    expect(peerIsAdded({ address: "100.64.0.9", dns_name: "", ips: [] }, new Set([""]))).toBe(false);
  });
});
