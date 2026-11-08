/**
 * Who sent a request, as far as the forge can tell: good enough to key a
 * limit for strangers (OAuth registration, reports from outside) and to
 * record where a signup came from; never an identity.
 *
 * The socket's peer is the answer unless that peer is a proxy the operator
 * trusts. With `FORGE_TRUSTED_PROXIES` set, those ranges are the proxies and
 * nothing else is — not even this machine, where every app and crew run is
 * a process that could call the forge and claim to be anyone. Unset, this
 * machine alone may say (a local proxy in development). From a trusted
 * proxy, `X-Forwarded-For` is walked from the right, past each trusted hop,
 * to the first address no trusted proxy vouches for; the left end is
 * whatever the client wrote and is never read as such. A named header the
 * edge sets (`FORGE_CLIENT_IP_HEADER`, e.g. Cloudflare's `cf-connecting-ip`)
 * is read first, and only from a listed proxy. Every limit keyed on this
 * keeps a whole-forge cap beside it, and keys an IPv6 client by its /64.
 */

import { addressBytes, inCidrs, type Cidr } from "../kernel/cidr.ts";

export interface ProxyTrust {
  /** Ranges whose requests may say who they carry. */
  readonly proxies: readonly Cidr[];
  /** A header a trusted edge sets to the client's address, read first. */
  readonly header?: string;
}

const NO_TRUST: ProxyTrust = { proxies: [] };

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

const isAddress = (text: string): boolean => addressBytes(text) !== undefined;

/** The client a request came from, given its socket peer and headers. */
export function resolveClient(
  peer: string | undefined,
  headers: Headers,
  trust: ProxyTrust,
): string {
  if (peer === undefined) return "unknown";
  const listed = trust.proxies.length > 0;
  const trusted = (address: string): boolean =>
    listed ? inCidrs(address, trust.proxies) : LOOPBACK.has(address);
  if (!trusted(peer)) return peer;
  if (trust.header !== undefined && listed) {
    const named = headers.get(trust.header)?.trim() ?? "";
    if (isAddress(named)) return named;
  }
  const hops = (headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter((h) => h !== "");
  let client = peer;
  for (let i = hops.length - 1; i >= 0 && trusted(client); i--) {
    const hop = hops[i]!;
    if (!isAddress(hop)) break;
    client = hop;
  }
  return client.slice(0, 64);
}

const clients = new WeakMap<Request, string>();
const internals = new WeakSet<Request>();
const edged = new WeakSet<Request>();

/** Headers a proxy names a client in. The tunnel always sets its own, so no stranger can leave them all out. */
const CLIENT_HEADERS = ["cf-connecting-ip", "x-forwarded-for", "x-real-ip", "forwarded"];

/** The forge asking itself: from loopback or a trusted proxy, with no client named. */
export function isInternalPeer(
  peer: string | undefined,
  headers: Headers,
  trust: ProxyTrust,
): boolean {
  if (peer === undefined) return false;
  if (!LOOPBACK.has(peer) && !inCidrs(peer, trust.proxies)) return false;
  if (trust.header !== undefined && headers.has(trust.header)) return false;
  return !CLIENT_HEADERS.some((h) => headers.has(h));
}

/** The listener notes each request's client once, as it arrives. */
export const notePeer = (
  request: Request,
  address: string | undefined,
  trust: ProxyTrust = NO_TRUST,
): void => {
  clients.set(request, resolveClient(address, request.headers, trust));
  if (isInternalPeer(address, request.headers, trust)) internals.add(request);
  else if (address !== undefined && (trust.proxies.length > 0 ? inCidrs(address, trust.proxies) : LOOPBACK.has(address)))
    edged.add(request);
};

/** The request came through a proxy the operator trusts, so the headers an edge adds (bot score, country) are its, not the client's. */
export const wasViaEdge = (request: Request): boolean => edged.has(request);

export const wasInternal = (request: Request): boolean => internals.has(request);

export function clientAddress(request: Request): string {
  return clients.get(request) ?? "unknown";
}

/**
 * The key a limit counts a client under: its address, or for IPv6 its /64 —
 * one subscriber's whole allocation, which a single client can walk through
 * an address at a time.
 */
export function bucketOf(address: string): string {
  const bytes = addressBytes(address);
  if (bytes === undefined || bytes.length === 4) return address;
  const words: string[] = [];
  for (let i = 0; i < 8; i += 2)
    words.push(((bytes[i]! << 8) | bytes[i + 1]!).toString(16));
  return `${words.join(":")}::/64`;
}

/** The limit key for this request's client (\`bucketOf\`). */
export const clientBucket = (request: Request): string =>
  bucketOf(clientAddress(request));

/** A request rebuilt from another (an idempotent replay) keeps its client. */
export const carryPeer = (from: Request, to: Request): void => {
  const client = clients.get(from);
  if (client !== undefined) clients.set(to, client);
};
