/**
 * A stranger's pull (#9575): one whose author cannot write the repository
 * and is not on its crew — a guest from another forge or from a fork here,
 * or a reader's fork. A trusted source (#8937) is no stranger: a person
 * named it, and its walls wait for a person through `fold_walls.ts`.
 *
 * What happens to one:
 * - on an autonomous repository the crew's reviewer reads it first, before
 *   its code has run (`crew/review.ts`), and a person decides whether it lands;
 * - otherwise it waits for a person; it never lands on its own
 *   (`crew/direct.ts`'s `landsOnItsOwn`);
 * - whatever any review says, it never lands while it changes a guarded
 *   path: secrets, credentials, permissions, release scripts, or the
 *   `check` and `release` lines of `forge.json` (`mergePull` refuses it and
 *   names the paths). The guard is read here, on the server, from the diff
 *   git computes between the base and the head: nothing the author sets
 *   (a label, a title, a branch name) moves it.
 */

import type { Database } from "bun:sqlite";
import type { App } from "../app.ts";
import { isProposed } from "../core/pull_trust.ts";
import { type Guarded, pullDir, type Pull } from "../core/pulls.ts";
import { canWrite, onCrew, type Repo } from "../core/repos.ts";
import { foldsIn } from "../core/trusted_sources.ts";
import { getUserById } from "../core/users.ts";
import { runGitCapture } from "../git/env.ts";
import { resolveOid } from "../git/merge.ts";
import { repoDir } from "../git/repos.ts";
import { isGuestPull } from "../origins/guest.ts";
import { pathWalls, touchedFiles } from "./fold_walls.ts";

/** Whether `pull` is a stranger's: its author can neither write `repo` nor sits on its crew. */
export function isStrangerPull(db: Database, repo: Repo, pull: Pull): boolean {
  if (foldsIn(db, pull.id)) return false;
  // A child's proposal has its own door (`core/pull_trust.ts`): a grant and a person's review.
  if (isProposed(db, pull)) return false;
  if (isGuestPull(db, pull)) return true;
  const author = getUserById(db, pull.authorId);
  return author === undefined || !(canWrite(db, repo, author) || onCrew(db, repo, author));
}

/** The keys of `forge.json` a stranger may not change: what checks a pull, and what releases one. */
const GUARDED_KEYS = ["check", "release"] as const;

/** Each guarded key's value in a `forge.json`, top level and under `app`; undefined when it is not JSON. */
function guardedValues(text: string | undefined): string[] | undefined {
  if (text === undefined) return GUARDED_KEYS.map(() => JSON.stringify([null, null]));
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const top = parsed as Record<string, unknown>;
    const inner = top["app"];
    const app = typeof inner === "object" && inner !== null ? (inner as Record<string, unknown>) : {};
    return GUARDED_KEYS.map((k) => JSON.stringify([top[k] ?? null, app[k] ?? null]));
  } catch {
    return undefined;
  }
}

/** The guarded keys of `forge.json` that differ between `base` and `head`; `unread` when either side is not JSON. */
export function forgeJsonGuard(base: string | undefined, head: string | undefined): string[] | "unread" {
  const before = guardedValues(base);
  const after = guardedValues(head);
  if (before === undefined || after === undefined) return "unread";
  return GUARDED_KEYS.filter((_, i) => before[i] !== after[i]);
}

/**
 * The guarded paths among `files`, each with why. `forgeJson` answers for
 * `forge.json`, which is guarded only where its check or release lines move.
 */
export function guardedPaths(files: readonly string[], forgeJson: string[] | "unread" = []): Guarded[] {
  const out: Guarded[] = [];
  for (const path of files) {
    if (path === "forge.json") {
      if (forgeJson === "unread") out.push({ path, why: "forge.json could not be read" });
      else for (const key of forgeJson) out.push({ path, why: `its ${key} line` });
      continue;
    }
    for (const why of pathWalls(path)) out.push({ path, why });
  }
  return out;
}

/** `forge.json` at `rev` in `dir`, or undefined when the commit has none. */
async function forgeJsonAt(dir: string, rev: string): Promise<string | undefined> {
  const out = await runGitCapture(["cat-file", "blob", `${rev}:forge.json`], { cwd: dir });
  return out.code === 0 ? out.stdout : undefined;
}

/**
 * The guarded paths a stranger's `pull` changes against its base branch's
 * tip (or its slice up to `head`), from git's own diff. Empty for a pull that is no stranger's, and for
 * one that touches none. A diff git cannot read is guarded: unread is not clear.
 */
export async function strangerGuard(app: App, repo: Repo, pull: Pull, head: string = pull.headOid): Promise<Guarded[]> {
  if (!isStrangerPull(app.db, repo, pull)) return [];
  const baseTip =
    (await resolveOid(repoDir(app.reposRoot, repo.ownerName, repo.name), `refs/heads/${pull.baseBranch}`)) ?? pull.baseOid;
  const dir = await pullDir(app.db, app.reposRoot, repo, pull);
  const files = await touchedFiles(dir, baseTip, head);
  if (files === undefined) return [{ path: "(the diff)", why: "it could not be read" }];
  const json = files.includes("forge.json")
    ? forgeJsonGuard(await forgeJsonAt(dir, baseTip), await forgeJsonAt(dir, head))
    : [];
  return guardedPaths(files, json);
}

/** The guarded paths as one list a sentence can carry. */
export const guardedList = (guarded: readonly Guarded[]): string =>
  guarded.map((g) => `${g.path} (${g.why})`).join(", ");

/** The refusal `mergePull` gives, in words: the paths, and what a person may do instead. */
export const guardedRefusal = (guarded: readonly Guarded[]): string =>
  `This pull is from someone who cannot write here and changes guarded paths, so it does not land whatever its review says: ${guardedList(guarded)}. A person who can write here may make that change themselves.`;

/** Whether the crew's reviewer reads this stranger's pull before a person does: on an autonomous repository. */
export const crewFilters = (repo: Repo): boolean => repo.autonomy === "autonomous";

/** What happens next to a stranger's pull, in one plain sentence for its author. */
export function strangerNext(repo: Repo, guarded: readonly Guarded[]): string {
  if (guarded.length > 0)
    return `This pull cannot land as it is, whatever its review says, because it changes guarded paths: ${guardedList(guarded)}.`;
  return crewFilters(repo)
    ? "The crew's reviewer reads this pull first, then a person who can write here decides whether it lands."
    : "This pull waits for a person who can write here to review it; it never lands on its own.";
}
