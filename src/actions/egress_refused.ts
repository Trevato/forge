/**
 * A refused host, said out loud and allowed with one switch (#10456). The
 * owner (any admin of the repository) sees what the app's cells were refused
 * and presses Allow: the entry is allowed at once for running cells (no
 * redeploy), and committed to `forge.json` `egress` in their name so the
 * repository stays the truth. A private or LAN destination is a site admin's
 * yes, as ever: an owner who is not one cannot allow it. Ignore keeps the
 * row but stops saying it. An agent admin allows live but never commits to
 * the default branch, and never allows live either: an opening no one reads
 * in the repository is refused (`needs_human`); it proposes the forge.json
 * change in a pull. The page and the terminal (`tui/screens/blocked.ts`) call these same
 * functions; each write is an event, so the other door updates live.
 */

import type { App } from "../app.ts";
import { readFileAt } from "../apps/checkout.ts";
import {
  allowNow,
  allowedHosts,
  blockedHosts,
  entryFor,
  refusalLine,
  ignoreRefused,
  type Refusal,
} from "../apps/egress_refused.ts";
import { parseDestination } from "../core/egress_grants.ts";
import { getAppByRepo } from "../core/apps.ts";
import { canAdmin, listReposWritableTo, type Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { resolveOid } from "../git/merge.ts";
import { repoDir } from "../git/repos.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { requireRepoAdmin } from "./access.ts";
import { editFiles } from "./contents.ts";

export interface BlockedRow {
  readonly host: string;
  readonly port: number;
  /** "Blocked: huggingface.co (14 tries, last 2 min ago)" */
  readonly line: string;
  /** `host:port`, what the forms post. */
  readonly destination: string;
  /** Private: only a site admin's yes allows it. */
  readonly private: boolean;
}

export interface BlockedView {
  readonly rows: BlockedRow[];
  /** Allowed live (the allowed file) but not in forge.json: the repository does not say it. */
  readonly liveOnly: string[];
  readonly canAllowPrivate: boolean;
}

export type BlockedError =
  | "not_found"
  | "invalid"
  | "not_refused"
  | "needs_site_admin"
  | "needs_human";

const siteAdmin = (actor: User): boolean => actor.isAdmin && actor.kind !== "agent";

const rowOf = (r: Refusal, now: number): BlockedRow => ({
  host: r.host,
  port: r.port,
  line: refusalLine(r, now),
  destination: `${r.host}:${r.port}`,
  private: r.private,
});

/** What this repository's cells were refused and not yet answered, for its admins. */
export function blockedView(
  app: App,
  actor: User | undefined,
  repo: Repo,
  now = Date.now(),
): Result<BlockedView, "not_found"> {
  const admin = requireRepoAdmin(app, actor, repo);
  if (!admin.ok) return admin;
  return ok({
    rows: blockedHosts(app.config.dataDir, repo.id).map((r) => rowOf(r, now)),
    canAllowPrivate: siteAdmin(admin.value),
    liveOnly: [],
  });
}

/** The forge.json `egress` list on the default branch, or undefined when it cannot be read. */
async function declaredEgress(app: App, repo: Repo): Promise<unknown[] | undefined> {
  const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
  const tip = await resolveOid(dir, `refs/heads/${repo.defaultBranch}`);
  if (tip === undefined) return undefined;
  const text = await readFileAt(dir, tip, "forge.json");
  if (text === undefined) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) return undefined;
  const current = (json as { egress?: unknown }).egress;
  if (current !== undefined && !Array.isArray(current)) return undefined;
  return (current ?? []) as unknown[];
}

/** `view` with the entries allowed live that forge.json does not declare (shown so none stays hidden). */
export async function withLiveOnly(app: App, repo: Repo, view: BlockedView): Promise<BlockedView> {
  const declared = await declaredEgress(app, repo);
  const live = allowedHosts(app.config.dataDir, repo.id);
  return { ...view, liveOnly: live.filter((e) => declared === undefined || !declared.includes(e)) };
}

/** forge.json with `entry` in `egress`, or undefined when there is nothing to change. */
async function withEntry(app: App, repo: Repo, entry: string): Promise<string | undefined> {
  const list = await declaredEgress(app, repo);
  if (list === undefined || list.includes(entry)) return undefined;
  const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
  const tip = await resolveOid(dir, `refs/heads/${repo.defaultBranch}`);
  const text = tip === undefined ? undefined : await readFileAt(dir, tip, "forge.json");
  if (text === undefined) return undefined;
  return `${JSON.stringify({ ...(JSON.parse(text) as object), egress: [...list, entry] }, null, 2)}\n`;
}

export interface Allowed {
  readonly entry: string;
  /** Whether the entry is now committed to forge.json (else only allowed live). */
  readonly committed: boolean;
  /** A private destination still waits for the site admin's grant. */
  readonly needsGrant: boolean;
}

/** The refusal `destination` (`host:port`) names, if one was seen. */
function refusalFor(app: App, repo: Repo, destination: string): Result<{ entry: string; row: Refusal }, BlockedError> {
  const parsed = parseDestination(destination);
  if (!parsed.ok) return err("invalid");
  const { host, port } = parsed.value;
  const row = blockedHosts(app.config.dataDir, repo.id).find((r) => r.host === host && r.port === port);
  return row === undefined ? err("not_refused") : ok({ entry: entryFor(host, port), row });
}

export async function allowBlocked(
  app: App,
  actor: User | undefined,
  repo: Repo,
  destination: string,
): Promise<Result<Allowed, BlockedError>> {
  const admin = requireRepoAdmin(app, actor, repo);
  if (!admin.ok) return admin;
  const found = refusalFor(app, repo, destination.trim().toLowerCase());
  if (!found.ok) return found;
  const { entry, row } = found.value;
  // An agent's yes would open production egress with no pull and no one
  // reading it: it proposes the forge.json change in a pull instead.
  if (admin.value.kind === "agent") return err("needs_human");
  if (row.private && !siteAdmin(admin.value)) return err("needs_site_admin");
  // A private destination is never opened here: forge.json asks, a site
  // admin's grant (`core/egress_grants.ts`) opens it.
  if (!row.private) allowNow(app.config.dataDir, repo.id, entry);
  let committed = false;
  const next = await withEntry(app, repo, entry);
  if (next !== undefined) {
    const edit = await editFiles(app, admin.value, repo, {
      files: [{ path: "forge.json", content: next }],
      message: `Allow ${entry} in egress\n\nThe app's cells were refused it; the owner allowed it.`,
    });
    committed = edit.ok;
  }
  app.bus.append({
    kind: "app.egress.allowed",
    repoId: repo.id,
    actorId: admin.value.id,
    payload: { entry },
  });
  return ok({ entry, committed, needsGrant: row.private });
}

/** Ignore keeps the row and its count but stops saying it. */
export function ignoreBlocked(
  app: App,
  actor: User | undefined,
  repo: Repo,
  destination: string,
): Result<string, BlockedError> {
  const admin = requireRepoAdmin(app, actor, repo);
  if (!admin.ok) return admin;
  const parsed = parseDestination(destination.trim().toLowerCase());
  if (!parsed.ok) return err("invalid");
  const { host, port, text } = parsed.value;
  if (!ignoreRefused(app.config.dataDir, repo.id, host, port)) return err("not_refused");
  app.bus.append({
    kind: "app.egress.ignored",
    repoId: repo.id,
    actorId: admin.value.id,
    payload: { host, port },
  });
  return ok(text);
}

/**
 * The notifications: one line per host an app of this person's was refused
 * and they have not answered. The item is the repository and the destination,
 * not the count, so it is said the first time and not again as tries grow.
 */
export function blockedLines(
  app: App,
  user: User,
  now = Date.now(),
): { line: string; items: string[]; link: string }[] {
  if (user.kind !== "user") return [];
  const out: { line: string; items: string[]; link: string }[] = [];
  for (const repo of listReposWritableTo(app.db, user, { limit: 200, withoutArchived: true })) {
    if (!canAdmin(app.db, repo, user) || getAppByRepo(app.db, repo.id) === undefined) continue;
    for (const r of blockedHosts(app.config.dataDir, repo.id))
      out.push({
        line: `${repo.name}: ${refusalLine(r, now)}`,
        items: [`egress:${repo.id}:${r.host}:${r.port}`],
        link: `/${repo.ownerName}/${repo.name}/settings/app#blocked`,
      });
  }
  return out;
}
