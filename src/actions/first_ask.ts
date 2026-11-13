/**
 * The first ask of a new forge (#11342): one sentence makes a new app named
 * from it, turns the crew loose on it when the crew can run, and files the
 * sentence there as the app's one issue. The page calls
 * this.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { App } from "../app.ts";
import { appsForRepos } from "../core/apps.ts";
import { isNamed } from "../core/forge_repo.ts";
import { forgeSource } from "../settings/forge_source.ts";
import { nextStepsFor } from "../core/next-steps.ts";
import { listReposWritableTo } from "../core/repos.ts";
import { FORGE_CODE_NAME } from "../spawn/forge_code.ts";
import type { Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { newAppFromSentence, NEW_APP_ERRORS } from "./apps.ts";
import { getRepoById } from "../core/repos.ts";
import { seatFirstAskCrew } from "../spawn/starter_crew.ts";
import { FORGE_REPO_WORDS, NOT_TOLD_WORDS, SAY_SOMETHING_WORDS } from "./tell_words.ts";
import { FROM_WORDS, TOO_LONG_WORDS, tell, type TellError, type Told } from "./tell.ts";
import { parseFrom } from "./tell_from.ts";
import { deriveAppName } from "../web/pages/apps-name.ts";
import { requireVerified } from "./verify.ts";
import { MAX_BODY } from "../core/issues.ts";
import { recordRefusal } from "../core/first_ask_refusals.ts";
import { DIRECTION_NOTE } from "../crew/direct.ts";

export interface FirstAsk {
  /** The app made from the ask. */
  readonly repo: Repo;
  /** True when the crew could run but autonomy could not be set: the ask is filed on an app a builder will not start by itself. */
  readonly autonomyFailed: boolean;
  /** The ask's own tell, refused or told. */
  readonly told: Result<Told, TellError>;
}

/** What a failed first ask says, in words: the empty sentence, or why no app could be made. */
export type FirstAskError = { readonly words: string };

/** The note a person is given when the app was made and filed but autonomy could not be turned on. */
export const AUTONOMY_FAILED_WORDS = "The app is made, but the crew could not be set to start on it by itself. Turn on autonomy in its settings.";

/** Whether the app this sentence would be named from is the forge's own repository. */
function resolvesToForgeRepo(app: App, actor: User, sentence: string): boolean {
  const name = deriveAppName(sentence);
  return name !== undefined && app.config.forgeRepo?.toLowerCase() === `${actor.username}/${name}`.toLowerCase();
}

export async function firstAsk(
  app: App,
  actor: User | undefined,
  said: string,
  crewCanRun: boolean,
  from: string | null = null,
): Promise<Result<FirstAsk, FirstAskError>> {
  const text = said.trim();
  /** A refusal: kept as one row, and its words returned unchanged. */
  const refuse = (words: string): Result<FirstAsk, FirstAskError> => {
    recordRefusal(app.db, { actorId: actor?.id ?? null, ask: text, words }, Date.now());
    return err({ words });
  };
  if (text === "") return refuse(SAY_SOMETHING_WORDS);
  // Everything the tell could refuse is asked before the app exists, so a
  // refused ask leaves nothing behind and a retry makes no second app. The
  // new app's owner is the actor, who may direct the crew on it.
  if (text.length > MAX_BODY) return refuse(TOO_LONG_WORDS);
  if (actor === undefined || actor.kind === "org") return refuse(DIRECTION_NOTE);
  if (!requireVerified(app, actor).ok) return refuse("Verify your email first.");
  if (from !== null && typeof parseFrom(from) !== "string") return refuse(FROM_WORDS);
  // The forge's own repository is never an ask's target: refused before any app exists.
  if (resolvesToForgeRepo(app, actor, text)) return refuse(FORGE_REPO_WORDS);
  // An empty description: the issue the tell files is the one issue of the ask.
  const made = await newAppFromSentence(app, actor, { sentence: text, description: "" });
  if (!made.ok) return refuse(NEW_APP_ERRORS[made.code] ?? NOT_TOLD_WORDS);
  let repo = made.repo;
  let autonomyFailed = false;
  if (crewCanRun) {
    // A builder and a reviewer seated and autonomy on as the asker, so the next tick starts the ask (#11508).
    if (await seatFirstAskCrew(app.db, repo, actor.id)) repo = getRepoById(app.db, repo.id) ?? repo;
    else autonomyFailed = true;
  }
  const told = await tell(app, actor, repo, text, 1, from);
  return ok({ repo, autonomyFailed, told });
}

/** The organisation a spawned forge was made as, read synchronously from its `parent.json`. */
function spawnedName(app: App): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(app.config.dataDir, "parent.json"), "utf8")) as { org?: unknown };
    return typeof parsed.org === "string" ? parsed.org.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether this repository is the forge's own copy of its source (a child forge's
 * `<org>/forge`, or the repository the forge runs from): it is no one's app, so an ask
 * that names no repository never lands on it. An ask that names it still does.
 */
export function isForgeCopy(app: App, repo: Pick<Repo, "ownerName" | "name">): boolean {
  return forgeCopyTest(app)(repo);
}

/** `isForgeCopy` for many repositories: the source setting is read once, not per repository. */
export function forgeCopyTest(app: App): (repo: Pick<Repo, "ownerName" | "name">) => boolean {
  const own = forgeSource(app.db, app.config.forgeRepo);
  const spawned = spawnedName(app);
  return (repo) => isNamed(own, repo) || (repo.name === FORGE_CODE_NAME && repo.ownerName.toLowerCase() === spawned);
}

/**
 * Repositories apps first, the forge's own copy last, and whether nothing but the copy is there;
 * the setting is read once.
 */
export function appsFirst<R extends Pick<Repo, "ownerName" | "name">>(
  app: App,
  repos: readonly R[],
): { ordered: R[]; onlyForgeCopy: boolean } {
  const isCopy = forgeCopyTest(app);
  const ordered = [...repos.filter((r) => !isCopy(r)), ...repos.filter(isCopy)];
  return { ordered, onlyForgeCopy: repos.length > 0 && ordered.every(isCopy) };
}

/**
 * The one decision of where an ask that names no repository goes: true when it makes a new
 * app, as it does for a person with none. That is a person with no app but the forge's own
 * copy, on a forge where they own that copy or the first ask is still to come. Web home,
 * the terminal home and `tell` without a repo all ask this.
 */
export async function asksMakeANewApp(app: App, user: User | undefined): Promise<boolean> {
  if (user === undefined || user.kind !== "user") return false;
  const writable = listReposWritableTo(app.db, user, { limit: 200, withoutArchived: true });
  const records = appsForRepos(app.db, writable.map((r) => r.id));
  const mine = writable.filter((r) => records.has(r.id));
  if (mine.some((r) => !isForgeCopy(app, r))) return false;
  if (mine.length > 0) return true;
  const steps = await nextStepsFor(app, user);
  return steps?.some((s) => s.key === "tell" && !s.done) === true;
}
