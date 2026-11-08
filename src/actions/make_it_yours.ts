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
 * - A copy starts private unless the person chooses public (#852) — never
 *   public when the original is private: its code is not theirs to show.
 * - At most `COPIES_PER_DAY` copies an account in any 24 hours (#853): each
 *   is a repository and an app that deploys at once. Landing on a copy
 *   already made does not count.
 */

import { storageLimitMessage } from "../core/storage.ts";
import type { App } from "../app.ts";
import {
  getAppByRepo,
  getAppBySlug,
  slugFor,
  SLUG_MAX,
  type AppRecord,
} from "../core/apps.ts";
import {
  canEnterApp,
  canRead,
  forksSince,
  getRepoById,
  type Repo,
} from "../core/repos.ts";
import { isActive, type User } from "../core/users.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { requireVerified } from "./verify.ts";
import { requireAbility } from "./roles.ts";
import { requireAppRoom, appLimitWords } from "./app_limit.ts";
import { enableApp } from "./apps.ts";
import { FORKS_PER_DAY, forkRepo, repositoryLimitMessage } from "./repos.ts";

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
  /** Who may see the copy: private unless chosen otherwise. */
  readonly visibility: "public" | "private";
  /** Copies this account may still make in the next 24 hours. */
  readonly copiesLeft: number;
}

export type MakeItYoursError =
  | { readonly kind: "not_found" }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "unverified" }
  /** A guest: a person the owner has not made a member. */
  | { readonly kind: "not_member" }
  | { readonly kind: "own" }
  /** Today's copies are made; another may be made from `resetsAt`. */
  | { readonly kind: "limit"; readonly resetsAt: string }
  | { readonly kind: "invalid"; readonly message: string }
  /** The owner's repositories limit is reached: `message` says "10 of 10 repositories". */
  | { readonly kind: "repository_limit"; readonly message: string }
  /** The account's storage limit is reached: `message` says "1.9 GB of 2 GB". */
  | { readonly kind: "storage_limit"; readonly message: string };

export const COPIED = ["the code", "its history"] as const;
export const NOT_COPIED = [
  "the app's data",
  "its variables and secrets",
  "its crew",
  "its domains",
] as const;

/**
 * How many copies one account may make in any 24 hours (#853): the limit
 * every fork a person makes is held to (`FORKS_PER_DAY`, #888), counted
 * with the fork's own write, so no way of copying goes around it.
 */
export const COPIES_PER_DAY = FORKS_PER_DAY;
const DAY_MS = 86_400_000;

/** The account's copies in the last 24 hours, oldest first. */
const copiesToday = (app: App, ownerId: string, now: number): string[] =>
  forksSince(app.db, ownerId, new Date(now - DAY_MS).toISOString());

/** When the oldest of today's copies leaves the window. */
const resetsAt = (app: App, ownerId: string, now: number): string => {
  const oldest = copiesToday(app, ownerId, now)[0];
  return new Date((oldest === undefined ? now : Date.parse(oldest)) + DAY_MS).toISOString();
};

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
  input: {
    readonly dryRun?: boolean;
    readonly name?: string;
    readonly visibility?: "public" | "private";
  } = {},
  now = Date.now(),
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
  // The older refusals have spoken; what is left is the role. An account
  // that is unverified and a guest is told to verify first.
  if (!requireAbility(app, actor, "make_it_yours").ok)
    return err({ kind: requireVerified(app, actor).ok ? "not_member" : "unverified" });
  const dryRun = input.dryRun !== false;
  const name = input.name?.trim() || source.name;
  const visibility = input.visibility ?? "private";
  if (visibility === "public" && source.visibility !== "public")
    return err({
      kind: "invalid",
      message: "a copy of a private repository stays private",
    });
  const today = copiesToday(app, actor.id, now);
  const copiesLeft = Math.max(0, COPIES_PER_DAY - today.length);
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
      visibility: copy.visibility,
      copiesLeft,
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
            message:
              enabled.error === "app_limit"
                ? appLimitWords(app, actor.id)
                : `the app could not be registered: ${enabled.error}`,
          });
    return ok({ ...plan, made: { repo: copy, app: enabled.value } });
  }
  // The copy is an app of the actor's: no room, no copy (before the fork,
  // so no repository is left behind), in the plan as in the making.
  if (!requireAppRoom(app, actor, actor.id).ok)
    return err({ kind: "invalid", message: appLimitWords(app, actor.id) });
  const slug = freeSlug(app, { name }, actor.username);
  const plan = {
    dryRun,
    from,
    repo: `${actor.username}/${name}`,
    slug,
    copied: COPIED,
    notCopied: NOT_COPIED,
    existing: false,
    visibility,
    copiesLeft,
  };
  if (dryRun) return ok(plan);
  if (copiesLeft === 0)
    return err({ kind: "limit", resetsAt: resetsAt(app, actor.id, now) });
  // Born with the chosen visibility: the copy never exists as public first.
  const forked = await forkRepo(app, actor, source, name, { visibility, now });
  if (!forked.ok) {
    switch (forked.error) {
      case "not_found":
        return err({ kind: "not_found" });
      case "unauthorized":
        return err({ kind: "unauthorized" });
      case "unverified":
        return err({ kind: "unverified" });
      case "not_member":
        return err({ kind: "not_member" });
      case "name_taken":
        return err({
          kind: "invalid",
          message: `you already have a repository named ${name}: choose another name`,
        });
      case "limit":
        return err({ kind: "limit", resetsAt: resetsAt(app, actor.id, now) });
      case "repository_limit":
        return err({ kind: "repository_limit", message: repositoryLimitMessage(app, actor) });
      case "storage_limit":
        return err({ kind: "storage_limit", message: storageLimitMessage(app, actor.id) });
      default:
        return err({
          kind: "invalid",
          message: `the copy could not be made (${forked.error})`,
        });
    }
  }
  const copy = forked.value;
  const enabled = enableApp(app, actor, copy, { slug, access: visibility });
  if (!enabled.ok)
    return err({
      kind: "invalid",
      message: `the copy is made, but its app could not be registered: ${enabled.error}`,
    });
  return ok({ ...plan, made: { repo: copy, app: enabled.value } });
}
