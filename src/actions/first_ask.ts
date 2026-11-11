/**
 * The first ask of a new forge (#11342): one sentence makes a new app named
 * from it, turns the crew loose on it when the crew can run, and files the
 * sentence there as the app's one issue. The page calls
 * this.
 */

import type { App } from "../app.ts";
import type { Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { newAppFromSentence, NEW_APP_ERRORS } from "./apps.ts";
import { updateRepoSettings } from "./repos.ts";
import { NOT_TOLD_WORDS, SAY_SOMETHING_WORDS } from "./tell_words.ts";
import { FROM_WORDS, TOO_LONG_WORDS, tell, type TellError, type Told } from "./tell.ts";
import { parseFrom } from "./tell_from.ts";
import { requireVerified } from "./verify.ts";
import { MAX_BODY } from "../core/issues.ts";
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

export async function firstAsk(
  app: App,
  actor: User | undefined,
  said: string,
  crewCanRun: boolean,
  from: string | null = null,
): Promise<Result<FirstAsk, FirstAskError>> {
  const text = said.trim();
  if (text === "") return err({ words: SAY_SOMETHING_WORDS });
  // Everything the tell could refuse is asked before the app exists, so a
  // refused ask leaves nothing behind and a retry makes no second app. The
  // new app's owner is the actor, who may direct the crew on it.
  if (text.length > MAX_BODY) return err({ words: TOO_LONG_WORDS });
  if (actor === undefined || actor.kind === "org") return err({ words: DIRECTION_NOTE });
  if (!requireVerified(app, actor).ok) return err({ words: "Verify your email first." });
  if (from !== null && typeof parseFrom(from) !== "string") return err({ words: FROM_WORDS });
  // An empty description: the issue the tell files is the one issue of the ask.
  const made = await newAppFromSentence(app, actor, { sentence: text, description: "" });
  if (!made.ok) return err({ words: NEW_APP_ERRORS[made.code] ?? NOT_TOLD_WORDS });
  let repo = made.repo;
  let autonomyFailed = false;
  if (crewCanRun) {
    const on = await updateRepoSettings(app, actor, repo, { autonomy: "autonomous" });
    if (on.ok) {
      repo = on.value;
    } else autonomyFailed = true;
  }
  const told = await tell(app, actor, repo, text, 1, from);
  return ok({ repo, autonomyFailed, told });
}
