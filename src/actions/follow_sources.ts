/**
 * Following several sources (#9003): an admin of a repository adds sources
 * by address, one line each, and removes them. Each line is
 * `<url> [branch] [as <account>]`; the account a source's work is trusted
 * as is the address's owner unless a forge admin who is a person names
 * another (a forge whose repositories live under a shared name, such as
 * `/apps/foundry.git`, belongs to the account that runs it). A connected
 * origin of the actor's whose https origin is the address's is used to read
 * it; otherwise it is read anonymously. Checking is `checkSource` in
 * `upstream_follow.ts`.
 */
import type { App } from "../app.ts";
import {
  addSource,
  getSource,
  listSources,
  removeSource,
  type FollowSource,
} from "../core/follow_sources.ts";
import { listOrigins } from "../core/origins.ts";
import { canAdmin, type Repo } from "../core/repos.ts";
import { cleanAccount } from "../core/trusted_sources.ts";
import { upstreamUrl } from "../core/upstream_follow.ts";
import type { User } from "../core/users.ts";
import { isSafeRef } from "../git/guard.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { migrateUrl } from "./migrate.ts";
import { checkSource, mayCarryCredential, type CheckError, type Checked } from "./upstream_follow.ts";

export interface SourceLine {
  readonly url: string;
  readonly branch: string;
  readonly account: string;
}

export type SourceError = "invalid_url" | "invalid_branch" | "invalid_account" | "exists" | "too_many" | "not_found";

export const SOURCE_REFUSALS: Record<SourceError, string> = {
  invalid_url: "That is not an https or http git address, without a password.",
  invalid_branch: "That is not a branch name git accepts.",
  invalid_account: "That is not an account name, or only a forge admin may name one.",
  exists: "Already following that address and branch.",
  too_many: "This repository follows as many sources as it may.",
  not_found: "No such repository or source.",
};

/** One line of the add form, or the refusal it earns. */
export function parseSourceLine(raw: string): Result<SourceLine, SourceError> {
  const words = raw.trim().split(/\s+/);
  const as = words.indexOf("as");
  const account = as === -1 ? "" : (words[as + 1] ?? "");
  if (as !== -1 && cleanAccount(account) === undefined) return err("invalid_account");
  const head = as === -1 ? words : words.slice(0, as);
  if (head.length > 2 || as !== -1 && words.length !== as + 2) return err("invalid_url");
  const normal = migrateUrl(head[0] ?? "");
  const url = normal === undefined ? undefined : upstreamUrl(normal);
  if (url === undefined) return err("invalid_url");
  const branch = head[1] ?? "main";
  if (!isSafeRef(branch) || branch.length > 200) return err("invalid_branch");
  return ok({ url, branch, account: as === -1 ? "" : cleanAccount(account)! });
}

const mayNameAccount = (actor: User): boolean => actor.isAdmin && actor.kind !== "agent";

/** Add the sources named in `text`, one per line; what each line came to, in order. */
export function addFollowSources(
  app: App,
  actor: User | undefined,
  repo: Repo,
  text: string,
): Result<{ line: string; result: Result<FollowSource, SourceError> }[], "not_found"> {
  if (actor === undefined || !canAdmin(app.db, repo, actor)) return err("not_found");
  const origins = listOrigins(app.db, actor.id);
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l !== "").slice(0, 20);
  const done = lines.map((line) => {
    const parsed = parseSourceLine(line);
    if (!parsed.ok) return { line, result: parsed };
    if (parsed.value.account !== "" && !mayNameAccount(actor)) return { line, result: err<SourceError>("invalid_account") };
    const origin = origins.find((o) => mayCarryCredential(parsed.value.url, o.webUrl));
    const added = addSource(app.db, {
      repoId: repo.id,
      ...parsed.value,
      originId: origin?.id ?? "",
      byId: actor.id,
    });
    if (typeof added === "string") return { line, result: err<SourceError>(added) };
    app.bus.append({
      kind: "repo.source_added",
      repoId: repo.id,
      actorId: actor.id,
      payload: { branch: added.branch },
    });
    return { line, result: ok(added) };
  });
  return ok(done);
}

export function removeFollowSource(
  app: App,
  actor: User | undefined,
  repo: Repo,
  sourceId: string,
): Result<FollowSource, "not_found"> {
  if (actor === undefined || !canAdmin(app.db, repo, actor)) return err("not_found");
  const source = getSource(app.db, sourceId);
  if (source === undefined || source.repoId !== repo.id) return err("not_found");
  removeSource(app.db, sourceId);
  app.bus.append({ kind: "repo.source_removed", repoId: repo.id, actorId: actor.id, payload: {} });
  return ok(source);
}

/** "Check now" for every source of a repository, an admin's. */
export async function checkSourcesNow(
  app: App,
  actor: User | undefined,
  repo: Repo,
): Promise<Result<{ source: FollowSource; result: Result<Checked, CheckError> }[], "not_found">> {
  if (actor === undefined || !canAdmin(app.db, repo, actor)) return err("not_found");
  const out = [];
  for (const source of listSources(app.db, repo.id)) out.push({ source, result: await checkSource(app, repo, source) });
  return ok(out);
}

/** Where a source's last check stands, in words, at every door. */
export function sourceStanding(s: FollowSource): string {
  if (s.error !== "") return s.error === "conflict" ? "conflicts, with the crew" : "last check failed";
  if (s.checkedAt === null) return "not checked yet";
  return s.behind === 0 ? "up to date" : `${s.behind} behind`;
}
