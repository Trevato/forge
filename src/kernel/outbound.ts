/**
 * The one guard for anything the forge fetches on somebody else's say-so.
 * The name is resolved here, every answer is judged, and the request goes to
 * the address that was judged — the name stays in `Host` and as the TLS
 * server name — so a second lookup cannot hand back a different answer.
 * Redirects are never followed: a 302 is an answer, not an instruction.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { err, ok, type Result } from "./result.ts";
import { addressBytes, inCidrs, parseCidr, type Cidr } from "./cidr.ts";

const REFUSED = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "224.0.0.0/4",
  "::/128",
  "::1/128",
  "fc00::/7",
  "fe80::/10",
  "ff00::/8",
].map((c) => parseCidr(c)!) satisfies Cidr[];

/** Is this address one a public service would never have? Unparseable counts. */
export function isRefusedAddress(address: string): boolean {
  return addressBytes(address) === undefined || inCidrs(address, REFUSED);
}

export type Resolve = (host: string) => Promise<readonly string[]>;

export interface OutboundOptions {
  /** Name → addresses. Defaults to the system resolver. Injected by tests. */
  resolve?: Resolve;
  /** Addresses exempt from the refusal list. For tests only; never read from the environment. */
  allow?: readonly string[];
  /**
   * Exact host names an admin vouched for: they may resolve to a private
   * address. Origins pass this; webhooks never do.
   */
  trusted?: readonly string[];
  /** Permit plain http. For tests only; never read from the environment. */
  plain?: boolean;
  /** Extra trusted CA certificate (PEM) for https. For tests only. */
  ca?: string | undefined;
}

const systemResolve: Resolve = async (host) =>
  (await lookup(host, { all: true })).map((a) => a.address);

export const REFUSED_SENTENCE = "refused: private address";
export const PLAIN_SENTENCE = "refused: not https";

export class RefusedError extends Error {
  constructor(sentence = REFUSED_SENTENCE) {
    super(sentence);
  }
}

/** The addresses a host resolves to, or an error when any one of them is private. */
export async function vetHost(
  host: string,
  options: OutboundOptions = {},
): Promise<Result<string[], "refused" | "unresolved">> {
  const bare = host.replace(/^\[|\]$/g, "");
  let found: readonly string[];
  if (isIP(bare) !== 0) found = [bare];
  else {
    try {
      found = await (options.resolve ?? systemResolve)(bare);
    } catch {
      return err("unresolved");
    }
  }
  if (found.length === 0) return err("unresolved");
  if (
    isIP(bare) === 0 &&
    (options.trusted ?? []).includes(bare.toLowerCase())
  )
    return ok([...found]);
  const allow = options.allow ?? [];
  if (found.some((a) => isRefusedAddress(a) && !allow.includes(a)))
    return err("refused");
  return ok([...found]);
}

/** fetch() to the vetted address; throws RefusedError when the host is private. */
export async function outboundFetch(
  url: string,
  init: RequestInit = {},
  options: OutboundOptions = {},
): Promise<Response> {
  const target = new URL(url);
  if (target.protocol !== "https:" && !options.plain)
    throw new RefusedError(PLAIN_SENTENCE);
  const vetted = await vetHost(target.hostname, options);
  if (!vetted.ok) {
    if (vetted.error === "refused") throw new RefusedError();
    throw new Error("unresolved host");
  }
  const ip = vetted.value[0]!;
  const name = target.hostname.replace(/^\[|\]$/g, "");
  const pinned = new URL(url);
  pinned.hostname = ip.includes(":") ? `[${ip}]` : ip;
  const headers = new Headers(init.headers);
  headers.set("host", target.host);
  return fetch(pinned, {
    ...init,
    headers,
    redirect: "manual",
    ...(target.protocol === "https:"
      ? { tls: { serverName: name, ...(options.ca ? { ca: options.ca } : {}) } }
      : {}),
  } satisfies BunFetchRequestInit);
}
