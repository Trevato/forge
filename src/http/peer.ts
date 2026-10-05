/**
 * Who sent a request, as far as the forge can tell: good enough to key a
 * limit for strangers (OAuth registration, reports from outside) and to
 * record where a signup came from; never an identity.
 *
 * The socket's peer is the answer unless that peer is a proxy the operator
 * trusts — this machine, or a range in `FORGE_TRUSTED_PROXIES` (the ingress
 * in front of a hosted forge). Only then are forwarded headers read: a named
 * header the edge sets (`FORGE_CLIENT_IP_HEADER`, e.g. Cloudflare's
 * `cf-connecting-ip`), else `X-Forwarded-For` walked from the right, past
 * each trusted hop, to the first address no trusted proxy vouches for. The
 * left end of that header is whatever the client wrote and is never read
 * as such. Every limit keyed on this keeps a whole-forge cap beside it.
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
  const trusted = (address: string): boolean =>
    LOOPBACK.has(address) || inCidrs(address, trust.proxies);
  if (!trusted(peer)) return peer;
  if (trust.header !== undefined) {
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

/** The listener notes each request's client once, as it arrives. */
export const notePeer = (
  request: Request,
  address: string | undefined,
  trust: ProxyTrust = NO_TRUST,
): void => {
  clients.set(request, resolveClient(address, request.headers, trust));
};

export function clientAddress(request: Request): string {
  return clients.get(request) ?? "unknown";
}
