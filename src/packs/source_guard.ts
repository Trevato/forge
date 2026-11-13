/**
 * Where a pack's source may point (#11971). Before anything is cloned for a
 * pack, its host is resolved and judged by the forge's one address list
 * (`kernel/outbound.ts`: loopback, RFC 1918, link-local, unique-local,
 * CGNAT/tailnet, unspecified, multicast); git is then told to dial the address
 * that passed and to follow no redirect, so a second lookup or a 302 cannot
 * reach a refused one. Only port 443 is allowed, unless the forge itself is
 * the source. Pure but for the lookup, which is handed in.
 */

import { err, ok, type Result } from "../kernel/result.ts";
import { vetHost, type OutboundOptions } from "../kernel/outbound.ts";
import { pinFor, remoteGitEnv } from "../git/remote-env.ts";

export interface SourceGuardOptions extends OutboundOptions {
  /** The forge's own address: a source on this host and port is the forge itself, let through. */
  readonly forge?: string;
  /** Permit any port. For tests only. */
  readonly anyPort?: boolean;
}

const hostOf = (url: URL): string => `${url.hostname}:${url.port !== "" ? url.port : url.protocol === "https:" ? "443" : "80"}`;

/** The one sentence a refused source gets. */
export const refusal = (host: string, why: string): string =>
  `the source host ${host.slice(0, 100)} ${why}, so the forge will not clone it.`;

/**
 * The git environment pinned to the vetted address of `address`'s host, or
 * the sentence naming the host and why it is refused. `base` is git's
 * environment; the pin and the no-redirect rule are added to it.
 */
export async function guardSource(
  address: string,
  base: Record<string, string>,
  options: SourceGuardOptions = {},
): Promise<Result<Record<string, string>, string>> {
  const url = URL.parse(address);
  if (url === null) return err(`the source ${address.slice(0, 100)} is not an address, so the forge will not clone it.`);
  const forge = options.forge === undefined ? null : URL.parse(options.forge);
  if (forge !== null && hostOf(forge) === hostOf(url)) return ok(remoteGitEnv(base));
  if (url.protocol !== "https:" && options.plain !== true) return err(`the source ${address.slice(0, 100)} is not an https address, so the forge will not clone it.`);
  const bare = url.hostname.replace(/^\[|\]$/g, "");
  if (options.anyPort !== true && hostOf(url) !== `${url.hostname}:443`) return err(refusal(bare, "is on a port other than 443"));
  const vetted = await vetHost(bare, options);
  if (!vetted.ok)
    return err(refusal(bare, vetted.error === "refused" ? "is, or resolves to, an internal address" : "could not be resolved"));
  return ok(remoteGitEnv(base, pinFor(address, vetted.value)));
}
