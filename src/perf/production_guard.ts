/**
 * The load is never aimed at production (#9596). Decides from the URL alone,
 * before any request goes out, whether a `--url` would land on the forge's
 * own public host: its name, any name under it, or an address literal that
 * production's name resolves to. A different name on the same edge is a
 * different forge (the edge routes by Host), so it is not refused here.
 *
 * Plain data in, words out: undefined when the URL may be loaded, else why not.
 */

import { isIP } from "node:net";

/** The forge's own public host: production (as in `scripts/restore-drill.ts`). */
export const PRODUCTION_HOST = "forge.open-platform.sh";

/** Addresses a name resolves to; injected so tests ask no resolver. */
export type Resolve = (host: string) => Promise<readonly string[]>;

const bare = (host: string): string => host.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");

/** A loopback or unspecified address: production is never one. */
const local = (ip: string): boolean => /^127\./.test(ip) || ip === "::1" || ip === "0.0.0.0" || ip === "::";

export async function refuseProduction(url: string, resolve: Resolve, production: string = PRODUCTION_HOST): Promise<string | undefined> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `--url ${JSON.stringify(url)} is not a URL`;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return `--url must be http or https, not ${parsed.protocol}`;
  const host = bare(parsed.hostname);
  const prod = bare(production);
  if (host === prod || host.endsWith(`.${prod}`)) return `--url ${parsed.origin} is production (${prod}); run the load only at a copy you stand up`;
  if (isIP(host) === 0 || local(host)) return undefined;
  let addresses: readonly string[];
  try {
    addresses = (await resolve(prod)).map(bare);
  } catch {
    return `--url ${parsed.origin} is an address and ${prod} could not be resolved to rule out that it is production; use the copy's name`;
  }
  return addresses.includes(host) ? `--url ${parsed.origin} is an address of production (${prod}); run the load only at a copy you stand up` : undefined;
}

/** The system resolver, every address of a name. */
export const systemResolve: Resolve = async (host) => {
  const { lookup } = await import("node:dns/promises");
  return (await lookup(host, { all: true })).map((a) => a.address);
};
