/**
 * Edit an app's own domain at the registrar: publish the TXT proof, cut the
 * name over to the app, or put the owner's old records back. The credential
 * is a secret held by name (`DNS_API_TOKEN`, the repository's own) and opened
 * through `resolveScoped`, which audits the read. Admin of the repository,
 * like every domain action. Cut and revert replace what is at the name, so
 * both say what they removed: the way back, in the answer.
 */

import type { App } from "../app.ts";
import {
  cloudflare,
  type DnsProvider,
  type EditableType,
  type ZoneRecord,
} from "../apps/dns_provider.ts";
import { verifyName, verifyValue } from "../apps/domains.ts";
import { appsRuntime } from "../apps/runtime.ts";
import { getAppByRepo } from "../core/apps.ts";
import { getDomain, normalizeHost } from "../core/domains.ts";
import { resolveScoped } from "../core/secret_store.ts";
import type { Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { requireRepoAdmin } from "./access.ts";

export const DNS_SECRET = "DNS_API_TOKEN";
export type DnsStep = "proof" | "cut" | "revert";
export const DNS_STEPS: readonly DnsStep[] = ["proof", "cut", "revert"];

/** An edit that failed and could not put every removed record back. */
export interface DnsLost {
  readonly says: string;
  readonly unrestored: readonly ZoneRecord[];
}

export type DnsEditError =
  | "not_found"
  | "no_runtime"
  | "no_such_domain"
  | "no_credential"
  | "not_verified"
  | "invalid_records"
  | "refused";

export interface DnsEdit {
  readonly says: string;
  readonly removed: readonly ZoneRecord[];
  readonly put: readonly ZoneRecord[];
}

const MAX_RECORDS = 10;
const TTL_DEFAULT = 300;

/** The owner's step-1 list, validated: address records only, at the domain. */
export function parseOldRecords(host: string, input: unknown): ZoneRecord[] | undefined {
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_RECORDS) return undefined;
  const out: ZoneRecord[] = [];
  for (const item of input) {
    if (typeof item !== "object" || item === null) return undefined;
    const { type, value, ttl } = item as Record<string, unknown>;
    if (type !== "A" && type !== "AAAA" && type !== "CNAME") return undefined;
    if (typeof value !== "string" || !/^[A-Za-z0-9.:_-]{1,253}$/.test(value)) return undefined;
    const seconds = ttl === undefined ? TTL_DEFAULT : ttl;
    if (typeof seconds !== "number" || !Number.isInteger(seconds) || seconds < 1 || seconds > 86400)
      return undefined;
    out.push({ type, name: host, value, ttl: seconds });
  }
  // A CNAME stands alone at a name.
  if (out.some((r) => r.type === "CNAME") && out.length > 1) return undefined;
  return out;
}

export async function editAppDomainDns(
  app: App,
  actor: User | undefined,
  repo: Repo,
  hostInput: string,
  step: DnsStep,
  oldRecords?: unknown,
  provider?: DnsProvider,
): Promise<Result<DnsEdit, DnsEditError | DnsLost>> {
  const gate = requireRepoAdmin(app, actor, repo);
  if (!gate.ok) return gate;
  const record = getAppByRepo(app.db, repo.id);
  if (!record) return err("not_found");
  const runtime = appsRuntime(app);
  if (runtime === undefined) return err("no_runtime");
  const domain = getDomain(app.db, normalizeHost(hostInput));
  if (domain === undefined || domain.appId !== record.id) return err("no_such_domain");
  // Both replace what is at the name: only a name the forge verified is the owner's to edit.
  if ((step === "cut" || step === "revert") && domain.verifiedAt === null) return err("not_verified");
  let put: ZoneRecord[];
  let replace: EditableType[];
  let at = domain.host;
  if (step === "proof") {
    at = verifyName(domain.host);
    replace = ["TXT"];
    put = [{ type: "TXT", name: at, value: verifyValue(domain.token), ttl: TTL_DEFAULT }];
  } else if (step === "cut") {
    replace = ["A", "AAAA", "CNAME"];
    put = [
      {
        type: "CNAME",
        name: domain.host,
        value: runtime.hostFor(record.slug, domain.env),
        ttl: TTL_DEFAULT,
      },
    ];
  } else {
    replace = ["A", "AAAA", "CNAME"];
    const parsed = parseOldRecords(domain.host, oldRecords);
    if (parsed === undefined) return err("invalid_records");
    put = parsed;
  }
  let api = provider;
  if (api === undefined) {
    // Repo scope only: a forge-wide token reaches other tenants' zones.
    const found = resolveScoped(app.db, app.config.dataDir, app.bus, [DNS_SECRET], {
      repo: repo.id,
      actor: gate.value.id,
    })[DNS_SECRET];
    if (found === undefined || found.scope !== "repo") return err("no_credential");
    api = cloudflare(found.value, runtime.options.dnsFetch);
  }
  const done = await api.replace(at, replace, put);
  if (!done.ok)
    return done.unrestored.length === 0
      ? err("refused")
      : err({ says: done.says, unrestored: done.unrestored });
  app.bus.append({
    kind: "app.domain.dns",
    repoId: repo.id,
    actorId: gate.value.id,
    payload: { host: domain.host, step, removed: done.removed.length },
  });
  return ok({ says: dnsSaid(step, domain.host), removed: done.removed, put });
}

export function recordsInWords(records: readonly ZoneRecord[]): string {
  return records.map((r) => `${r.type} ${r.value} ttl ${r.ttl}`).join("; ");
}

/** The words for any failure of an edit; a half-done one lists what to put back by hand. */
export function dnsRefusal(error: DnsEditError | DnsLost): string {
  return typeof error === "string"
    ? DNS_REFUSALS[error]
    : `The registrar failed (${error.says}) and these removed records were not put back: ${recordsInWords(error.unrestored)}. Add them again by hand.`;
}

export function dnsSaid(step: DnsStep, host: string): string {
  return step === "proof"
    ? `Published the TXT proof for ${host}. Check it next.`
    : step === "cut"
      ? `${host} now points at the app. The records it replaced are listed: keep them, they are the way back.`
      : `The old records are back at ${host}; traffic returns as caches expire.`;
}

export const DNS_REFUSALS: Readonly<Record<DnsEditError, string>> = {
  not_found: "no such app or repository (owner/name)",
  no_runtime: "Nothing is serving apps on this forge.",
  no_such_domain: "No domain by that name.",
  no_credential: `No registrar credential: set the secret ${DNS_SECRET} (a Cloudflare API token that edits DNS) for this repository.`,
  not_verified: "Check the domain until it is verified before cutting it over or reverting it.",
  invalid_records:
    "revert needs `records`: the old A, AAAA or CNAME records, each { type, value, ttl? } (a CNAME alone).",
  refused: "The registrar refused the edit; nothing was changed.",
};
