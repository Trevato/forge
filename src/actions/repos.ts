/**
 * Repository actions: creating, forking, settling settings, deleting, and the
 * admin-only fixtures a repo carries (labels, webhooks). Plus the programmatic
 * write path — committing files to a branch without a git client.
 */

import { isContributionFork, type GuestRefusal } from "../core/contribute.ts";
import { contributionRefusal } from "../core/storage.ts";
import { limitValue } from "../settings/limits.ts";
import { forkLimitSpent, guestForkRefusal } from "./guests.ts";
import { requireVerified } from "./verify.ts";
import { requireAbility } from "./roles.ts";
import type { App } from "../app.ts";
import { appsRuntime } from "../apps/runtime.ts";
import { getAppByRepo } from "../core/apps.ts";
import { canSeeSealed } from "../core/sealed.ts";
import { capacityValue } from "../core/capacity.ts";
import { NEW_FOR_MS } from "./accounts.ts";
import { repositoryLimitSentence } from "../settings/quotas.ts";
import { AT_REPOSITORY_LIMIT } from "./crew_limit_words.ts";
import { storageChanged, storageRefusal, storageSentence } from "../core/storage.ts";
import {
  createLabel as insertLabel,
  deleteLabel as removeLabel,
  updateLabel as writeLabel,
  type Label,
} from "../core/issues.ts";
import { dropMirror } from "../crew/mirror.ts";
import { accessAllows, getOrg, orgAccess } from "../core/orgs.ts";
import {
  createRepo as initRepo,
  deleteRepo as destroyRepo,
  forkRepo as cloneRepo,
  getRepoById,
  getSealedFork,
  moveArchived,
  updateRepoSettings as writeSettings,
  type CreateRepoError,
  type DecisionsBy,
  type ForkRepoError,
  canAdmin,
  type Repo,
  type RepoSettings,
} from "../core/repos.ts";
import { MAX_COMMIT_BYTES, MAX_FILE_BYTES } from "./contents.ts";
import { commitIdentity } from "../core/commit_identity.ts";
import { currentDoor } from "../core/acting_via.ts";
import type { User } from "../core/users.ts";
import {
  createWebhook as insertWebhook,
  deleteWebhook as removeWebhook,
  setWebhookActive,
  type CreateWebhookError,
  type Webhook,
} from "../core/webhooks.ts";
import { resolveOid } from "../git/merge.ts";
import { repoDir, setDefaultBranch } from "../git/repos.ts";
import { isSafeRef } from "../git/guard.ts";
import {
  commitFiles,
  type CommitFilesError,
  type CommitResult,
  type FileWrite,
} from "../git/write.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { trackPullHead } from "../core/pulls.ts";
import {
  requireParticipant,
  requireRepoAdmin,
  requireUser,
  requireWriter,
  type AccessError,
} from "./access.ts";
import { validPolishShare } from "../crew/small_share.ts";
import { removeInstallCache } from "../crew/workdir.ts";
import type { SettingsChanged } from "../core/settings_changed.ts";

export interface CreateRepoInput {
  /** Owner name: the actor themselves (default) or an org they can write to. */
  owner?: string;
  name: string;
  /** @default "private" */
  visibility?: "public" | "private";
  /** @default "" */
  description?: string;
}

export type CreateRepoActionError =
  | CreateRepoError
  | "unauthorized"
  | "forbidden_owner"
  | "refused"
  | "not_member"
  | "repository_limit"
  | "storage_limit";

/**
 * The repositories limit (#2093): when the owner has set one, an account at
 * it makes no more, by create, fork or copy. Admins and agents are not held
 * to it. Only a repository the account owns itself is counted and asked: creating
 * under an organisation is not, since the quota is per account. Returns the refusal sentence ("10 of 10 repositories") or nothing.
 */
export function repositoryLimitRefusal(app: App, user: User, ownerId = user.id): string | undefined {
  if (user.isAdmin || user.kind === "agent") return undefined;
  return repositoryLimitSentence(app.db, ownerId);
}

/**
 * The sentence for a refusal just given. Always words: if a repository went
 * between the refusal and now, it still says the limit was the reason.
 */
export function repositoryLimitMessage(app: App, user: User, ownerId = user.id): string {
  return (
    repositoryLimitRefusal(app, user, ownerId) ??
    storageSentence(app, ownerId) ??
    AT_REPOSITORY_LIMIT
  );
}

/**
 * The new-account guard (`guard_new_accounts`): when it is on, an account
 * younger than a week may not create repositories or forks. Agents run the
 * crew's work and admins run the forge, so the guard is for untrusted
 * newcomers, not them. Refuses in the legacy trigger's own words.
 */
function requireNewAccountGuard(
  app: App,
  user: User,
): Result<User, "refused"> {
  if (capacityValue(app.db, "guard_new_accounts") !== "on") return ok(user);
  if (user.kind === "agent" || user.isAdmin) return ok(user);
  const ageMs = Date.now() - new Date(user.createdAt).getTime();
  return ageMs >= NEW_FOR_MS ? ok(user) : err("refused");
}

/** Resolve the owner id for a new repo: the actor, or an org they can write to. */
export function resolveOwner(
  app: App,
  actor: User,
  owner: string,
): string | undefined {
  if (owner === "" || owner.toLowerCase() === actor.username.toLowerCase())
    return actor.id;
  const org = getOrg(app.db, owner);
  if (org && accessAllows(orgAccess(app.db, org.id, actor), "write"))
    return org.id;
  return undefined;
}

export async function createRepo(
  app: App,
  actor: User | undefined,
  input: CreateRepoInput,
): Promise<Result<Repo, CreateRepoActionError | "unverified">> {
  const user = requireUser(actor);
  if (!user.ok) return user;
  const proven = requireVerified(app, user.value);
  if (!proven.ok) return proven;
  // An agent owns nothing it was not given (docs/APPS.md): it works on the
  // repositories whose crew it is on, and cannot make itself a new one.
  if (user.value.kind === "agent") return err("forbidden_owner");
  const guarded = requireNewAccountGuard(app, user.value);
  if (!guarded.ok) return guarded;
  const member = requireAbility(app, user.value, "make_it_yours");
  if (!member.ok) return member;
  const ownerId = resolveOwner(app, user.value, input.owner ?? "");
  if (ownerId === undefined) return err("forbidden_owner");
  if (ownerId === user.value.id && repositoryLimitRefusal(app, user.value) !== undefined)
    return err("repository_limit");
  if ((await storageRefusal(app, user.value, ownerId)) !== undefined) return err("storage_limit");
  const created = await initRepo(app.db, app.reposRoot, {
    ownerId,
    name: input.name,
    visibility: input.visibility ?? "private",
    description: input.description ?? "",
  });
  if (!created.ok) return created;
  storageChanged(app, ownerId);
  app.bus.append({
    kind: "repo.created",
    repoId: created.value.id,
    actorId: user.value.id,
    payload: doorPayload(user.value.id),
  });
  return created;
}

/** How the actor came in (`core/acting_via.ts`); a conversation is the event's own `via`. */
const doorPayload = (actorId: string): Record<string, string> => {
  const door = currentDoor(actorId);
  return door === undefined ? {} : { door };
};

/**
 * How many forks one person may make in any 24 hours (#853, #888): each may
 * become an app that deploys at once. Counted from the ledger of forks made,
 * so deleting one makes no room. The crew's agents fork per issue to work —
 * bounded instead by the crew's own concurrency and spend ceilings, since an
 * agent forks only for a run — and the forge's own admin answers for its
 * forge: neither is held to it.
 */
export const FORKS_PER_DAY = 5;

export async function forkRepo(
  app: App,
  actor: User | undefined,
  parent: Repo,
  name?: string,
  options: { visibility?: "public" | "private"; now?: number } = {},
): Promise<Result<Repo, ForkRepoError | GuestRefusal | "not_found" | "unauthorized" | "unverified" | "refused" | "not_member" | "repository_limit" | "storage_limit">> {
  const user = requireParticipant(app, actor, parent);
  if (!user.ok) return user;
  const proven = requireVerified(app, user.value);
  if (!proven.ok) return proven;
  const guarded = requireNewAccountGuard(app, user.value);
  if (!guarded.ok) return guarded;
  // A guest forks to contribute: public parents only, always public, marked in
  // the row's own write so the fork is never an ordinary one for a moment.
  const contribution = !requireAbility(app, user.value, "make_it_yours").ok;
  if (contribution) {
    const refused = await guestForkRefusal(app, user.value, parent, options.now ?? Date.now());
    if (refused !== undefined) return err(refused);
  }
  if (repositoryLimitRefusal(app, user.value) !== undefined) return err("repository_limit");
  if ((await storageRefusal(app, user.value, user.value.id)) !== undefined)
    return err("storage_limit");
  const forked = await cloneRepo(
    app.db,
    app.reposRoot,
    parent,
    user.value.id,
    name,
    contribution
      ? {
          ...options,
          visibility: "public",
          contribution: true,
          perDay: limitValue(app.db, "guest.forks_per_day"),
          forgePerDay: limitValue(app.db, "guest.forks_forge_per_day"),
        }
      : {
          ...options,
          ...(user.value.kind === "agent" || user.value.isAdmin ? {} : { perDay: FORKS_PER_DAY }),
        },
  );
  if (!forked.ok) {
    if (!contribution || forked.error !== "limit") return forked;
    return err(forkLimitSpent(app, options.now ?? Date.now()));
  }
  storageChanged(app, user.value.id);
  app.bus.append({
    kind: "repo.forked",
    repoId: forked.value.id,
    actorId: user.value.id,
    payload: { parent: `${parent.ownerName}/${parent.name}` },
  });
  return forked;
}

/**
 * The private repository an agent works `base`'s sealed reports in
 * (`core/sealed.ts`), made on first need: private, out of the fork graph,
 * read by the base's writers and crew only. No event: its existence is
 * nobody else's to hear of.
 */
export async function sealedForkFor(
  app: App,
  agent: User,
  base: Repo,
): Promise<Result<Repo, ForkRepoError>> {
  const existing = getSealedFork(app.db, agent.id, base.id);
  if (existing !== undefined) return ok(existing);
  const made = await cloneRepo(
    app.db,
    app.reposRoot,
    base,
    agent.id,
    undefined,
    { sealed: true },
  );
  if (made.ok || made.error !== "name_taken") return made;
  return cloneRepo(
    app.db,
    app.reposRoot,
    base,
    agent.id,
    `${base.ownerName}-${base.name}-sealed`,
    { sealed: true },
  );
}

/**
 * The private repository a writer fixes this sealed report in by hand
 * (#865's review): the same one the crew uses, made on first need, owned
 * by the writer and read by the base's writers and crew only. A branch on
 * the base or on a public fork is public; this is the place that is not.
 * Anyone who may not see sealed reports here gets `not_found`, as for a
 * report they cannot see; an issue that is not sealed has nothing to hide.
 */
export async function privateRepoForSealed(
  app: App,
  actor: User | undefined,
  base: Repo,
  issue: { readonly sealed: boolean },
): Promise<Result<Repo, ForkRepoError | "not_found" | "not_sealed" | "unverified">> {
  if (!actor || !canSeeSealed(app.db, base, actor)) return err("not_found");
  if (!issue.sealed) return err("not_sealed");
  const proven = requireVerified(app, actor);
  if (!proven.ok) return proven;
  return sealedForkFor(app, actor, base);
}

export type UpdateSettingsError = "not_found" | "unknown_branch" | "polish_share";

/** Each repository's archive transitions, one after another. */
const archiveTurns = new WeakMap<App, Map<string, Promise<void>>>();

/** Run `work` after every archive transition already asked of `repoId`. */
function inTurn<T>(app: App, repoId: string, work: () => Promise<T>): Promise<T> {
  let turns = archiveTurns.get(app);
  if (turns === undefined) {
    turns = new Map();
    archiveTurns.set(app, turns);
  }
  const queue = turns;
  const turn = (queue.get(repoId) ?? Promise.resolve()).then(work);
  const tail = turn.then(
    () => {},
    () => {},
  );
  queue.set(repoId, tail);
  void tail.then(() => {
    if (queue.get(repoId) === tail) queue.delete(repoId);
  });
  return turn;
}

/**
 * Archive (true) or wake (false), and act on it only if this call moved the
 * repository (`moveArchived`). The write and its effect take one turn per
 * repository, so a Wake asked while an Archive is still stopping the app
 * starts it after that stop, not before it. True when this call moved it.
 */
function moveArchive(app: App, repoId: string, archived: boolean): Promise<boolean> {
  return inTurn(app, repoId, async () => {
    if (!moveArchived(app.db, repoId, archived)) return false;
    const runtime = appsRuntime(app);
    if (runtime === undefined) return true;
    // Archiving puts the app away: production and every preview stop through
    // the runtime's ordinary stop; their data stays where it is.
    if (archived) {
      await runtime.stopRepo(repoId);
      return true;
    }
    // Waking brings production back from the default branch on the same data
    // directory; a preview returns on its pull's next push.
    const woken = getRepoById(app.db, repoId);
    const record = getAppByRepo(app.db, repoId);
    if (woken !== undefined && record !== undefined)
      await runtime.reconcileApp(record, woken, "wake", "production");
    return true;
  });
}

/** The settings `updateRepoSettings` audits, in the order the trail names them. */
const AUDITED = [
  "visibility",
  "description",
  "protectDefault",
  "defaultBranch",
  "requireReview",
  "requireChecks",
  "crewOutsiders",
  "decisionsBy",
  "plansNeedNod",
  "autonomySlots",
  "plannerSlots",
  "reviewerSlots",
  "polishShare",
] as const;

export type { SettingsChanged };

/** Each audited setting `settings` moves on `repo`, from what to what. */
export function settingsChanged(repo: Repo, settings: RepoSettings): SettingsChanged {
  const changed: SettingsChanged = {};
  for (const k of AUDITED) {
    const to = settings[k];
    if (to !== undefined && to !== repo[k]) changed[k] = { from: repo[k], to };
  }
  return changed;
}

/**
 * Change settings. A new default branch must exist; git HEAD is moved first
 * and the row follows (git is truth, the index is derived from it).
 */
export async function updateRepoSettings(
  app: App,
  actor: User | undefined,
  repo: Repo,
  settings: RepoSettings,
): Promise<Result<Repo, UpdateSettingsError>> {
  const admin = requireRepoAdmin(app, actor, repo);
  if (!admin.ok) return admin;
  // Who the crew obeys, and whether the repository is archived, are a
  // person's call: an agent never changes them, even one on a team that
  // administers the repository (`crew/direct.ts`).
  if (
    (settings.crewOutsiders !== undefined ||
      settings.decisionsBy !== undefined ||
      settings.plansNeedNod !== undefined ||
      settings.archived !== undefined) &&
    admin.value.kind === "agent"
  )
    return err("not_found");
  // The work on a sealed report stays private until it merges into its
  // base, whoever owns it (`core/sealed.ts`).
  if (repo.sealedFor !== null && settings.visibility === "public")
    return err("not_found");
  if (settings.polishShare !== undefined && !validPolishShare(settings.polishShare))
    return err("polish_share");
  const branch = settings.defaultBranch;
  if (branch !== undefined && branch !== repo.defaultBranch) {
    const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
    if (!isSafeRef(branch) || !(await resolveOid(dir, `refs/heads/${branch}`)))
      return err("unknown_branch");
    const moved = await setDefaultBranch(dir, branch);
    if (!moved.ok) return err("unknown_branch");
  }
  const { archived, ...rest } = settings;
  writeSettings(app.db, repo, rest);
  const moved =
    archived === undefined ? false : await moveArchive(app, repo.id, archived);
  const updated = getRepoById(app.db, repo.id);
  if (updated === undefined) return err("not_found");
  // `changed` is the audit line: each setting this call moved, from what to
  // what. None of these is a secret; a secret setting would say only
  // that it changed (`{ secret: true }`), never its value.
  const changed = settingsChanged(repo, settings);
  if (moved) changed["archived"] = { from: !archived, to: archived === true };
  app.bus.append({
    kind: "repo.settings_updated",
    repoId: repo.id,
    actorId: admin.value.id,
    payload: { changed },
  });
  // Who may start and steer the crew is its own line in the record, on and
  // off: on is a door opened to everyone who can read (`crew/direct.ts`).
  if ("crewOutsiders" in changed)
    app.bus.append({
      kind: "repo.crew_outsiders",
      repoId: repo.id,
      actorId: admin.value.id,
      payload: { on: updated.crewOutsiders },
    });
  return ok(updated);
}

export interface OutsidersAnswer {
  /** Whether outsiders may trigger the crew, after this call. */
  readonly on: boolean;
  /** Whether they could before it. */
  readonly was: boolean;
  /** Nothing changed: this was the plan. */
  readonly dryRun: boolean;
}

/**
 * "Outsiders may trigger the crew", on or off — the web form's switch for
 * the API and the MCP. A repository admin's, never an agent's; a dry run
 * answers what would change and changes nothing.
 */
export async function setCrewOutsiders(
  app: App,
  actor: User | undefined,
  repo: Repo,
  on: boolean,
  dryRun: boolean,
): Promise<Result<OutsidersAnswer, "not_found">> {
  const admin = requireRepoAdmin(app, actor, repo);
  if (!admin.ok || admin.value.kind === "agent") return err("not_found");
  if (dryRun) return ok({ on, was: repo.crewOutsiders, dryRun });
  const updated = await updateRepoSettings(app, actor, repo, {
    crewOutsiders: on,
  });
  if (!updated.ok) return err("not_found");
  return ok({ on: updated.value.crewOutsiders, was: repo.crewOutsiders, dryRun });
}

export interface DecisionsAnswer {
  /** Who answers the repository's decisions, after this call. */
  readonly by: DecisionsBy;
  /** Who did before it. */
  readonly was: DecisionsBy;
  /** Nothing changed: this was the plan. */
  readonly dryRun: boolean;
}

/**
 * The standing rule for the decisions a repository asks of its owner, for
 * the MCP and the terminal — the web form's choice. A repository admin's,
 * never an agent's; a dry run answers what would change and changes nothing.
 */
export async function setDecisionsBy(
  app: App,
  actor: User | undefined,
  repo: Repo,
  by: DecisionsBy,
  dryRun: boolean,
): Promise<Result<DecisionsAnswer, "not_found">> {
  const admin = requireRepoAdmin(app, actor, repo);
  if (!admin.ok || admin.value.kind === "agent") return err("not_found");
  if (dryRun) return ok({ by, was: repo.decisionsBy, dryRun });
  const updated = await updateRepoSettings(app, actor, repo, {
    decisionsBy: by,
  });
  if (!updated.ok) return err("not_found");
  return ok({ by: updated.value.decisionsBy, was: repo.decisionsBy, dryRun });
}

export interface ArchiveAnswer {
  /** Whether the repository is archived, after this call. */
  readonly archived: boolean;
  /** Whether it was before. */
  readonly was: boolean;
  /** Nothing changed: this was the plan. */
  readonly dryRun: boolean;
}

/**
 * Archive (true) or wake (false) a repository, for the MCP: the same
 * `updateRepoSettings` the API's PATCH goes through. A repository admin's,
 * never an agent's; a dry run answers what would change and changes nothing.
 */
export async function setArchived(
  app: App,
  actor: User | undefined,
  repo: Repo,
  archived: boolean,
  dryRun: boolean,
): Promise<Result<ArchiveAnswer, "not_found">> {
  const admin = requireRepoAdmin(app, actor, repo);
  if (!admin.ok || admin.value.kind === "agent") return err("not_found");
  const was = repo.archivedAt !== null;
  if (dryRun) return ok({ archived, was, dryRun });
  const updated = await updateRepoSettings(app, actor, repo, { archived });
  if (!updated.ok) return err("not_found");
  return ok({ archived: updated.value.archivedAt !== null, was, dryRun });
}

export async function deleteRepo(
  app: App,
  actor: User | undefined,
  repo: Repo,
): Promise<Result<void, "not_found" | "delete_failed" | "has_pulls">> {
  // A guest administers nothing, but may always delete their own fork: it is
  // how they make room, and the day's count of forks stands.
  const admin =
    actor !== undefined && actor.id === repo.ownerId && isContributionFork(app.db, repo.id)
      ? ok(actor)
      : requireRepoAdmin(app, actor, repo);
  if (!admin.ok) return admin;
  const deleted = await destroyRepo(app.db, app.reposRoot, repo);
  if (!deleted.ok) return deleted;
  await removeInstallCache(app.config.dataDir, repo.id);
  dropMirror(app.config.dataDir, repo.id);
  storageChanged(app, repo.ownerId);
  // The row is gone (events cascade with it), so the event names it: a private
  // one's name is for those who answer for it (`core/event_audience.ts`).
  app.bus.append({
    kind: "repo.deleted",
    actorId: admin.value.id,
    payload: {
      repo: `${repo.ownerName}/${repo.name}`,
      visibility: repo.visibility,
      ownerId: repo.ownerId,
      ...doorPayload(admin.value.id),
    },
  });
  return ok();
}

export function createLabel(
  app: App,
  actor: User | undefined,
  repo: Repo,
  name: string,
  color: string,
): Result<Label, "not_found" | "invalid" | "taken"> {
  const admin = requireRepoAdmin(app, actor, repo);
  if (!admin.ok) return admin;
  const created = insertLabel(app.db, repo.id, name, color);
  if (!created.ok) return created;
  app.bus.append({
    kind: "label.created",
    repoId: repo.id,
    actorId: admin.value.id,
    payload: { labelId: created.value.id, name: created.value.name },
  });
  return created;
}

/** Rename or recolor an existing label; the chips follow everywhere it is used. */
export function updateLabel(
  app: App,
  actor: User | undefined,
  repo: Repo,
  labelId: string,
  name: string,
  color: string,
): Result<Label, "not_found" | "invalid" | "taken"> {
  const admin = requireRepoAdmin(app, actor, repo);
  if (!admin.ok) return admin;
  const updated = writeLabel(app.db, repo.id, labelId, name, color);
  if (!updated.ok) return updated;
  app.bus.append({
    kind: "label.updated",
    repoId: repo.id,
    actorId: admin.value.id,
    payload: { labelId, name: updated.value.name },
  });
  return updated;
}

export function deleteLabel(
  app: App,
  actor: User | undefined,
  repo: Repo,
  labelId: string,
): Result<void, "not_found"> {
  const admin = requireRepoAdmin(app, actor, repo);
  if (!admin.ok) return admin;
  if (!removeLabel(app.db, repo.id, labelId)) return err("not_found");
  app.bus.append({
    kind: "label.deleted",
    repoId: repo.id,
    actorId: admin.value.id,
    payload: { labelId },
  });
  return ok();
}

export interface CreateWebhookInput {
  url: string;
  /** @default "*" */
  kinds?: string;
  /** Generated when omitted, so deliveries are always signed. */
  secret?: string;
}

export function createWebhook(
  app: App,
  actor: User | undefined,
  repo: Repo,
  input: CreateWebhookInput,
): Result<
  { webhook: Webhook; secret: string },
  "not_found" | CreateWebhookError
> {
  const admin = requireRepoAdmin(app, actor, repo);
  if (!admin.ok) return admin;
  const created = insertWebhook(app.db, {
    repoId: repo.id,
    url: input.url,
    kinds: input.kinds ?? "*",
    ...(input.secret !== undefined ? { secret: input.secret } : {}),
  });
  if (!created.ok) return created;
  // The secret never enters the outbox: this event is itself delivered.
  app.bus.append({
    kind: "webhook.created",
    repoId: repo.id,
    actorId: admin.value.id,
    payload: {
      webhookId: created.value.webhook.id,
      url: created.value.webhook.url,
    },
  });
  return created;
}

export function deleteWebhook(
  app: App,
  actor: User | undefined,
  repo: Repo,
  webhookId: string,
): Result<void, "not_found"> {
  const admin = requireRepoAdmin(app, actor, repo);
  if (!admin.ok) return admin;
  if (!removeWebhook(app.db, repo.id, webhookId)) return err("not_found");
  app.bus.append({
    kind: "webhook.deleted",
    repoId: repo.id,
    actorId: admin.value.id,
    payload: { webhookId },
  });
  return ok();
}

export function pauseWebhook(
  app: App,
  actor: User | undefined,
  repo: Repo,
  webhookId: string,
  paused: boolean,
): Result<void, "not_found"> {
  const admin = requireRepoAdmin(app, actor, repo);
  if (!admin.ok) return admin;
  if (!setWebhookActive(app.db, repo.id, webhookId, !paused))
    return err("not_found");
  app.bus.append({
    kind: paused ? "webhook.paused" : "webhook.resumed",
    repoId: repo.id,
    actorId: admin.value.id,
    payload: { webhookId },
  });
  return ok();
}

export type CommitToBranchError =
  | AccessError
  | CommitFilesError
  | { kind: "protected_branch"; branch: string }
  | { kind: "file_too_large"; path: string; bytes: number }
  | { kind: "commit_too_large"; bytes: number }
  | { kind: "storage_limit" };

export interface CommitToBranchInput {
  /** @default the repo's default branch */
  branch?: string;
  /** A new branch forks from here so it shares history. @default the default branch */
  base?: string;
  /** @default "Update files" */
  message?: string;
  files: readonly FileWrite[];
  /** Refuse with branch_moved unless the branch is at this commit now. */
  expectTip?: string;
}

/**
 * Commit files to a branch on the actor's behalf. `update-ref` runs no hooks,
 * so the push event is announced here — webhooks, SSE, and CI see it exactly
 * as they would a `git push`.
 */
export async function commitToBranch(
  app: App,
  actor: User | undefined,
  repo: Repo,
  input: CommitToBranchInput,
): Promise<Result<CommitResult, CommitToBranchError>> {
  const writer = requireWriter(app, actor, repo);
  if (!writer.ok) return writer;
  // A commit through the API adds to a guest's fork as a push does.
  if ((await contributionRefusal(app, writer.value.id, repo, writer.value)) !== undefined)
    return err({ kind: "storage_limit" });
  const branch = input.branch || repo.defaultBranch;
  // The same mechanical rules `editFiles` applies: a protected default takes
  // commits from repo admins only, and no file or commit is unbounded.
  if (
    branch === repo.defaultBranch &&
    repo.protectDefault &&
    !canAdmin(app.db, repo, writer.value)
  )
    return err({ kind: "protected_branch", branch });
  let total = 0;
  for (const file of input.files) {
    if (file.content === null) continue;
    const bytes =
      typeof file.content === "string"
        ? Buffer.byteLength(file.content, "utf8")
        : file.content.length;
    if (bytes > MAX_FILE_BYTES)
      return err({ kind: "file_too_large", path: file.path, bytes });
    total += bytes;
  }
  if (total > MAX_COMMIT_BYTES)
    return err({ kind: "commit_too_large", bytes: total });
  const startPoint = input.base || repo.defaultBranch;
  const committed = await commitFiles(
    repoDir(app.reposRoot, repo.ownerName, repo.name),
    {
      branch,
      ...(branch !== startPoint ? { startPoint } : {}),
      message: input.message || "Update files",
      files: input.files,
      ...(input.expectTip !== undefined ? { expectTip: input.expectTip } : {}),
      author: commitIdentity(app.config, writer.value),
    },
  );
  if (!committed.ok) return committed;
  // A same-repo pull whose head is this branch follows the commit before
  // anything hears about it, so a check or a deploy triggered below never
  // reads a row the branch has already moved past.
  trackPullHead(app.db, repo.id, branch, committed.value.commitOid);
  app.bus.append({
    kind: "push",
    repoId: repo.id,
    actorId: writer.value.id,
    payload: {
      updates: [
        { ref: `refs/heads/${branch}`, newOid: committed.value.commitOid },
      ],
      viaApi: true,
    },
  });
  return committed;
}
