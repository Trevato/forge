/**
 * The two questions every mutation asks about a repository: is it a mirror,
 * and if so may *this* actor write through it?
 *
 * It lives here, apart from `actions/origins.ts`, for a reason that is about
 * dependencies rather than tidiness. `actions/issues.ts` is on the hot path
 * of the web and terminal surfaces; the connect flows, the sync worker and
 * the provider adapters are not. Keeping the guard in a leaf module means
 * opening an issue does not drag OAuth, mirroring and the sync loop into the
 * module graph behind it.
 */

import type { App } from "../app.ts";
import { originForRepo, type Origin } from "../core/origins.ts";
import type { Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { providerForOrigin, writesPaused } from "./credential.ts";
import type { Provider } from "./types.ts";

export type WriteThroughError =
  | "origin_owner_only"
  | "origin_unreachable"
  | "origin_refused"
  /** The account behind the origin is not verified against the operator's rules yet. */
  | "origin_paused"
  /** The operator protects the origin repository: propose from a fork. */
  | "origin_protected";

export interface WriteThrough {
  readonly provider: Provider;
  readonly fullName: string;
  readonly origin: Origin;
}

/** True when this repo's writes must travel to an origin first. */
export function isMirror(app: App, repo: Repo): boolean {
  return originForRepo(app.db, repo.id) !== undefined;
}

/**
 * Resolve the provider a mirrored repo's write must go through, checking the
 * one rule that cannot be delegated: the token belongs to a person, and only
 * that person may act with it. A writer who is not the connecting user would
 * otherwise have their comment appear upstream under someone else's identity.
 * `undefined` means the repo is native and the ordinary local path applies.
 */
export function writeThroughFor(
  app: App,
  actor: User,
  repo: Repo,
): Result<WriteThrough | undefined, WriteThroughError> {
  const link = originForRepo(app.db, repo.id);
  if (!link) return ok(undefined);
  if (link.origin.userId !== actor.id) return err("origin_owner_only");
  if (writesPaused(app, link.origin.id) !== undefined)
    return err("origin_paused");
  const provider = providerForOrigin(app, link.origin);
  if (!provider.ok) return err("origin_unreachable");
  return ok({
    provider: provider.value,
    fullName: link.fullName,
    origin: link.origin,
  });
}

/** A remote refusal, mapped to the two outcomes a caller can act on. */
export function refusal(error: string): WriteThroughError {
  return error === "unreachable" || error === "rate_limited"
    ? "origin_unreachable"
    : "origin_refused";
}
