/**
 * Proposing through the account's own fork at the origin — the way to
 * contribute to a repository the account can only read, and the only way
 * this forge ever proposes to a repository the operator protects.
 *
 * Reading is enough to contribute: anyone who can read a repository can fork
 * it and open a pull from the fork. On Forgejo 15 the pull's head is
 * `<owner>:<branch>`: `parseCompareInfo` (routers/api/v1/repo/pull.go:1092)
 * splits it on the colon, looks the owner up (:1098) and takes the head
 * repository to be that owner's fork of the base (`GetForkedRepo`, :1127),
 * whatever the fork is named; the base needs only read access for code and
 * pulls (:1162), the head read access for code (:1175-1181). GitHub reads
 * the same form. And a pull from a fork runs the base's workflows without
 * its Actions secrets (services/actions/secret.go:43), which is why a
 * protected repository is always proposed to from a fork, never from a
 * branch pushed into it.
 *
 * This file holds the pieces both callers share: finding or making the fork
 * (`contribute`'s fork step, and `openPull` on a mirror), and carrying a
 * branch into it. Pushing into the account's own fork is never a push to the
 * repository being proposed to.
 */

import type { App } from "../app.ts";
import {
  findOriginFork,
  getOriginRepo,
  originForRepo,
  rememberOriginRepo,
  type Origin,
} from "../core/origins.ts";
import type { Repo } from "../core/repos.ts";
import { denied } from "./operator.ts";
import { resolveOid } from "../git/merge.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { writesPaused } from "./credential.ts";
import { redact, secretsIn } from "./credentials.ts";
import { pushToOrigin } from "./git-mirror.ts";
import type { Provider, RemoteRepo } from "./types.ts";

/**
 * How long to wait for a fork to exist. GitHub's docs say most forks are
 * ready "within five minutes" and are in practice ready in one or two
 * seconds; thirty is long enough for the common case and short enough that a
 * request does not hang on the pathological one.
 */
const FORK_DEADLINE_MS = 30_000;

/**
 * The deadline a fork waits for when its caller names none. Mutable for the
 * same reason `firstFetchRetry` is: a test that wants the timeout shortens it
 * and puts back what it found.
 */
export const forkDeadline: { ms: number } = { ms: FORK_DEADLINE_MS };

/** Backoff between polls, in ms; the last value repeats until the deadline. */
const FORK_BACKOFF = [250, 500, 1_000, 2_000, 3_000] as const;

/** Pushing a branch into the fork: the same cap as any push through. */
const PUSH_TIMEOUT_MS = 120_000;

export type EnsureForkError =
  | "origin_unreachable"
  | "origin_refused"
  /** The origin took the request and the fork never appeared in time. */
  | "fork_timeout";

export const sameRepo = (a: string | null, b: string): boolean =>
  a !== null && a.toLowerCase() === b.toLowerCase();

/**
 * The name a fork takes when the account already has an unrelated
 * repository by the upstream's name: `<upstream owner>-<name>`.
 */
const secondName = (upstream: string): string => upstream.replace("/", "-");

/**
 * The fork of `upstream` this account already has, if any. The cache is
 * asked first (it is the picker's own answer and costs nothing); failing
 * that, the two names a fork made here can have are asked for directly — a
 * fork made outside this forge is not in the cache, and forking again would
 * be refused by the origin (one fork per account).
 */
export async function existingFork(
  app: App,
  origin: Origin,
  provider: Provider,
  upstream: string,
): Promise<RemoteRepo | undefined> {
  const cached = findOriginFork(app.db, origin.id, upstream);
  if (cached !== undefined) {
    const fresh = await provider.getRepo(cached.fullName);
    if (fresh.ok && sameRepo(fresh.value.parent, upstream)) return fresh.value;
  }
  const name = upstream.split("/")[1] ?? "";
  if (name === "" || origin.login === "") return undefined;
  for (const guess of [name, secondName(upstream)]) {
    const found = await provider.getRepo(`${origin.login}/${guess}`);
    if (found.ok && sameRepo(found.value.parent, upstream)) return found.value;
  }
  // Renamed, or made under a name of its own: the upstream's own list of
  // forks names it by owner (bounded; one account has one fork of a repo).
  const forks = await provider.listForks(upstream);
  if (!forks.ok) return undefined;
  const mine = forks.value.find(
    (f) => f.owner.toLowerCase() === origin.login.toLowerCase(),
  );
  if (mine === undefined) return undefined;
  const fresh = await provider.getRepo(mine.fullName);
  return fresh.ok ? fresh.value : undefined;
}

/** Poll until the origin admits the fork exists, or the deadline passes. */
export async function awaitFork(
  provider: Provider,
  fullName: string,
  waitMs: number,
): Promise<Result<RemoteRepo, EnsureForkError>> {
  const deadline = Date.now() + waitMs;
  for (let attempt = 0; ; attempt++) {
    const found = await provider.getRepo(fullName);
    // An empty fork is still a fork; what we are waiting for is the row.
    if (found.ok) return ok(found.value);
    if (found.error.error !== "not_found")
      return err(
        found.error.error === "unreachable" ||
          found.error.error === "rate_limited"
          ? "origin_unreachable"
          : "origin_refused",
      );
    const wait =
      FORK_BACKOFF[Math.min(attempt, FORK_BACKOFF.length - 1)] ?? 3_000;
    if (Date.now() + wait > deadline) return err("fork_timeout");
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}

/**
 * The account's fork of `upstream` at the origin: the one it has, or a new
 * one. Idempotent — GitHub answers a repeat `POST /forks` with the existing
 * fork and Forgejo answers 409, so the check is ours. When the account
 * already owns an unrelated repository by the upstream's name, the fork is
 * made under a second name (`<owner>-<name>`); the pull's head form names
 * the owner, not the repository, so the name does not matter to it.
 */
export async function ensureFork(
  app: App,
  origin: Origin,
  provider: Provider,
  upstream: string,
  waitMs: number = forkDeadline.ms,
): Promise<Result<{ remote: RemoteRepo; existed: boolean }, EnsureForkError>> {
  const found = await existingFork(app, origin, provider, upstream);
  if (found !== undefined) {
    remember(app, origin, found, upstream);
    return ok({ remote: found, existed: true });
  }

  const name = upstream.split("/")[1] ?? "";
  const failed = (error: string): EnsureForkError =>
    error === "unreachable" || error === "rate_limited"
      ? "origin_unreachable"
      : "origin_refused";
  let asked = await provider.forkRepo(upstream);
  if (!asked.ok && asked.error.error !== "unreachable" && name !== "") {
    // Refused: the usual reason is a repository of the account's own by
    // the same name. Then the fork takes the second name.
    const taken = await provider.getRepo(`${origin.login}/${name}`);
    if (taken.ok && !sameRepo(taken.value.parent, upstream))
      asked = await provider.forkRepo(upstream, secondName(upstream));
  }
  let remote: RemoteRepo;
  if (asked.ok) {
    const ready = await awaitFork(provider, asked.value.fullName, waitMs);
    if (!ready.ok) return ready;
    remote = ready.value;
  } else {
    // An origin that forks in the request itself can take longer than we
    // wait for an answer, and still have done it. Before calling that a
    // failure, look for the fork under its conventional name.
    if (asked.error.error !== "unreachable" || name === "" || origin.login === "")
      return err(failed(asked.error.error));
    const late = await awaitFork(provider, `${origin.login}/${name}`, waitMs);
    if (!late.ok || !sameRepo(late.value.parent, upstream))
      return err(failed(asked.error.error));
    remote = late.value;
  }
  remember(app, origin, remote, upstream);
  return ok({ remote, existed: false });
}

/** The picker row for the fork, with the parent we know it has. */
function remember(
  app: App,
  origin: Origin,
  remote: RemoteRepo,
  upstream: string,
): void {
  // Both forges report the parent on `getRepo`; if this one did not, we
  // know it anyway, because we are the reason the fork exists.
  rememberOriginRepo(app.db, origin.id, {
    ...remote,
    parent: remote.parent ?? upstream,
  });
}

/**
 * Whether a proposal to this mirror's origin goes through the account's
 * fork, as far as this forge knows without asking: the operator protects
 * the repository, or the picker's cache says the account cannot push there.
 * What a surface says on its button; `openPull` asks the origin itself.
 */
export function proposesViaFork(app: App, mirror: Repo): boolean {
  const link = originForRepo(app.db, mirror.id);
  if (link === undefined) return false;
  if (denied(link.origin, link.fullName)) return true;
  return getOriginRepo(app.db, link.origin.id, link.fullName)?.canPush === false;
}

/** The pull's head for a branch of the account's fork: `<owner>:<branch>`. */
export const forkHead = (fork: RemoteRepo, branch: string): string =>
  `${fork.owner}:${branch}`;

/**
 * Carry a branch of a local repository into the account's fork at the
 * origin, as `as`, leased on where that branch stands in the fork now (a
 * new branch must not exist yet). Answers the tip it carried.
 */
export async function pushToFork(
  app: App,
  origin: Origin,
  provider: Provider,
  fork: RemoteRepo,
  dir: string,
  branch: string,
  as: string,
): Promise<Result<string, string>> {
  // Its callers ask too; this is the push itself asking, so no path that
  // forgets cannot write through an origin whose account is not verified.
  const paused = writesPaused(app, origin.id);
  if (paused !== undefined) return err(paused);
  const tip = await resolveOid(dir, `refs/heads/${branch}`);
  if (tip === undefined) return err(`there is no branch ${branch} to propose`);
  if (fork.cloneUrl === "") return err(`${fork.fullName} has no clone URL`);
  const authEnv = await provider.gitAuthEnv(fork.cloneUrl);
  if (Object.keys(authEnv).length === 0)
    return err("this origin needs to be reconnected");
  const branches = await provider.listBranches(fork.fullName);
  if (!branches.ok) return err(`${fork.fullName} could not be read`);
  const held =
    branches.value.find((b) => b.name === as)?.oid ?? "0".repeat(40);
  if (held === tip) return ok(tip);
  const pushed = await pushToOrigin(
    dir,
    fork.cloneUrl,
    [{ ref: `refs/heads/${as}`, oldOid: held, newOid: tip }],
    authEnv,
    { timeoutMs: PUSH_TIMEOUT_MS },
  );
  if (!pushed.ok)
    return err(
      redact(
        `${fork.fullName} refused the branch: ${pushed.error.message}`,
        ...secretsIn(authEnv),
      ),
    );
  return ok(tip);
}
