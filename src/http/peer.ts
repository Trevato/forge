/**
 * Who sent a request, as far as the forge can tell: the socket's peer, set
 * by the listener (`server.requestIP`), or — behind a proxy on this host —
 * the hop it reports. Good enough to key a limit for strangers (OAuth
 * registration, reports from outside); never an identity. A forwarded
 * address is a claim, so every limit keyed on it has a whole-forge cap
 * beside it.
 */

const peers = new WeakMap<Request, string>();

export const notePeer = (request: Request, address: string | undefined): void => {
  if (address !== undefined) peers.set(request, address);
};

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export function clientAddress(request: Request): string {
  const peer = peers.get(request) ?? "unknown";
  if (!LOOPBACK.has(peer)) return peer;
  const hop = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return hop !== undefined && hop !== "" ? hop.slice(0, 64) : peer;
}
