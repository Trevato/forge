/**
 * Proving a domain, and saying what was found. The person who adds
 * `app.example.com` publishes two records: a TXT under `_forge-verify.`
 * carrying the token the forge gave them, which proves they hold the name,
 * and a CNAME to the app's own hostname, which carries the traffic. Only
 * the TXT decides; the CNAME is reported, because a name can reach the
 * forge in more ways than one — an apex through ALIAS or A records, a
 * tunnel. Every outcome of a lookup — no record, another value, a resolver
 * that will not answer — is a sentence a person can act on, never a throw.
 */

import { resolveCname, resolveTxt } from "node:dns/promises";

export interface DnsRecord {
  readonly type: "TXT" | "CNAME" | "ALIAS";
  readonly name: string;
  readonly value: string;
  /** A word of explanation, when the record needs one. */
  readonly note?: string;
}

const VERIFY_LABEL = "_forge-verify";

export const verifyName = (host: string): string => `${VERIFY_LABEL}.${host}`;
export const verifyValue = (token: string): string => `forge-verify=${token}`;

/** A name of exactly two labels cannot carry a CNAME. */
export const isApex = (host: string): boolean => host.split(".").length === 2;

const APEX_NOTE =
  "An apex cannot carry a CNAME: use your DNS provider's ALIAS or ANAME record to point it at the app's hostname, or A and AAAA records with the address the forge is served at.";

/** The two records to publish for `host`, given the app's own hostname. */
export function recordsFor(
  host: string,
  token: string,
  appHost: string,
): DnsRecord[] {
  const proof: DnsRecord = {
    type: "TXT",
    name: verifyName(host),
    value: verifyValue(token),
  };
  return isApex(host)
    ? [proof, { type: "ALIAS", name: host, value: appHost, note: APEX_NOTE }]
    : [proof, { type: "CNAME", name: host, value: appHost }];
}

/** What a check asks of DNS — the system resolver, or a test's stand-in. */
export interface DomainResolver {
  resolveTxt(name: string): Promise<string[][]>;
  resolveCname(name: string): Promise<string[]>;
}

const systemResolver: DomainResolver = { resolveTxt, resolveCname };

/** How long a lookup may take before it is called a timeout. */
const LOOKUP_TIMEOUT_MS = 5_000;

export interface DomainCheck {
  readonly verified: boolean;
  /** One plain sentence: what was found, and what to do about it. */
  readonly said: string;
}

/**
 * Look the proof up, and — once it is there — where the name points.
 * `verified` iff some TXT record at `_forge-verify.<host>` is exactly
 * `forge-verify=<token>`.
 */
export async function checkDomain(
  host: string,
  token: string,
  appHost: string,
  resolver: DomainResolver = systemResolver,
): Promise<DomainCheck> {
  const name = verifyName(host);
  const proof = await lookup(() => resolver.resolveTxt(name));
  if (proof.kind === "none")
    return { verified: false, said: `No TXT record at ${name} yet.` };
  if (proof.kind === "failed")
    return {
      verified: false,
      said: `The DNS lookup for ${name} ${proof.why}; try again in a minute.`,
    };
  const values = proof.value.map((chunks) => chunks.join(""));
  if (!values.includes(verifyValue(token)))
    return {
      verified: false,
      said: "The TXT record is there but holds a different value.",
    };
  return {
    verified: true,
    said: `Verified; ${await pointing(host, appHost, resolver)}.`,
  };
}

/** Where the name sends traffic, as one clause of the verified sentence. */
async function pointing(
  host: string,
  appHost: string,
  resolver: DomainResolver,
): Promise<string> {
  if (isApex(host))
    return `${host} is an apex, so point it at ${appHost} with an ALIAS record or at the forge's address`;
  const cname = await lookup(() => resolver.resolveCname(host));
  if (cname.kind === "none") return `${host} has no CNAME yet`;
  if (cname.kind === "failed")
    return `where ${host} points could not be looked up`;
  const first = cname.value[0];
  if (first === undefined) return `${host} has no CNAME yet`;
  const target = canonical(first);
  return target === canonical(appHost)
    ? `${host} points at ${appHost}`
    : `${host} points at ${target}, not ${appHost}`;
}

const canonical = (name: string): string =>
  name.toLowerCase().replace(/\.$/, "");

type Lookup<T> =
  | { kind: "found"; value: T }
  | { kind: "none" }
  | { kind: "failed"; why: string };

/**
 * One lookup, with every way it can go wrong folded into a value. "No such
 * record" and "no such name" both mean nothing is published yet; anything
 * else is the resolver's trouble, named so the sentence can carry it.
 */
async function lookup<T>(run: () => Promise<T>): Promise<Lookup<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(Object.assign(new Error("timed out"), { code: "ETIMEOUT" })),
      LOOKUP_TIMEOUT_MS,
    );
  });
  try {
    return { kind: "found", value: await Promise.race([run(), timeout]) };
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code: unknown }).code)
        : "";
    if (code === "ENODATA" || code === "ENOTFOUND") return { kind: "none" };
    return {
      kind: "failed",
      why: code === "ETIMEOUT" ? "timed out" : `failed (${code || "error"})`,
    };
  } finally {
    clearTimeout(timer);
  }
}
