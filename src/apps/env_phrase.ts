/**
 * An environment's state in a person's words, with the tone it wears — plain
 * data, so the studio (`web/ui.ts` re-exports it) and the terminal's deploys
 * screen say the same thing without the terminal importing a web module.
 */

import type { EnvStatus } from "./runtime.ts";

/** The sentence a serving environment carries while its tests still run;
 * `runtime.ts` sets it and the studio reads it to word its badge. */
export const VERIFYING_NOTE = "serving — still verifying its tests";

/** The tones an environment's word wears; the web's `Tone` and the terminal's both hold them. */
export type EnvPhraseTone = "default" | "success" | "danger" | "attn";

/**
 * An environment's state in a person's words rather than a badge's —
 * `live`, `serving · tests failed`, `not up`, `not running` — for a head
 * that speaks one line. A card head wears `envStateBadge` instead. How fast
 * it came up belongs to `envFacts`, which sits under this and says it once.
 *
 * A serving app is never called down because its tests are red: the words
 * say the tests failed, and the tone is not green: it answers, but not
 * verified. While they still run it reads `serving · verifying`, neither
 * green nor failed.
 */
export function envPhrase(env: EnvStatus | undefined): {
  word: string;
  tone: EnvPhraseTone;
} {
  if (env?.dormant !== undefined) return { word: "asleep", tone: "default" };
  if (env === undefined || env.state === "stopped")
    return { word: "not running", tone: "default" };
  if (env.state === "failed") return { word: "not up", tone: "danger" };
  if (env.state === "deploying") return { word: "starting", tone: "default" };
  // It answers, so it is not "not up" — but a newer push never came up
  // behind it, so it is not plain green either.
  if (env.failedDeploy !== undefined)
    return { word: "live · a newer push failed", tone: "attn" };
  if (env.error !== undefined)
    return { word: "serving · tests failed", tone: "attn" };
  if (env.note === VERIFYING_NOTE)
    return { word: "serving · verifying", tone: "default" };
  return { word: "live", tone: "success" };
}
