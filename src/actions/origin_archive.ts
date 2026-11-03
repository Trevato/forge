/**
 * Bringing a repository back out of a connected Forgejo's archive. The token
 * is the one the origin connection already holds, and only that connection's
 * owner reaches any of this; everyone else's origin is `not_found`.
 */

import type { App } from "../app.ts";
import { getOriginFor, markNeedsReauth, type Origin } from "../core/origins.ts";
import type { User } from "../core/users.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { providerForOrigin } from "../origins/credential.ts";
import { scopeWords } from "../origins/providers/http.ts";
import type {
  ArchivedPage,
  ProviderFailure,
  ProviderResult,
} from "../origins/types.ts";

/** The most one submit will restore; a page of the list is never more. */
export const MAX_RESTORE = 100;
const AT_ONCE = 4;

/** Another forge and GitHub have no such archive to read here. */
export const hasArchive = (origin: Origin): boolean =>
  origin.kind !== "github" && origin.software !== "forge";

/** A refusal or failure at the origin, in plain words. */
export function archiveFailureWords(failure: ProviderFailure): string {
  switch (failure.error) {
    case "forbidden":
      return failure.missingScopes !== undefined
        ? `This token is missing ${scopeWords(failure.missingScopes)}. Replace it on the origins page, then try again.`
        : `Refused: ${failure.message}. Restoring a repository takes admin on it, and this connection's account may not have that.`;
    case "unauthorized":
      return "The origin rejected this token. Replace it on the origins page, then try again.";
    case "not_found":
      return "The origin has no such repository, or this token cannot see it.";
    case "rate_limited":
      return "The origin is limiting requests. Try again in a few minutes.";
    case "invalid_response":
      return "The origin answered with something this forge could not read.";
    case "unreachable":
      return "The origin could not be reached.";
  }
}

function noteFailure(app: App, origin: Origin, failure: ProviderFailure): void {
  if (failure.error === "unauthorized")
    markNeedsReauth(app.db, origin.id, failure.message);
}

const NO_CREDENTIAL: ProviderFailure = {
  error: "unauthorized",
  message: "this connection's token could not be used",
};

export interface ArchivedView {
  readonly origin: Origin;
  readonly listed: ProviderResult<ArchivedPage>;
  /**
   * What the token lacks to write repositories, when the origin named it.
   * Empty when it has it or when the origin's answer did not settle it.
   */
  readonly missingWrite: readonly string[];
}

export async function readArchived(
  app: App,
  actor: User,
  originId: string,
  options: { query: string; page: number },
): Promise<Result<ArchivedView, "not_found">> {
  const origin = getOriginFor(app.db, actor.id, originId);
  if (!origin || !hasArchive(origin)) return err("not_found");
  const provider = providerForOrigin(app, origin);
  if (!provider.ok)
    return ok({
      origin,
      listed: { ok: false, error: NO_CREDENTIAL },
      missingWrite: [],
    });
  const [listed, reach] = await Promise.all([
    provider.value.listArchived!(options),
    provider.value.repoWriteReach!(origin.login),
  ]);
  if (!listed.ok) noteFailure(app, origin, listed.error);
  return ok({
    origin,
    listed,
    missingWrite:
      reach.ok && typeof reach.value === "object" ? reach.value.missing : [],
  });
}

export type RestoreResult =
  | { readonly fullName: string; readonly state: "restored" }
  | {
      readonly fullName: string;
      readonly state: "failed" | "still_archived" | "unconfirmed";
      readonly message: string;
    };

/**
 * Restore each named repository and report what the origin says afterwards,
 * one result per name in the order given. A failure on one touches no other.
 */
export async function restoreArchived(
  app: App,
  actor: User,
  originId: string,
  names: readonly string[],
): Promise<Result<RestoreResult[], "not_found">> {
  const origin = getOriginFor(app.db, actor.id, originId);
  if (!origin || !hasArchive(origin)) return err("not_found");
  const provider = providerForOrigin(app, origin);

  const one = async (fullName: string): Promise<RestoreResult> => {
    if (!provider.ok)
      return {
        fullName,
        state: "failed",
        message: archiveFailureWords(NO_CREDENTIAL),
      };
    const done = await provider.value.unarchiveRepo!(fullName);
    if (!done.ok) {
      noteFailure(app, origin, done.error);
      return {
        fullName,
        state: "failed",
        message: archiveFailureWords(done.error),
      };
    }
    if (done.value.archived === false) return { fullName, state: "restored" };
    return done.value.archived === null
      ? {
          fullName,
          state: "unconfirmed",
          message:
            "The origin took the change, then could not be read back. Check it there.",
        }
      : {
          fullName,
          state: "still_archived",
          message:
            "The origin answered, but it still says this repository is archived.",
        };
  };

  const results = new Array<RestoreResult>(names.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(AT_ONCE, names.length) }, async () => {
      while (next < names.length) {
        const at = next++;
        results[at] = await one(names[at]!);
      }
    }),
  );
  return ok(results);
}
