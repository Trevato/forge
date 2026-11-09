/**
 * Transfer a repository to another owner (#569). The caller administers the
 * repository and may create repositories under the new owner (themselves, or
 * an org they can write to — the same rule as making one there). An agent
 * never moves anything. The move is `core/transfer.ts`; the event
 * (`repo.transferred`, for the repository's readers) and the audit row
 * (`repo_transfer`, written in the move's own transaction) say who moved what
 * where.
 */

import type { App } from "../app.ts";
import { getUserByName, type User } from "../core/users.ts";
import { canAdmin, type Repo } from "../core/repos.ts";
import { transferRepo, type TransferError } from "../core/transfer.ts";
import { storageChanged } from "../core/storage.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { resolveOwner } from "./repos.ts";

export type TransferActionError = TransferError | "not_found" | "forbidden_owner" | "unknown_owner";

export const TRANSFER_SAID: Readonly<Record<Exclude<TransferActionError, "not_found">, string>> = {
  name_taken: "The new owner already has a repository by that name.",
  same_owner: "The repository already belongs to that owner.",
  move_failed: "The repository could not be moved; nothing changed.",
  forbidden_owner: "You cannot create repositories under that owner.",
  unknown_owner: "No account or organisation has that name.",
};

/** The HTTP status each refusal answers with. */
export const TRANSFER_STATUS: Readonly<Record<Exclude<TransferActionError, "not_found">, number>> = {
  name_taken: 409,
  same_owner: 409,
  move_failed: 500,
  forbidden_owner: 403,
  unknown_owner: 422,
};

export async function transferRepository(
  app: App,
  actor: User | undefined,
  repo: Repo,
  newOwner: string,
): Promise<Result<Repo, TransferActionError>> {
  if (actor === undefined || actor.kind === "agent" || !canAdmin(app.db, repo, actor)) return err("not_found");
  const target = getUserByName(app.db, newOwner);
  if (target === undefined || target.kind === "agent") return err("unknown_owner");
  const ownerId = resolveOwner(app, actor, target.username);
  if (ownerId !== target.id && !actor.isAdmin) return err("forbidden_owner");
  const moved = await transferRepo(app.db, app.reposRoot, repo, target, actor.id);
  if (!moved.ok) return moved;
  storageChanged(app, repo.ownerId);
  storageChanged(app, target.id);
  app.bus.append({
    kind: "repo.transferred",
    repoId: repo.id,
    actorId: actor.id,
    payload: {
      from: `${repo.ownerName}/${repo.name}`,
      to: `${moved.value.ownerName}/${moved.value.name}`,
    },
  });
  return ok(moved.value);
}
