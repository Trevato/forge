/**
 * The registrar keys of the terminal's domains screen (`n` on deploys): the
 * terminal door of MCP `app_domains` dns_proof, dns_cut and dns_revert. A thin
 * layer over `editAppDomainDns`, which gates (repository admin), validates and
 * audits; this module only reads the owner's typed records and words answers.
 */

import {
  dnsRefusal,
  editAppDomainDns,
  recordsInWords,
  type DnsStep,
} from "../../actions/domain_dns.ts";
import type { Repo } from "../../core/repos.ts";
import type { Session } from "../session.ts";

/** What an edit said, and whether it went through. */
export interface DnsTold {
  readonly text: string;
  readonly ok: boolean;
}

/**
 * `A 203.0.113.5 ttl 60; AAAA 2001:db8::1` — the words a cut answers with —
 * as the `{ type, value, ttl? }` list the action validates. Nothing is checked
 * here beyond the shape of the words: `parseOldRecords` decides.
 */
export function recordsFromWords(text: string): unknown[] {
  return text
    .split(/[;,\n]/)
    .map((part) => part.trim().split(/\s+/).filter((w) => w !== "" && w.toLowerCase() !== "ttl"))
    .filter((words) => words.length > 0)
    .map(([type, value, ttl]) => ({
      type: type?.toUpperCase(),
      value,
      ...(ttl === undefined ? {} : { ttl: /^\d+$/.test(ttl) ? Number(ttl) : ttl }),
    }));
}

/** Run one registrar step for the session's user and say how it went. */
export async function editDnsFromTerminal(
  f: Session,
  repo: Repo,
  host: string,
  step: DnsStep,
  recordsText?: string,
): Promise<DnsTold> {
  const records = recordsText === undefined ? undefined : recordsFromWords(recordsText);
  const done = await editAppDomainDns(f.app, f.user, repo, host, step, records);
  if (!done.ok) {
    const text =
      done.error === "not_found" ? "Only the app's admin edits its DNS." : dnsRefusal(done.error);
    return { text, ok: false };
  }
  if (step !== "cut") return { text: done.value.says, ok: true };
  // The removed records lead: the foot is one line, and they are the way back.
  const removed =
    done.value.removed.length === 0
      ? "Nothing was removed."
      : `Removed: ${recordsInWords(done.value.removed)}.`;
  return { text: `${removed} ${done.value.says}`, ok: true };
}
