/**
 * Holding new work on a file and letting it go (`crew/file_holds.ts`, #6522).
 *
 * An admin of the repository decides, a person or an agent that is one; a
 * reader and a stranger get the one `not_found` every admin door gives.
 * `by` is the verified actor, never a value from the request. `dry` checks
 * everything and writes nothing.
 */

import type { App } from "../app.ts";
import { canAdmin, canRead, type Repo } from "../core/repos.ts";
import { getUserById, type User } from "../core/users.ts";
import {
  checkHoldPath,
  heldFiles,
  holdFile,
  releaseFile,
  type FileHold,
} from "../crew/file_holds.ts";
import { err, ok, type Result } from "../kernel/result.ts";

export type FileHoldError = "unauthorized" | "not_found" | "invalid_path";

/** A hold with the name of the person who set it. */
export interface NamedHold extends FileHold {
  readonly byName: string;
}

function nameHold(app: App, hold: FileHold): NamedHold {
  return { ...hold, byName: getUserById(app.db, hold.by)?.username ?? "someone" };
}

function requireAdmin(app: App, actor: User | undefined, repo: Repo): Result<User, FileHoldError> {
  if (!canRead(app.db, repo, actor)) return err("not_found");
  if (!actor) return err("unauthorized");
  return canAdmin(app.db, repo, actor) ? ok(actor) : err("not_found");
}

/** Every file held in `repo`, for an admin of it; anyone else is told nothing. */
export function listFileHolds(app: App, actor: User | undefined, repo: Repo): Result<NamedHold[], FileHoldError> {
  const admin = requireAdmin(app, actor, repo);
  if (!admin.ok) return admin;
  return ok(heldFiles(app.db, repo.id).map((h) => nameHold(app, h)));
}

/** Hold new work on `path`; the hold names `actor`. */
export function holdFileAs(
  app: App,
  actor: User | undefined,
  repo: Repo,
  path: unknown,
  dry = false,
): Result<NamedHold, FileHoldError> {
  const admin = requireAdmin(app, actor, repo);
  if (!admin.ok) return admin;
  const checked = checkHoldPath(path);
  if (!checked.ok) return err("invalid_path");
  if (dry) {
    const standing = heldFiles(app.db, repo.id).find((h) => h.path === checked.value);
    return ok(nameHold(app, standing ?? { repoId: repo.id, path: checked.value, by: admin.value.id, at: new Date().toISOString() }));
  }
  const held = holdFile(app.db, repo.id, checked.value, admin.value.id);
  if (!held.ok) return err("invalid_path");
  app.bus.append({
    kind: "repo.file_held",
    repoId: repo.id,
    actorId: admin.value.id,
    payload: { path: held.value.path },
  });
  return ok(nameHold(app, held.value));
}

/** Lift the hold on `path`; whether there was one. */
export function releaseFileAs(
  app: App,
  actor: User | undefined,
  repo: Repo,
  path: unknown,
  dry = false,
): Result<boolean, FileHoldError> {
  const admin = requireAdmin(app, actor, repo);
  if (!admin.ok) return admin;
  const checked = checkHoldPath(path);
  if (!checked.ok) return err("invalid_path");
  if (dry) return ok(heldFiles(app.db, repo.id).some((h) => h.path === checked.value));
  const released = releaseFile(app.db, repo.id, checked.value);
  if (released)
    app.bus.append({
      kind: "repo.file_released",
      repoId: repo.id,
      actorId: admin.value.id,
      payload: { path: checked.value },
    });
  return ok(released);
}
