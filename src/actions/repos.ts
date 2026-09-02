/**
 * Repository actions: creating, forking, settling settings, deleting, and the
 * admin-only fixtures a repo carries (labels, webhooks). Plus the programmatic
 * write path — committing files to a branch without a git client.
 */

import type { App } from "../app.ts";
import {
  createLabel as insertLabel,
  deleteLabel as removeLabel,
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
import { repoDir } from "../git/repos.ts";
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

export function updateRepoSettings(
  app: App,
  actor: User | undefined,
  repo: Repo,
  settings: RepoSettings,
): Result<Repo, "not_found"> {
  const admin = requireRepoAdmin(app, actor, repo);
  if (!admin.ok) return admin;
  return ok(writeSettings(app.db, repo, settings));
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
  return insertLabel(app.db, repo.id, name, color);
}

export function deleteLabel(
  app: App,
  actor: User | undefined,
  repo: Repo,
  labelId: string,
): Result<void, "not_found"> {
  const admin = requireRepoAdmin(app, actor, repo);
  if (!admin.ok) return admin;
  return removeLabel(app.db, repo.id, labelId) ? ok() : err("not_found");
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
  return insertWebhook(app.db, {
    repoId: repo.id,
    url: input.url,
    kinds: input.kinds ?? "*",
    ...(input.secret !== undefined ? { secret: input.secret } : {}),
  });
}

export function deleteWebhook(
  app: App,
  actor: User | undefined,
  repo: Repo,
  webhookId: string,
): Result<void, "not_found"> {
  const admin = requireRepoAdmin(app, actor, repo);
  if (!admin.ok) return admin;
  return removeWebhook(app.db, repo.id, webhookId) ? ok() : err("not_found");
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
