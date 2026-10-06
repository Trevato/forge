/**
 * Make it yours (#606): one action forks an app into the viewer's account
 * with its app — a fork of the code and its history, registered as an app
 * that deploys at once, following the original — and lands them on it.
 * The page, `POST /api/v1/repos/:owner/:name/make-it-yours` and the MCP tool
 * `make_it_yours` all answer from here; each plans unless asked to make.
 *
 * - What is copied: the code and its history (git, shared with the original
 *   through alternates, so it is instant). What is not: the app's data, its
 *   variables and secrets, its crew, its domains and its pins — those are the
 *   original owner's, and the new app starts empty.
 * - The original is untouched. A private app is copied only by those who may
 *   enter it as its own (writers, crew); to anyone else it is not there.
 * - Following is what a fork does: while the copy has nothing of its own, it
 *   moves when the original's default branch moves; once it has, it is told
 *   (`fork.diverged`) and takes updates on request.
 * - Someone who already made it theirs is landed on their copy, and its app
 *   is registered if it was not.
 */

import type { App } from "../app.ts";
import {
  getAppByRepo,
  getAppBySlug,
  slugFor,
  SLUG_MAX,
  type AppRecord,
} from "../core/apps.ts";
import { canEnterApp, canRead, getRepoById, type Repo } from "../core/repos.ts";
import { isActive, type User } from "../core/users.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { enableApp } from "./apps.ts";
import { forkRepo } from "./repos.ts";

export interface MakeItYoursPlan {
  readonly dryRun: boolean;
  /** `owner/name` of the original. */
  readonly from: string;
  /** `owner/name` of the copy, made or to be made. */
  readonly repo: string;
  /** The app's slug: its hostname's label. */
  readonly slug: string;
  readonly copied: readonly string[];
  readonly notCopied: readonly string[];
  /** True when the viewer already had a copy, and is landed on it. */
  readonly existing: boolean;
}

export type MakeItYoursError =
  | { readonly kind: "not_found" }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "unverified" }
  | { readonly kind: "own" }
  | { readonly kind: "invalid"; readonly message: string };

export const COPIED = ["the code", "its history"] as const;
export const NOT_COPIED = [
  "the app's data",
  "its variables and secrets",
  "its crew",
  "its domains",
] as const;

/** A free slug from the copy's owner and name: `name-owner`, then a number. */
function freeSlug(app: App, repo: { name: string }, owner: string): string {
  const base = slugFor(`${repo.name}-${owner}`)
    .slice(0, SLUG_MAX - 3)
    .replace(/-+$/, "");
  if (getAppBySlug(app.db, base) === undefined) return base;
  for (let n = 2; n < 100; n++) {
    const candidate = `${base}-${n}`;
    if (getAppBySlug(app.db, candidate) === undefined) return candidate;
  }
  return `${base}-${Date.now().toString(36).slice(-4)}`;
}

export async function makeItYours(
  app: App,
  actor: User | undefined,
  source: Repo,
  input: { readonly dryRun?: boolean; readonly name?: string } = {},
): Promise<
  Result<
    MakeItYoursPlan & { readonly made?: { repo: Repo; app: AppRecord } },
    MakeItYoursError
  >
> {
  if (!canRead(app.db, source, actor)) return err({ kind: "not_found" });
  const sourceApp = getAppByRepo(app.db, source.id);
  if (sourceApp === undefined) return err({ kind: "not_found" });
  // A private app is copied only by someone who may enter it as one of its
  // own (a writer or its crew); to anyone else it is not there — reading a
  // public repository's code is not a key to its private app (#620).
  if (
    sourceApp.access !== "public" &&
    !canEnterApp(app.db, source, sourceApp, actor, { named: false })
  )
    return err({ kind: "not_found" });
  if (actor === undefined || !isActive(actor)) return err({ kind: "unauthorized" });
  if (actor.kind === "agent")
    return err({
      kind: "invalid",
      message: "an agent does not make apps its own",
    });
  if (source.ownerId === actor.id) return err({ kind: "own" });
  const dryRun = input.dryRun !== false;
  const name = input.name?.trim() || source.name;
  const already = app.db
    .query<
      { id: string },
      [string, string]
    >(`SELECT id FROM repo WHERE owner_id = ?1 AND fork_parent_id = ?2`)
    .get(actor.id, source.id);
  const from = `${source.ownerName}/${source.name}`;
  if (already !== null) {
    const copy = getRepoById(app.db, already.id)!;
    const copyApp = getAppByRepo(app.db, copy.id);
    const slug = copyApp?.slug ?? freeSlug(app, copy, actor.username);
    const plan = {
      dryRun,
      from,
      repo: `${copy.ownerName}/${copy.name}`,
      slug,
      copied: COPIED,
      notCopied: NOT_COPIED,
      existing: true,
    };
    if (dryRun) return ok(plan);
    if (copyApp !== undefined)
      return ok({ ...plan, made: { repo: copy, app: copyApp } });
    const enabled = enableApp(app, actor, copy, { slug });
    if (!enabled.ok)
      return enabled.error === "unverified"
        ? err({ kind: "unverified" })
        : err({
            kind: "invalid",
            message: `the app could not be registered: ${enabled.error}`,
          });
    return ok({ ...plan, made: { repo: copy, app: enabled.value } });
  }
  const slug = freeSlug(app, { name }, actor.username);
  const plan = {
    dryRun,
    from,
    repo: `${actor.username}/${name}`,
    slug,
    copied: COPIED,
    notCopied: NOT_COPIED,
    existing: false,
  };
  if (dryRun) return ok(plan);
  const forked = await forkRepo(app, actor, source, name);
  if (!forked.ok) {
    switch (forked.error) {
      case "not_found":
        return err({ kind: "not_found" });
      case "unauthorized":
        return err({ kind: "unauthorized" });
      case "unverified":
        return err({ kind: "unverified" });
      case "name_taken":
        return err({
          kind: "invalid",
          message: `you already have a repository named ${name}: choose another name`,
        });
      default:
        return err({
          kind: "invalid",
          message: `the copy could not be made (${forked.error})`,
        });
    }
  }
  const enabled = enableApp(app, actor, forked.value, { slug });
  if (!enabled.ok)
    return err({
      kind: "invalid",
      message: `the copy is made, but its app could not be registered: ${enabled.error}`,
    });
  return ok({ ...plan, made: { repo: forked.value, app: enabled.value } });
}
