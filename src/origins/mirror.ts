/**
 * Bringing a repository in. A mirror is an ordinary local repo — same bare
 * directory, same hooks, same access checks — that happens to know where it
 * came from. Nothing downstream needs a special case; `repo.origin` is the
 * only difference, and it is what makes writes go out before they land.
 *
 * Order matters, and it is the same ordering `createRepo` already keeps: the
 * git directory becomes durable before the row that references it, so a
 * visible repo is always a clonable one. Here that extends one step further —
 * the row exists before the first fetch, because a fetch that fails should
 * leave a mirror you can retry, not a half-created nothing.
 */

import type { App } from "../app.ts";
import {
  getOriginRepo,
  linkRepoToOrigin,
  rememberOriginRepo,
  type Origin,
} from "../core/origins.ts";
import { createRepo, getRepoById, type Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { isSafeName } from "../git/guard.ts";
import { repoDir } from "../git/repos.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { providerForOrigin } from "./credential.ts";
import { adoptDefaultBranch, configureMirror } from "./git-mirror.ts";
import { syncOrigin } from "./sync.ts";
import type { RemoteRepo } from "./types.ts";

export type MirrorError =
  | "not_found"
  | "invalid_name"
  | "name_taken"
  | "already_mirrored"
  | "git_init_failed"
  | "unreachable";

export interface MirrorResult {
  readonly repo: Repo;
  readonly remote: RemoteRepo;
}

/**
 * Mirror `fullName` from `origin` into the actor's namespace.
 *
 * Visibility follows the origin's, and it follows it on every later sync too
 * — a repo flipped to private upstream must not stay readable here. An
 * `internal` Forgejo repo has no local analogue and becomes private: never
 * silently widen a visibility on import.
 */
export async function mirrorRepo(
  app: App,
  actor: User,
  origin: Origin,
  fullName: string,
  name?: string,
): Promise<Result<MirrorResult, MirrorError>> {
  const provider = providerForOrigin(app, origin);
  if (!provider.ok) return err("not_found");

  const fetched = await provider.value.getRepo(fullName);
  if (!fetched.ok)
    return err(
      fetched.error.error === "not_found" ? "not_found" : "unreachable",
    );
  const remote = fetched.value;
  if (remote.cloneUrl === "") return err("unreachable");

  // Cache the picker row first: it is where the clone URL lives, and the
  // sync pass reads it back from there.
  rememberOriginRepo(app.db, origin.id, remote);
  const already = getOriginRepo(app.db, origin.id, remote.fullName);
  if (already?.mirroredAs != null) return err("already_mirrored");

  const wanted = name ?? remote.name;
  const chosen = availableName(app, actor.id, wanted, origin);
  if (chosen === undefined) return err("name_taken");

  const created = await createRepo(app.db, app.reposRoot, {
    ownerId: actor.id,
    name: chosen,
    visibility: remote.private ? "private" : "public",
    description: remote.description,
    defaultBranch: remote.defaultBranch,
  });
  if (!created.ok) return err(created.error);

  linkRepoToOrigin(app.db, created.value.id, {
    originId: origin.id,
    fullName: remote.fullName,
    remoteId: remote.remoteId,
    htmlUrl: remote.htmlUrl,
  });

  const dir = repoDir(
    app.reposRoot,
    created.value.ownerName,
    created.value.name,
  );
  const configured = await configureMirror(dir, remote.cloneUrl);
  if (!configured.ok) return err("unreachable");

  app.bus.append({
    kind: "repo.mirrored",
    repoId: created.value.id,
    actorId: actor.id,
    payload: {
      origin: origin.webUrl,
      fullName: remote.fullName,
      htmlUrl: remote.htmlUrl,
    },
  });

  // The first pass is the import: one summary event, not one per row.
  await syncOrigin(app, origin, {
    initial: true,
    onlyRepoId: created.value.id,
  });

  await adoptDefaultBranch(dir, remote.defaultBranch);

  return ok({ repo: getRepoById(app.db, created.value.id)!, remote });
}

/**
 * A free local name. A collision gets the origin's host appended — one
 * `app` from GitHub and another from Codeberg become `app` and
 * `app-codeberg`, which is how a person would have named them anyway.
 */
function availableName(
  app: App,
  ownerId: string,
  wanted: string,
  origin: Origin,
): string | undefined {
  const candidates = [wanted, `${wanted}-${hostLabel(origin.webUrl)}`];
  for (let n = 2; n <= 20; n++) candidates.push(`${wanted}-${n}`);
  for (const candidate of candidates) {
    if (!isSafeName(candidate)) continue;
    const taken = app.db
      .query(
        "SELECT 1 FROM repo WHERE owner_id = ?1 AND name = ?2 COLLATE NOCASE",
      )
      .get(ownerId, candidate);
    if (!taken) return candidate;
  }
  return undefined;
}

/** `https://codeberg.org` → `codeberg`; a name segment, safe for a repo. */
export function hostLabel(webUrl: string): string {
  let host: string;
  try {
    host = new URL(webUrl).hostname;
  } catch {
    host = webUrl;
  }
  const label = host.replace(/^www\./, "").split(".")[0] ?? host;
  const cleaned = label.replace(/[^A-Za-z0-9_-]/g, "");
  return cleaned === "" ? "origin" : cleaned;
}
