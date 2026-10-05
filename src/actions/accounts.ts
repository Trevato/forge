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
import { appsRuntime } from "../apps/runtime.ts";
import {
  dropCredentials,
  listAccounts as readAccounts,
  scrubAccount,
  setSuspended,
  type AccountRow,
} from "../core/accounts.ts";
import { deleteRepo as destroyRepo, listReposOwnedBy } from "../core/repos.ts";
import { listActive } from "../core/runs.ts";
import { getUserByName, type User } from "../core/users.ts";
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
): Promise<Result<User, AccountActionError>> {
  const admin = requireForgeAdmin(actor);
  if (!admin.ok) return admin;
  const found = target(app, admin.value, username);
  if (!found.ok) return found;
  const user = found.value;
  if (user.removedAt !== null) return err("not_allowed");
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

export async function removeAccount(
  app: App,
  actor: User | undefined,
  username: string,
): Promise<Result<void, AccountActionError | "delete_failed">> {
  const admin = requireForgeAdmin(actor);
  if (!admin.ok) return admin;
  const found = target(app, admin.value, username);
  if (!found.ok) return found;
  const user = found.value;
  if (user.removedAt !== null) return ok();
  // Stop it first, so nothing it owns is running while it is taken apart.
  setSuspended(app.db, user.id, new Date().toISOString());
  dropCredentials(app.db, user.id);
  await quiet(app, admin.value, user);
  const runtime = appsRuntime(app);
  for (const repo of listReposOwnedBy(app.db, user.id)) {
    if (runtime !== undefined) await runtime.teardownAll(repo.id);
    const deleted = await destroyRepo(app.db, app.reposRoot, repo);
    if (!deleted.ok) return deleted;
  }
  scrubAccount(app.db, user.id, new Date().toISOString());
  app.bus.append({
    kind: "account.removed",
    actorId: admin.value.id,
    payload: { username: user.username },
  });
  return ok();
}

const NEW_FOR_MS = 7 * 24 * 3_600_000;

/**
 * The lines an admin's phone hears about accounts: one per person who
 * joined in the last week and is still here. The notifier sends each id
 * once (`crew/notify.ts`).
 */
export function newAccountLines(
  db: Database,
  user: User,
  now: number = Date.now(),
): { id: string; line: string }[] {
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
    .map((a) => ({
      id: `account:${a.username}`,
      line: `${a.username} joined the forge${a.via === null ? "" : ` (${a.via})`}`,
    }));
}
