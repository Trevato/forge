/**
 * The people a private app names (#752): who may read the list, who may
 * change it, and who may be on it. The settings page, the API and the MCP
 * tool `app_members` all answer from here.
 *
 * - Read and changed by people who can write the repository — never by an
 *   agent, even one that can: who may enter is a person's decision.
 * - A name is a person's account in good standing: not an organisation, not
 *   an agent (the crew enters already), not a suspended or removed account.
 * - Being named lets someone enter the app and its previews, nothing more
 *   (`canEnterApp`). Removing a name ends a grant already issued: the proxy
 *   asks again on every request.
 * - A change is planned unless `dryRun` is false: the answer says who would
 *   be added and removed.
 */

import type { App } from "../app.ts";
import { appMembers, setAppMembers } from "../core/app_members.ts";
import { getAppByRepo } from "../core/apps.ts";
import { canWrite, type Repo } from "../core/repos.ts";
import { getUserByName, isActive, type User } from "../core/users.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { requireReader } from "./access.ts";

/** The most names one app may hold. */
export const MAX_APP_MEMBERS = 100;

export type AppMembersError =
  | { readonly kind: "not_found" }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "forbidden" }
  | { readonly kind: "invalid"; readonly message: string };

export interface AppMembersView {
  readonly access: "public" | "private";
  readonly members: readonly string[];
}

export interface AppMembersChange extends AppMembersView {
  readonly dryRun: boolean;
  readonly added: readonly string[];
  readonly removed: readonly string[];
}

/** The app and its writer, or why not: a person who can write, never an agent. */
function gate(
  app: App,
  actor: User | undefined,
  repo: Repo,
): Result<
  { appId: string; access: "public" | "private"; by: User },
  AppMembersError
> {
  if (!requireReader(app, actor, repo).ok) return err({ kind: "not_found" });
  if (actor === undefined) return err({ kind: "unauthorized" });
  if (actor.kind === "agent" || !canWrite(app.db, repo, actor))
    return err({ kind: "forbidden" });
  const record = getAppByRepo(app.db, repo.id);
  if (record === undefined) return err({ kind: "not_found" });
  return ok({ appId: record.id, access: record.access, by: actor });
}

export function readAppMembers(
  app: App,
  actor: User | undefined,
  repo: Repo,
): Result<AppMembersView, AppMembersError> {
  const gated = gate(app, actor, repo);
  if (!gated.ok) return gated;
  return ok({
    access: gated.value.access,
    members: appMembers(app.db, gated.value.appId).map((m) => m.username),
  });
}

export function setAppMembersThrough(
  app: App,
  actor: User | undefined,
  repo: Repo,
  input: { readonly members: readonly string[]; readonly dryRun?: boolean },
): Result<AppMembersChange, AppMembersError> {
  const gated = gate(app, actor, repo);
  if (!gated.ok) return gated;
  const names = [
    ...new Set(input.members.map((n) => n.trim()).filter((n) => n !== "")),
  ];
  if (names.length > MAX_APP_MEMBERS)
    return err({
      kind: "invalid",
      message: `name at most ${MAX_APP_MEMBERS} people`,
    });
  const people: User[] = [];
  for (const name of names) {
    const user = getUserByName(app.db, name);
    if (user === undefined || user.kind !== "user" || !isActive(user))
      return err({
        kind: "invalid",
        message: `${name.slice(0, 60)} is not a person's account here`,
      });
    if (!people.some((p) => p.id === user.id)) people.push(user);
  }
  const before = appMembers(app.db, gated.value.appId).map((m) => m.username);
  const after = people
    .map((p) => p.username)
    .sort((a, b) => a.localeCompare(b));
  const dryRun = input.dryRun !== false;
  if (!dryRun)
    setAppMembers(
      app.db,
      gated.value.appId,
      people.map((p) => p.id),
      gated.value.by.id,
    );
  return ok({
    dryRun,
    access: gated.value.access,
    members: after,
    added: after.filter((n) => !before.includes(n)),
    removed: before.filter((n) => !after.includes(n)),
  });
}
