/** The host of an SSH destination: `user@` and IPv6 brackets removed, lower case, for comparing machines. */
export function destinationHost(destination: string): string {
  return destination.slice(destination.lastIndexOf("@") + 1).replace(/^\[|\]$/g, "").toLowerCase();
}

/** Is this tailnet peer already a PC, registered by its MagicDNS name, its address or any of its Tailscale IPs? */
export function peerIsAdded(peer: { address: string; dns_name: string; ips: string[] }, addedHosts: ReadonlySet<string>): boolean {
  return [peer.address, peer.dns_name, ...peer.ips].some((host) => host !== "" && addedHosts.has(destinationHost(host)));
}
