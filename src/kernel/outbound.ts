/**
 * The one guard for anything the forge fetches on somebody else's say-so.
 * The name is resolved here, every answer is judged, and the request goes to
 * the address that was judged — the name stays in `Host` and as the TLS
 * server name — so a second lookup cannot hand back a different answer.
 * Redirects are never followed: a 302 is an answer, not an instruction.
 *
 * A hosted forge runs in a cell with no DNS and no route: its one way out is
 * its parent's proxy, which resolves the name there and judges the answer
 * (`apps/egress.ts`). There the judgement is the parent's, and the request
 * goes by name through that proxy: `vetHost` says which of the two it is
 * (`Route`), and everything that dials — `outboundFetch`, git — follows it.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { err, ok, type Result } from "./result.ts";
import { addressBytes, inCidrs, parseCidr, type Cidr } from "./cidr.ts";
import { cellProxy } from "../apps/egress.ts";

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
  /**
   * The proxy URL a cell's gate listens on. Defaults to the cell this forge
   * runs in (`cellProxy`), and to none outside one. Injected by tests.
   */
  proxy?: string | undefined;
}

/** How a vetted host is reached: at the address that was judged, or by name through the cell's gate. */
export type Route =
  | { readonly via: "pin"; readonly addresses: readonly string[] }
  | { readonly via: "gate"; readonly proxy: string };

/** The proxy URL this process reaches the world through, when it is in a cell. */
function gateOf(options: OutboundOptions): string | undefined {
  if (options.proxy !== undefined) return options.proxy;
  const cell = cellProxy();
  return cell === undefined ? undefined : `http://${cell.host}:${cell.port}`;
}

const systemResolve: Resolve = async (host) =>
  (await lookup(host, { all: true })).map((a) => a.address);

export const REFUSED_SENTENCE = "refused: private address";
export const PLAIN_SENTENCE = "refused: not https";
export const UNRESOLVED_SENTENCE = "unresolved host";

export class RefusedError extends Error {
  constructor(sentence = REFUSED_SENTENCE) {
    super(sentence);
  }
}

/** The parent's gate would not let the cell reach `host`: not on its list, or not a public address. */
export class GateRefusedError extends Error {
  constructor(readonly host: string) {
    super(`refused: the forge's host does not let it reach ${host}`);
  }
}

/**
 * How to reach a host, or why not. Inside a cell: by name through the gate
 * (an address literal is refused — nothing there is judged by name). Outside
 * one: the addresses it resolves to, refused when any one of them is private.
 */
export async function vetHost(
  host: string,
  options: OutboundOptions = {},
): Promise<Result<Route, "refused" | "unresolved">> {
  const bare = host.replace(/^\[|\]$/g, "");
  const proxy = gateOf(options);
  if (proxy !== undefined) return isIP(bare) !== 0 ? err("refused") : ok({ via: "gate", proxy });
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
  const pinned = (): Route => ({ via: "pin", addresses: [...found] });
  if (
    isIP(bare) === 0 &&
    (options.trusted ?? []).includes(bare.toLowerCase())
  )
    return ok(pinned());
  const allow = options.allow ?? [];
  if (found.some((a) => isRefusedAddress(a) && !allow.includes(a)))
    return err("refused");
  return ok(pinned());
}

/**
 * fetch() to the vetted address, or by name through the cell's gate; throws
 * RefusedError when the host is private, and GateRefusedError when the gate
 * would not carry the request.
 */
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
    throw new Error(UNRESOLVED_SENTENCE);
  }
  const name = target.hostname.replace(/^\[|\]$/g, "");
  const tls = { ...(options.ca ? { ca: options.ca } : {}) };
  if (vetted.value.via === "gate") {
    const answer = await fetch(target, {
      ...init,
      redirect: "manual",
      proxy: vetted.value.proxy,
      ...(target.protocol === "https:" ? { tls } : {}),
    } satisfies BunFetchRequestInit);
    // The gate's refusal comes back as the answer to CONNECT, marked: it is not the host's.
    if (answer.headers.get("x-forge-egress") !== "refused") return answer;
    const said = (await answer.text().catch(() => "")).trim();
    if (answer.status !== 403) throw new Error(said);
    throw said.includes("does not resolve") ? new Error(UNRESOLVED_SENTENCE) : new GateRefusedError(name);
  }
  const ip = vetted.value.addresses[0]!;
  const pinned = new URL(url);
  pinned.hostname = ip.includes(":") ? `[${ip}]` : ip;
  const headers = new Headers(init.headers);
  headers.set("host", target.host);
  return fetch(pinned, {
    ...init,
    headers,
    redirect: "manual",
    ...(target.protocol === "https:" ? { tls: { serverName: name, ...tls } } : {}),
  } satisfies BunFetchRequestInit);
}
