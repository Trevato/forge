/**
 * An app's private destinations (#3433): the ones its forge.json `egress`
 * names exactly as `host:port`, and a site admin's grant or revoke of each.
 * Seeing the list takes admin over the repository, like every app setting;
 * changing it takes a site admin. Every change is an event, so who and when
 * outlive the grant itself.
 */

import type { App } from "../app.ts";
import { parseManifest } from "../apps/manifest.ts";
import { readFileAt } from "../apps/checkout.ts";
import {
  grantEgress,
  listEgressGrants,
  parseDestination,
  revokeEgress,
} from "../core/egress_grants.ts";
import { listEvents } from "../core/events.ts";
import type { Repo } from "../core/repos.ts";
import { getUserById, type User } from "../core/users.ts";
import { resolveOid } from "../git/merge.ts";
import { repoDir } from "../git/repos.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { requireRepoAdmin } from "./access.ts";

/** One destination as a page or the API shows it. */
export interface EgressRow {
  readonly destination: string;
  /** Whether forge.json still asks for it; a grant it no longer asks for opens nothing. */
  readonly asked: boolean;
  readonly granted: boolean;
  readonly grantedBy: string | null;
  readonly grantedAt: string | null;
}

/** A grant or revoke, as it happened. */
export interface EgressChange {
  readonly kind: "granted" | "revoked";
  readonly destination: string;
  readonly by: string;
  readonly at: string;
}

export interface EgressView {
  readonly rows: EgressRow[];
  readonly changes: EgressChange[];
  /** Whether this viewer may grant and revoke (a site admin). */
  readonly canChange: boolean;
}

export type EgressError =
  | "not_found"
  | "forbidden"
  | "invalid_destination"
  | "not_asked"
  | "never_grantable"
  | "no_such_grant";

const CHANGES_SHOWN = 8;

const siteAdmin = (actor: User): boolean =>
  actor.isAdmin && actor.kind !== "agent";

/** The exact `host:port` entries forge.json asks for at the default branch's tip. */
export async function askedDestinations(
  app: App,
  repo: Repo,
): Promise<string[]> {
  const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
  const tip = await resolveOid(dir, `refs/heads/${repo.defaultBranch}`);
  if (tip === undefined) return [];
  const [forgeJson, packageJson] = await Promise.all([
    readFileAt(dir, tip, "forge.json"),
    readFileAt(dir, tip, "package.json"),
  ]);
  const manifest = parseManifest(forgeJson, packageJson);
  if (!manifest.ok) return [];
  const out: string[] = [];
  for (const entry of manifest.value.egress ?? []) {
    const parsed = entry.startsWith("*.") ? undefined : parseDestination(entry);
    if (parsed?.ok && !out.includes(parsed.value.text))
      out.push(parsed.value.text);
  }
  return out;
}

function nameOf(app: App, userId: string): string {
  const user = getUserById(app.db, userId);
  return user === undefined ? "someone" : user.username;
}

function changesOf(app: App, repo: Repo): EgressChange[] {
  const read = (kind: "granted" | "revoked"): EgressChange[] =>
    listEvents(app.db, {
      repoId: repo.id,
      kind: `app.egress.${kind}`,
      limit: CHANGES_SHOWN,
    }).map((e) => ({
      kind,
      destination: String(e.payload["destination"] ?? ""),
      by: e.actorId === null ? "someone" : nameOf(app, e.actorId),
      at: e.createdAt,
    }));
  return [...read("granted"), ...read("revoked")]
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .slice(0, CHANGES_SHOWN);
}

/** What the app asks for, what is granted, and what was done about it. */
export async function egressView(
  app: App,
  actor: User | undefined,
  repo: Repo,
): Promise<Result<EgressView, "not_found">> {
  const admin = requireRepoAdmin(app, actor, repo);
  if (!admin.ok) return err("not_found");
  const asked = await askedDestinations(app, repo);
  const granted = new Map(
    listEgressGrants(app.db, repo.id).map((g) => [g.destination, g]),
  );
  const row = (destination: string): EgressRow => {
    const g = granted.get(destination);
    return {
      destination,
      asked: asked.includes(destination),
      granted: g !== undefined,
      grantedBy: g === undefined ? null : nameOf(app, g.grantedBy),
      grantedAt: g?.grantedAt ?? null,
    };
  };
  const rows = [...new Set([...asked, ...granted.keys()])]
    .sort()
    .map(row);
  return ok({
    rows,
    changes: changesOf(app, repo),
    canChange: siteAdmin(admin.value),
  });
}

/** The site admin who may change grants on `repo`. */
function changer(
  app: App,
  actor: User | undefined,
  repo: Repo,
): Result<User, "not_found" | "forbidden"> {
  const admin = requireRepoAdmin(app, actor, repo);
  if (!admin.ok) return err("not_found");
  return siteAdmin(admin.value) ? ok(admin.value) : err("forbidden");
}

/** Grant one destination forge.json names exactly. */
export async function grantAppEgress(
  app: App,
  actor: User | undefined,
  repo: Repo,
  destination: string,
): Promise<Result<EgressRow, EgressError>> {
  const admin = changer(app, actor, repo);
  if (!admin.ok) return admin;
  const parsed = parseDestination(destination.trim());
  if (!parsed.ok) return err("invalid_destination");
  const text = parsed.value.text;
  if (!(await askedDestinations(app, repo)).includes(text))
    return err("not_asked");
  const granted = grantEgress(app.db, repo.id, text, admin.value);
  if (!granted.ok) return err("never_grantable");
  app.bus.append({
    kind: "app.egress.granted",
    repoId: repo.id,
    actorId: admin.value.id,
    payload: { destination: text },
  });
  return ok({
    destination: text,
    asked: true,
    granted: true,
    grantedBy: nameOf(app, granted.value.grantedBy),
    grantedAt: granted.value.grantedAt,
  });
}

/** Take a grant back, whether or not forge.json still asks for it; the canonical destination. */
export function revokeAppEgress(
  app: App,
  actor: User | undefined,
  repo: Repo,
  destination: string,
): Result<string, EgressError> {
  const admin = changer(app, actor, repo);
  if (!admin.ok) return admin;
  const parsed = parseDestination(destination.trim());
  if (!parsed.ok) return err("invalid_destination");
  if (!revokeEgress(app.db, repo.id, parsed.value.text, admin.value))
    return err("no_such_grant");
  app.bus.append({
    kind: "app.egress.revoked",
    repoId: repo.id,
    actorId: admin.value.id,
    payload: { destination: parsed.value.text },
  });
  return ok(parsed.value.text);
}
