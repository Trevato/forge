/**
 * Repository actions: creating, forking, settling settings, deleting, and the
 * admin-only fixtures a repo carries (labels, webhooks). Plus the programmatic
 * write path — committing files to a branch without a git client.
 */

import type { App } from "../app.ts";
import {
  createLabel as insertLabel,
  deleteLabel as removeLabel,
  updateLabel as writeLabel,
  type Label,
} from "../core/issues.ts";
import { accessAllows, getOrg, orgAccess } from "../core/orgs.ts";
import {
  createRepo as initRepo,
  deleteRepo as destroyRepo,
  forkRepo as cloneRepo,
  updateRepoSettings as writeSettings,
  type CreateRepoError,
  type ForkRepoError,
  type Repo,
  type RepoSettings,
} from "../core/repos.ts";
import type { User } from "../core/users.ts";
import {
  createWebhook as insertWebhook,
  deleteWebhook as removeWebhook,
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
import {
  requireParticipant,
  requireRepoAdmin,
  requireUser,
  requireWriter,
  type AccessError,
} from "./access.ts";

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
  | "forbidden_owner";

/** Resolve the owner id for a new repo: the actor, or an org they can write to. */
function resolveOwner(
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
): Promise<Result<Repo, CreateRepoActionError>> {
  const user = requireUser(actor);
  if (!user.ok) return user;
  const ownerId = resolveOwner(app, user.value, input.owner ?? "");
  if (ownerId === undefined) return err("forbidden_owner");
  const created = await initRepo(app.db, app.reposRoot, {
    ownerId,
    name: input.name,
    visibility: input.visibility ?? "private",
    description: input.description ?? "",
  });
  if (!created.ok) return created;
  app.bus.append({
    kind: "repo.created",
    repoId: created.value.id,
    actorId: user.value.id,
  });
  return created;
}

export async function forkRepo(
  app: App,
  actor: User | undefined,
  parent: Repo,
  name?: string,
): Promise<Result<Repo, ForkRepoError | "not_found" | "unauthorized">> {
  const user = requireParticipant(app, actor, parent);
  if (!user.ok) return user;
  const forked = await cloneRepo(
    app.db,
    app.reposRoot,
    parent,
    user.value.id,
    name,
  );
  if (!forked.ok) return forked;
  app.bus.append({
    kind: "repo.forked",
    repoId: forked.value.id,
    actorId: user.value.id,
    payload: { parent: `${parent.ownerName}/${parent.name}` },
  });
  return forked;
}

export type UpdateSettingsError = "not_found" | "unknown_branch";

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
  const branch = settings.defaultBranch;
  if (branch !== undefined && branch !== repo.defaultBranch) {
    const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
    if (!isSafeRef(branch) || !(await resolveOid(dir, `refs/heads/${branch}`)))
      return err("unknown_branch");
    const moved = await setDefaultBranch(dir, branch);
    if (!moved.ok) return err("unknown_branch");
  }
  const updated = writeSettings(app.db, repo, settings);
  const changed = (
    ["visibility", "description", "protectDefault", "defaultBranch"] as const
  ).filter((k) => settings[k] !== undefined && settings[k] !== repo[k]);
  app.bus.append({
    kind: "repo.settings_updated",
    repoId: repo.id,
    actorId: admin.value.id,
    payload: { changed },
  });
  return ok(updated);
}

export async function deleteRepo(
  app: App,
  actor: User | undefined,
  repo: Repo,
): Promise<Result<void, "not_found" | "delete_failed">> {
  const admin = requireRepoAdmin(app, actor, repo);
  if (!admin.ok) return admin;
  const deleted = await destroyRepo(app.db, app.reposRoot, repo);
  if (!deleted.ok) return deleted;
  // The row is gone (events cascade with it), so this event carries no repo.
  app.bus.append({ kind: "repo.deleted", actorId: admin.value.id });
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

export interface CommitToBranchInput {
  /** @default the repo's default branch */
  branch?: string;
  /** A new branch forks from here so it shares history. @default the default branch */
  base?: string;
  /** @default "Update files" */
  message?: string;
  files: readonly FileWrite[];
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
): Promise<Result<CommitResult, AccessError | CommitFilesError>> {
  const writer = requireWriter(app, actor, repo);
  if (!writer.ok) return writer;
  const branch = input.branch || repo.defaultBranch;
  const startPoint = input.base || repo.defaultBranch;
  const committed = await commitFiles(
    repoDir(app.reposRoot, repo.ownerName, repo.name),
    {
      branch,
      ...(branch !== startPoint ? { startPoint } : {}),
      message: input.message || "Update files",
      files: input.files,
      author: {
        name: writer.value.displayName || writer.value.username,
        email: writer.value.email,
      },
    },
  );
  if (!committed.ok) return committed;
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
