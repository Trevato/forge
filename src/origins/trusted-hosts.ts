/**
 * Hosts a site admin has vouched for: an origin on one of them may resolve to
 * a private address (the owner's own Forgejo, reached by its in-cluster
 * service). Trust is by exact host name — never by address range — and only
 * origin traffic reads it; webhooks never do (#2922 H3).
 *
 * The list is `FORGE_OUTBOUND_TRUSTED_HOSTS` (comma or space separated) plus
 * the `outbound.trusted_hosts` row in `forge_setting`, edited on
 * /settings/origins by an admin. Read once into memory; `load` re-reads.
 */

import type { Database } from "bun:sqlite";

export const TRUSTED_KEY = "outbound.trusted_hosts";
const MAX_HOSTS = 50;
const HOST = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

/**
 * Host names from free text (commas, spaces or lines), and the words that
 * were not names: an address literal, a wildcard or a URL is refused, not
 * silently dropped, so whoever typed it knows it is not trusted.
 */
export function parseHosts(text: string): { hosts: string[]; rejected: string[] } {
  const hosts = new Set<string>();
  const rejected: string[] = [];
  for (const word of text.toLowerCase().split(/[\s,]+/)) {
    if (word === "") continue;
    if (!HOST.test(word) || /^[0-9.]+$/.test(word) || hosts.size >= MAX_HOSTS && !hosts.has(word))
      rejected.push(word.slice(0, 60));
    else hosts.add(word);
  }
  return { hosts: [...hosts], rejected };
}

export function parseHostList(text: string): string[] {
  return parseHosts(text).hosts;
}

/** Who may edit the list: a site admin who is not an agent, on the page and in the terminal alike. */
export function mayEditTrustedHosts(
  user: { isAdmin: boolean; kind: string } | undefined,
): boolean {
  return user !== undefined && user.isAdmin && user.kind !== "agent";
}

export type TrustedUpdate =
  | { ok: true; hosts: string[] }
  | { ok: false; error: "forbidden" }
  | { ok: false; error: "rejected"; rejected: string[] };

/** The one door both the page and the terminal use: check, save, audit, go live. */
export function updateTrustedHosts(
  db: Database,
  user: { id: string; isAdmin: boolean; kind: string } | undefined,
  text: string,
): TrustedUpdate {
  if (user === undefined || !mayEditTrustedHosts(user)) return { ok: false, error: "forbidden" };
  const { hosts, rejected } = parseHosts(text.slice(0, 4000));
  if (rejected.length > 0) return { ok: false, error: "rejected", rejected };
  saveTrustedHosts(db, hosts, user.id);
  return { ok: true, hosts };
}

export function rejectedSentence(rejected: string[]): string {
  return `Not host names, so not trusted: ${rejected.slice(0, 5).join(", ")}${rejected.length > 5 ? " …" : ""}. Use bare names like git.example.test.`;
}

let fromEnv: string[] = [];
let fromDb: string[] = [];

/** Every host trusted right now, env and admin-edited together. */
export function trustedHosts(): string[] {
  return [...new Set([...fromEnv, ...fromDb])];
}

export function isTrustedHost(host: string): boolean {
  return trustedHosts().includes(host.toLowerCase().replace(/^\[|\]$/g, ""));
}

/** The part an admin edits on the page (the env part is read-only there). */
export function editableHosts(): string[] {
  return [...fromDb];
}

export function envHosts(): string[] {
  return [...fromEnv];
}

export function loadTrustedHosts(
  db: Database | undefined,
  env: Record<string, string | undefined> = process.env,
): void {
  fromEnv = parseHostList(env.FORGE_OUTBOUND_TRUSTED_HOSTS ?? "");
  loadStored(db);
}

function loadStored(db: Database | undefined): void {
  fromDb = [];
  if (!db) return;
  try {
    const row = db
      .query<{ value: string }, [string]>("SELECT value FROM forge_setting WHERE key = ?1")
      .get(TRUSTED_KEY);
    const parsed: unknown = row ? JSON.parse(row.value) : [];
    if (Array.isArray(parsed))
      fromDb = parseHostList(parsed.filter((v) => typeof v === "string").join(" "));
  } catch {
    fromDb = [];
  }
}

/** Replace the admin-edited list, record the change, and make it live. */
export function saveTrustedHosts(db: Database, hosts: string[], actorId: string): void {
  const at = new Date().toISOString();
  const to = JSON.stringify(hosts);
  db.transaction(() => {
    const from = db
      .query<{ value: string }, [string]>("SELECT value FROM forge_setting WHERE key = ?1")
      .get(TRUSTED_KEY)?.value;
    db.query(
      `INSERT INTO forge_setting (key, value, updated_by, updated_at) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value,
         updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    ).run(TRUSTED_KEY, to, actorId, at);
    db.query(
      `INSERT INTO forge_setting_change (key, from_value, to_value, actor_id, at)
       VALUES (?1, ?2, ?3, ?4, ?5)`,
    ).run(TRUSTED_KEY, from ?? "[]", to, actorId, at);
  })();
  loadStored(db);
}
