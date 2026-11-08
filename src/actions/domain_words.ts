/**
 * What a person is told about an app's own domains (`listAppDomains`,
 * `addAppDomain`, `checkAppDomain`, `removeAppDomain`). Said the same on the
 * app's settings page and in the terminal's domains screen, from here.
 */

import type { DnsRecord } from "../apps/domains.ts";
import type { AppDomainView } from "./domains.ts";

const REFUSALS: Readonly<Record<string, string>> = {
  invalid_host:
    "A domain is a hostname: letters, digits and hyphens in at least two labels, like app.example.com.",
  reserved_host: "That name is the forge's own to hand out.",
  taken: "Another app already answers to that domain.",
  no_runtime: "Nothing is serving apps on this forge.",
};

/** A refusal code as a sentence; `fallback` for a code with none of its own. */
export function domainRefusalText(code: string, fallback: string): string {
  return REFUSALS[code] ?? fallback;
}

export const NO_SUCH_DOMAIN = "No domain by that name.";

/** `live`, or `waiting for DNS` until a check finds the proof. */
export function domainStateWord(d: AppDomainView): string {
  return d.verified ? "live" : "waiting for DNS";
}

/** What the last check said, or that none has run. */
export function domainSaidText(d: AppDomainView): string {
  return d.said === "" ? "Not checked yet." : d.said;
}

/** What the records say, as one sentence: type, name and value, in words. */
export function recordsInWords(records: readonly DnsRecord[]): string {
  return records
    .map((r) =>
      r.type === "TXT"
        ? `a TXT record at ${r.name} with the value ${r.value}`
        : r.type === "CNAME"
          ? `a CNAME from ${r.name} to ${r.value}`
          : `an ALIAS from ${r.name} to ${r.value}`,
    )
    .join(" and ");
}

/** A domain was added: what to publish next. */
export function domainAddedText(d: AppDomainView): string {
  return `${d.host} is added. Publish ${recordsInWords(d.records)}, then press Check now.`;
}

/** A domain was removed. */
export function domainRemovedText(host: string): string {
  return `${host} is removed. The forge no longer answers there.`;
}
