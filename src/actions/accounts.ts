/**
 * The owner's hand on accounts: see who joined, hear of each new one, and
 * suspend or remove one. Only a forge admin may look or act; anyone else is
 * told the door is not there (`not_found`), like every admin surface.
 *
 * An admin cannot suspend or remove themselves, another admin, or an agent
 * (the crew is managed on its own page). Suspending drops every credential,
 * cancels what the account's repositories were running and stops their
 * apps — their data stays. Removing does that, deletes the repositories,
 * and scrubs the account; the row stays so the name stays taken.
 */

import type { Database } from "bun:sqlite";
import type { App } from "../app.ts";
import { getAppByRepo } from "../core/apps.ts";
import { listTeams, retireOrg, soleOwnedOrgs } from "../core/orgs.ts";
import { appsRuntime } from "../apps/runtime.ts";
import {
  dropCredentials,
  listAccounts as readAccounts,
  originOf,
  scrubAccount,
  setSuspended,
  type AccountRow,
} from "../core/accounts.ts";
import { removeInstallCache } from "../crew/workdir.ts";
import { dropMirror } from "../crew/mirror.ts";
import { deleteRepo as destroyRepo, listReposOwnedBy } from "../core/repos.ts";
import { listActive } from "../core/runs.ts";
import { getUserByName, type User } from "../core/users.ts";
import { markVerified } from "../core/verify.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { requireUser } from "./access.ts";
import { cancelRepoRun } from "./runs.ts";

export type AccountActionError = "not_found" | "not_allowed";

function requireForgeAdmin(actor: User | undefined): Result<User, "not_found"> {
  const user = requireUser(actor);
  return user.ok && user.value.isAdmin && user.value.kind === "user"
    ? ok(user.value)
    : err("not_found");
}

/** Every person and agent, newest first, for an admin. */
export function listAccounts(
  app: App,
  actor: User | undefined,
): Result<AccountRow[], "not_found"> {
  const admin = requireForgeAdmin(actor);
  if (!admin.ok) return admin;
  return ok(readAccounts(app.db));
}

/** The account an admin may act on: a person, not themselves, not an admin. */
function target(
  app: App,
  admin: User,
  username: string,
): Result<User, AccountActionError> {
  const user = getUserByName(app.db, username);
  if (user === undefined || user.kind === "org") return err("not_found");
  if (user.kind === "agent" || user.isAdmin || user.id === admin.id)
    return err("not_allowed");
  return ok(user);
}

/** Cancel everything the account's repositories have queued or running. */
async function quiet(app: App, admin: User, user: User): Promise<void> {
  const repos = listReposOwnedBy(app.db, user.id);
  const ids = new Set(repos.map((r) => r.id));
  for (const kind of ["agent", "check", "deploy"] as const)
    for (const run of listActive(app.db, kind)) {
      const repo = repos.find((r) => r.id === run.repoId);
      if (repo !== undefined) cancelRepoRun(app, admin, repo, run.id);
    }
  const runtime = appsRuntime(app);
  if (runtime !== undefined) for (const id of ids) await runtime.stopRepo(id);
}

export async function suspendAccount(
  app: App,
  actor: User | undefined,
  username: string,
  /**
   * The owner has seen that this account is the last active owner of an
   * organization (`soleOwnedOrgs`), and suspends it anyway. Without it the
   * suspension is refused as `last_owner` and nothing changes.
   */
  options: { confirmed?: boolean } = {},
): Promise<Result<User, AccountActionError | "last_owner">> {
  const admin = requireForgeAdmin(actor);
  if (!admin.ok) return admin;
  const found = target(app, admin.value, username);
  if (!found.ok) return found;
  const user = found.value;
  if (user.removedAt !== null) return err("not_allowed");
  if (options.confirmed !== true && soleOwnedOrgs(app.db, user.id).length > 0)
    return err("last_owner");
  setSuspended(app.db, user.id, new Date().toISOString());
  dropCredentials(app.db, user.id);
  await quiet(app, admin.value, user);
  app.bus.append({
    kind: "account.suspended",
    actorId: admin.value.id,
    payload: { username: user.username },
  });
  return ok(getUserByName(app.db, username)!);
}

export function unsuspendAccount(
  app: App,
  actor: User | undefined,
  username: string,
): Result<User, AccountActionError> {
  const admin = requireForgeAdmin(actor);
  if (!admin.ok) return admin;
  const found = target(app, admin.value, username);
  if (!found.ok) return found;
  if (found.value.removedAt !== null) return err("not_allowed");
  setSuspended(app.db, found.value.id, null);
  app.bus.append({
    kind: "account.unsuspended",
    actorId: admin.value.id,
    payload: { username: found.value.username },
  });
  return ok(getUserByName(app.db, username)!);
}

/** What retiring a sole-owned organization takes with it, as plain data. */
export interface OrgRetirement {
  org: string;
  repos: { name: string; app: string | null }[];
  teams: string[];
}

/** Everything removing an account takes: its own repositories and its sole-owned organizations. */
export interface RetirementPlan {
  own: { name: string; app: string | null }[];
  orgs: OrgRetirement[];
}

/**
 * What removing `username` with `retireOrgs` would take: the account's own
 * repositories, and every organization it alone owns with that organization's
 * repositories (with the app each runs, if any) and teams. Reads only.
 */
export function retirementPlan(
  app: App,
  actor: User | undefined,
  username: string,
): Result<RetirementPlan, AccountActionError> {
  const admin = requireForgeAdmin(actor);
  if (!admin.ok) return admin;
  const found = target(app, admin.value, username);
  if (!found.ok) return found;
  const repos = (owner: User) =>
    listReposOwnedBy(app.db, owner.id).map((r) => ({
      name: `${owner.username}/${r.name}`,
      app: getAppByRepo(app.db, r.id)?.slug ?? null,
    }));
  return ok({
    own: repos(found.value),
    orgs: soleOwnedOrgs(app.db, found.value.id).map((org) => ({
      org: org.username,
      repos: repos(org),
      teams: listTeams(app.db, org.id).map((t) => t.name),
    })),
  });
}

/**
 * Take apart every repository `owner` has: its apps torn down, then the
 * repository itself. Stops at the first that will not go and names it;
 * `removed` collects the ones that did. Null means all are gone.
 */
async function removeOwnedRepos(
  app: App,
  admin: User,
  owner: User,
  removed: string[] = [],
): Promise<string | null> {
  const runtime = appsRuntime(app);
  for (const repo of listReposOwnedBy(app.db, owner.id)) {
    if (runtime !== undefined) await runtime.teardownAll(repo.id);
    const label = `${owner.username}/${repo.name}`;
    const deleted = await destroyRepo(app.db, app.reposRoot, repo);
    if (!deleted.ok) return label;
    await removeInstallCache(app.config.dataDir, repo.id);
    dropMirror(app.config.dataDir, repo.id);
    removed.push(label);
    if (owner.kind === "org")
      app.bus.append({
        kind: "repo.deleted",
        actorId: admin.id,
        payload: {
          repo: label,
          visibility: repo.visibility,
          ownerId: repo.ownerId,
          by: "org_retired",
        },
      });
  }
  return null;
}

/** What a retirement did: every thing removed, in order, and what stopped it. */
export interface Retired {
  removed: string[];
  failed: string | null;
}

/**
 * Remove an account together with the organizations it alone owns. Each
 * organization's repositories go the way an account's do (apps torn down,
 * then the repository), then the organization and its teams, then the
 * account. A failure stops there with everything before it gone and
 * everything after it intact; calling again finishes the job.
 */
export async function retireAndRemoveAccount(
  app: App,
  actor: User | undefined,
  username: string,
  options: { confirmed?: boolean } = {},
): Promise<Result<Retired, AccountActionError | "confirm_required">> {
  const admin = requireForgeAdmin(actor);
  if (!admin.ok) return admin;
  const found = target(app, admin.value, username);
  if (!found.ok) return found;
  const user = found.value;
  if (options.confirmed !== true) return err("confirm_required");
  const out: Retired = { removed: [], failed: null };
  if (user.removedAt !== null) return ok(out);
  setSuspended(app.db, user.id, new Date().toISOString());
  dropCredentials(app.db, user.id);
  await quiet(app, admin.value, user);
  for (const org of soleOwnedOrgs(app.db, user.id)) {
    await quiet(app, admin.value, org);
    out.failed = await removeOwnedRepos(app, admin.value, org, out.removed);
    if (out.failed !== null) return ok(out);
    const at = new Date().toISOString();
    retireOrg(app.db, org.id, at);
    scrubAccount(app.db, org.id, at);
    out.removed.push(org.username);
    app.bus.append({
      kind: "org.retired",
      actorId: admin.value.id,
      payload: { org: org.username, with: user.username },
    });
  }
  out.failed = await removeOwnedRepos(app, admin.value, user, out.removed);
  if (out.failed !== null) return ok(out);
  scrubAccount(app.db, user.id, new Date().toISOString());
  out.removed.push(user.username);
  app.bus.append({
    kind: "account.removed",
    actorId: admin.value.id,
    payload: { username: user.username },
  });
  return ok(out);
}

export async function removeAccount(
  app: App,
  actor: User | undefined,
  username: string,
): Promise<Result<void, AccountActionError | "delete_failed" | "last_owner">> {
  const admin = requireForgeAdmin(actor);
  if (!admin.ok) return admin;
  const found = target(app, admin.value, username);
  if (!found.ok) return found;
  const user = found.value;
  if (user.removedAt !== null) return ok();
  // An organization this account alone owns would be left with nobody to
  // administer it: someone else is made an owner first (`soleOwnedOrgs`
  // names them), and nothing here has changed yet.
  if (soleOwnedOrgs(app.db, user.id).length > 0) return err("last_owner");
  // Stop it first, so nothing it owns is running while it is taken apart.
  setSuspended(app.db, user.id, new Date().toISOString());
  dropCredentials(app.db, user.id);
  await quiet(app, admin.value, user);
  if ((await removeOwnedRepos(app, admin.value, user)) !== null)
    return err("delete_failed");
  scrubAccount(app.db, user.id, new Date().toISOString());
  app.bus.append({
    kind: "account.removed",
    actorId: admin.value.id,
    payload: { username: user.username },
  });
  return ok();
}

/**
 * The owner's word that an account's email is theirs: what lets a newcomer
 * create and cost when the forge sends no mail, or when a link went astray.
 * Recorded in the audit as the owner's act.
 */
export function verifyAccount(
  app: App,
  actor: User | undefined,
  username: string,
): Result<User, AccountActionError> {
  const admin = requireForgeAdmin(actor);
  if (!admin.ok) return admin;
  const user = getUserByName(app.db, username);
  if (user === undefined || user.kind === "org") return err("not_found");
  if (user.kind === "agent" || user.removedAt !== null) return err("not_allowed");
  markVerified(app.db, user.id, new Date().toISOString());
  app.bus.append({
    kind: "account.email_verified",
    actorId: admin.value.id,
    payload: { username: user.username, by: "owner" },
  });
  return ok(user);
}

/** An account counts as new for this long after it is made. */
export const NEW_FOR_MS = 7 * 24 * 3_600_000;

/**
 * The lines an admin's phone hears about accounts: one per person who
 * joined in the last week and is still here. The notifier sends each id
 * once (`crew/notify.ts`).
 */
export function newAccountLines(
  db: Database,
  user: User,
  now: number = Date.now(),
): { id: string; line: string; items: readonly string[] }[] {
  if (!user.isAdmin || user.kind !== "user") return [];
  const since = new Date(now - NEW_FOR_MS).toISOString();
  return readAccounts(db)
    .filter(
      (a) =>
        a.kind === "user" &&
        !a.isAdmin &&
        a.removedAt === null &&
        a.createdAt >= since,
    )
    .map((a) => {
      const id = `account:${a.username}`;
      return {
        id,
        line: `${a.username} joined the forge${originOf(a) === "" ? "" : ` (${originOf(a)})`}`,
        items: [id],
      };
    });
}
