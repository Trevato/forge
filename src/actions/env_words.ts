/**
 * What a person is told after redeploying or stopping an environment
 * (`redeployEnv`, `stopEnv`). Said the same on the app's page and in the
 * terminal's deploys screen, from here.
 */

import { envBuild, envPull, type EnvName } from "../apps/data.ts";
import type { Run } from "../core/runs.ts";
import { VERIFY_FIRST } from "./verify_words.ts";

/** `production`, `preview of #12` or `build 1a2b3c4`, as a phrase that fits in a sentence. */
export function envLabel(env: EnvName): string {
  const build = envBuild(env);
  if (build !== undefined) return `build ${build}`;
  const number = envPull(env);
  return number === undefined ? "production" : `preview of #${number}`;
}

/** A redeploy was queued, or there was nothing new to serve. */
export function redeployedText(env: EnvName, run: Run | undefined): string {
  return run === undefined
    ? `${envLabel(env)} already serves that commit.`
    : `Redeploying ${envLabel(env)}.`;
}

/** An environment was stopped. */
export function stoppedText(env: EnvName): string {
  return `Stopped ${envLabel(env)}. Its data is kept; Redeploy brings it back.`;
}

const REFUSALS: Readonly<Record<string, string>> = {
  forbidden: "You need write access to do that.",
  unverified: `${VERIFY_FIRST[0]!.toUpperCase()}${VERIFY_FIRST.slice(1)}: open the link the forge mailed you, or ask for another from your account settings.`,
  not_found: "This repository has no app.",
  no_such_env: "There is no such environment: name production, or a pull's preview as pull-N.",
  no_runtime: "Nothing is serving apps on this forge.",
  nothing_to_deploy:
    "There is nothing to deploy: the branch has no commits, or the pull request is closed.",
};

/**
 * Why a redeploy or stop was refused. The page answers `not_found` and
 * `no_such_env` with its 404 before asking; the terminal says them here.
 */
export function envRefusalText(error: string): string {
  return REFUSALS[error] ?? "That could not be done.";
}
