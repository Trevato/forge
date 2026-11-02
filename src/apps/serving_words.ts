/**
 * Whether an environment is serving, in words: one place for the sentence
 * the proxy's not-serving page shows and the `preview` tool says. Plain
 * data in, plain data out.
 */

import { redactHeld } from "../kernel/log.ts";
import type { EnvStatus } from "./runtime.ts";

export type ServingState = "running" | "starting" | "failed" | "not_running" | "gone";

export interface ServingWords {
  readonly state: ServingState;
  readonly says: string;
}

/**
 * `pull` is what an open-or-not pull is for a preview: "open" or "closed"
 * (a missing pull is closed), and null for production. An open pull is never gone:
 * it deploys again on the next push.
 */
export function servingWords(status: EnvStatus | undefined, pull: "open" | "closed" | null): ServingWords {
  const state = status?.state ?? "stopped";
  if (state === "running") return { state: "running", says: "It is running." };
  if (state === "deploying") return { state: "starting", says: "A new version is starting." };
  if (state === "failed" || (state === "asleep" && status?.error !== undefined))
    return { state: "failed", says: redactHeld(status?.error ?? "The last deploy failed.") };
  if (pull === "closed")
    return { state: "gone", says: "This preview is gone: its pull was closed, and its data with it." };
  if (pull === "open" && status === undefined)
    return {
      state: "not_running",
      says: "The preview is not running. It starts again with the next push to the pull, or with app_deploy redeploy.",
    };
  return { state: "not_running", says: "Nothing is running here yet." };
}
