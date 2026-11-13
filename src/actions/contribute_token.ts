/**
 * The contribute call (#12012): an outside agent names itself and a repository
 * that opted in, and gets a token for one day with no account of its own. The
 * forge makes a throwaway guest account for the mint (no password, no crew, no
 * credits) so a pull the agent opens has an author. Name and origin are stored
 * as claimed. Minting is capped per address, counted from the rows it leaves.
 * The repository owner's yes is `contribute_open` (`setOutsideContributions`).
 */
import type { App } from "../app.ts";
import {
  MINTS_PER_DAY,
  MINTS_PER_HOUR,
  contribNamespace,
  type Minted,
  contributeOpen,
  isAgentName,
  isOrigin,
  mintContribute,
  mintsSince,
  renewContribute,
  revokeContribute,
  setContributeOpen,
} from "../core/contribute_token.ts";
import { getRepo, canAdmin, type Repo } from "../core/repos.ts";
import { createUser, type User } from "../core/users.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { isMirror } from "../origins/write-through.ts";
import { isContributionFork } from "../core/contribute.ts";
import { nameSlug } from "./start.ts";
import { noEmail } from "./users.ts";

export type ContributeTokenError =
  | "invalid_agent"
  | "invalid_origin"
  | "invalid_repo"
  | "not_open"
  | "rate_limited"
  | "already_renewed"
  | "failed";

export const CONTRIBUTE_TOKEN_WORDS: Readonly<Record<ContributeTokenError, string>> = {
  invalid_agent: "agent is a name of at most 64 letters, digits, . _ -, starting with a letter or digit",
  invalid_origin: "origin is where you run from, as plain text of at most 200 characters (claimed, not verified)",
  invalid_repo: "repo is owner/name",
  not_open: "this repository does not take outside contributions: it is private, archived, a copy, or its owner has not allowed them",
  rate_limited: "Too many tokens from here; wait and ask again.",
  already_renewed: "this token was renewed once already; ask for a new one",
  failed: "The token could not be made; nothing was kept. Try again.",
};

export const CONTRIBUTE_TOKEN_HINT =
  "send {agent, repo: \"owner/name\", origin?}: agent is your name, origin where you run (both claimed, not verified)";

export interface ContributeTokenRefusal {
  readonly error: ContributeTokenError;
  readonly retryAfter?: number;
}

/**
 * Whether `repo` takes outside contributions: public, a real original, not archived,
 * and its owner said yes.
 */
export function takesOutside(app: App, repo: Repo): boolean {
  return (
    repo.visibility === "public" &&
    repo.sealedFor === null &&
    repo.archivedAt === null &&
    !isMirror(app, repo) &&
    !isContributionFork(app.db, repo.id) &&
    contributeOpen(app.db, repo.id)
  );
}

export interface ContributeTokenMade extends Minted {
  readonly repo: string;
  readonly agent: string;
  /** The branches this token may push. */
  readonly branches: string;
  readonly git: { readonly url: string; readonly push: string };
  readonly claimed: true;
  readonly renewable: true;
}

export async function mintContributeToken(
  app: App,
  input: { agent?: unknown; origin?: unknown; repo?: unknown },
  source: string,
  origin: string,
  now: Date = new Date(),
): Promise<Result<ContributeTokenMade, ContributeTokenRefusal>> {
  const refuse = (error: ContributeTokenError, retryAfter?: number) =>
    err<ContributeTokenRefusal>(retryAfter === undefined ? { error } : { error, retryAfter });
  if (!isAgentName(input.agent)) return refuse("invalid_agent");
  const claimed = input.origin === undefined ? "" : input.origin;
  if (!isOrigin(claimed)) return refuse("invalid_origin");
  const [owner, name, ...rest] = typeof input.repo === "string" ? input.repo.split("/") : [];
  if (!owner || !name || rest.length > 0) return refuse("invalid_repo");
  // A repository that is missing and one that is closed answer alike.
  const repo = getRepo(app.db, owner, name);
  if (repo === undefined || !takesOutside(app, repo)) return refuse("not_open");
  const agent = input.agent;

  const capped = (): boolean =>
    mintsSince(app.db, now.getTime() - 3_600_000, source) >= MINTS_PER_HOUR ||
    mintsSince(app.db, now.getTime() - 86_400_000, source) >= MINTS_PER_DAY;
  if (capped()) return refuse("rate_limited", 3600);

  const base = nameSlug(agent) || "agent";
  const username = `contrib-${base}-${crypto.randomUUID().slice(0, 6)}`.slice(0, 39);
  const made = await createUser(app.db, {
    origin: "start",
    username,
    email: noEmail(username),
    displayName: agent,
    trusted: true,
  });
  if (!made.ok) return refuse("failed");
  const user: User = made.value;
  let minted: Minted | undefined;
  app.db.transaction(() => {
    // Counted again inside the write: concurrent calls cannot overshoot.
    if (capped()) return;
    minted = mintContribute(app.db, { userId: user.id, repoId: repo.id, agent, origin: claimed, source }, now);
  })();
  if (minted === undefined) {
    // The cap held inside the write: the account made for this mint goes with it.
    app.db.transaction(() => {
      app.db.query("DELETE FROM email_check WHERE user_id = ?1").run(user.id);
      app.db.query("DELETE FROM user WHERE id = ?1").run(user.id);
    })();
    return refuse("rate_limited", 3600);
  }
  const namespace = contribNamespace(agent, minted.id);
  app.bus.append({ kind: "contribute.token", repoId: repo.id, actorId: user.id, payload: { agent } });
  const url = `${origin}/${repo.ownerName}/${repo.name}.git`;
  return ok({
    ...minted,
    repo: `${repo.ownerName}/${repo.name}`,
    agent,
    branches: `contrib/${namespace}/*`,
    git: {
      url,
      push: `git push ${url.replace("://", `://${user.username}:${minted.token}@`)} HEAD:contrib/${namespace}/<topic>`,
    },
    claimed: true,
    renewable: true,
  });
}

/** Extend the token the caller holds by another day, once. */
export function renewContributeToken(
  app: App,
  tokenId: string,
  now: Date = new Date(),
): Result<{ expiresAt: string }, ContributeTokenRefusal> {
  const done = renewContribute(app.db, tokenId, now);
  if (done.ok) return ok({ expiresAt: done.expiresAt });
  return err({ error: done.error === "already_renewed" ? "already_renewed" : "failed" });
}

/** A repository admin's yes or no to outside contributions. */
export function setOutsideContributions(app: App, actor: User | undefined, repo: Repo, on: boolean): Result<{ on: boolean }, "not_found"> {
  if (!canAdmin(app.db, repo, actor)) return err("not_found");
  setContributeOpen(app.db, repo.id, on);
  app.bus.append({ kind: "contribute.open", repoId: repo.id, actorId: actor!.id, payload: { on } });
  return ok({ on });
}

/** A repository admin revokes one outside agent's token; every door says so on the bus. */
export function revokeOutsideToken(app: App, actor: User | undefined, repo: Repo, tokenId: string): Result<{ revoked: true }, "not_found"> {
  if (!canAdmin(app.db, repo, actor)) return err("not_found");
  if (!revokeContribute(app.db, repo.id, tokenId)) return err("not_found");
  app.bus.append({ kind: "contribute.revoked", repoId: repo.id, actorId: actor!.id, payload: { token: tokenId } });
  return ok({ revoked: true });
}
