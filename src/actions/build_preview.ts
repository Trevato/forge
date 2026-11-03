/**
 * Preview now: any commit of an app, served for a while at
 * `<slug>--b<sha7>` with a copy of production's data, the way a preview is.
 * It is how a writer looks at a build without pinning it or opening a pull.
 *
 * Nothing of it is stored: no ref, no row. The runtime holds it in memory
 * (`AppsRuntime.previewBuild`), at most `BUILD_PREVIEWS_MAX` per app, the
 * oldest giving way to a newer one, and a forge coming back removes it.
 * The ask is announced on the outbox (`app.build_preview`).
 *
 * Each new build can tear down the oldest and starts a deploy, so one person
 * may ask `BUILD_ASKS_MAX` times per app in `BUILD_ASKS_WINDOW_MS`, counted
 * in memory by their identity (a restart forgives, as `core/ratelimit.ts`).
 */

import type { App } from "../app.ts";
import { buildEnv, type EnvName } from "../apps/data.ts";
import { appsRuntime } from "../apps/runtime.ts";
import { getAppByRepo } from "../core/apps.ts";
import type { Repo } from "../core/repos.ts";
import type { Run } from "../core/runs.ts";
import type { User } from "../core/users.ts";
import { isSafeOid } from "../git/guard.ts";
import { readerFor } from "../git/read.ts";
import { repoDir } from "../git/repos.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { isMirror } from "../origins/write-through.ts";
import { requireWriter, type AccessError } from "./access.ts";
import { requireVerified } from "./verify.ts";

export type PreviewBuildError =
  | AccessError
  | "unverified"
  /** The repository mirrors an origin: preview a build in a fork of it. */
  | "mirrored"
  /** `oid` is not a full object id naming a commit in this repository. */
  | "not_a_commit"
  /** Apps are off on this forge: nothing can serve the build. */
  | "no_runtime"
  /** This person asked too often for this app; try again later. */
  | "rate_limited";

export const BUILD_ASKS_MAX = 20;
export const BUILD_ASKS_WINDOW_MS = 10 * 60_000;

const asks = new WeakMap<App, Map<string, number[]>>();

/** Record an ask by `actorId` of `appId`; false when it is over the limit. */
function allowed(app: App, actorId: string, appId: string, now = Date.now()): boolean {
  let byKey = asks.get(app);
  if (byKey === undefined) asks.set(app, (byKey = new Map()));
  const key = `${actorId}:${appId}`;
  const recent = (byKey.get(key) ?? []).filter((t) => now - t < BUILD_ASKS_WINDOW_MS);
  if (recent.length >= BUILD_ASKS_MAX) {
    byKey.set(key, recent);
    return false;
  }
  recent.push(now);
  byKey.set(key, recent);
  return true;
}

/** A refusal as a person reads it, on the terminal and anywhere else that says it in words. */
export function previewBuildRefusalText(error: string): string {
  switch (error) {
    case "unauthorized":
    case "forbidden":
      return "Only a person with write access can preview a build.";
    case "unverified":
      return "Verify your email first: open the link the forge mailed you, or ask for another from your account settings.";
    case "mirrored":
      return "This repository mirrors another: preview a build in a fork of it.";
    case "not_a_commit":
      return "That is not a commit in this repository (give the full 40-character id).";
    case "no_runtime":
      return "Nothing is serving apps on this forge.";
    case "rate_limited":
      return "You have asked for a lot of builds; wait a few minutes.";
    case "not_found":
      return "This repository has no app.";
    default:
      return "That could not be done.";
  }
}

export interface BuildPreview {
  readonly env: EnvName;
  readonly url: string;
  /** The deploy that brings it up, or undefined when it is already here. */
  readonly run: Run | undefined;
}

/**
 * Serve the commit `oid` (a full id in this repository) at its own short-
 * lived environment. A verified person who can write the repository may
 * ask, never an agent. Asking for one already here redeploys nothing.
 */
export async function previewBuild(
  app: App,
  actor: User | undefined,
  repo: Repo,
  oid: string,
): Promise<Result<BuildPreview, PreviewBuildError>> {
  const writer = requireWriter(app, actor, repo);
  if (!writer.ok) return writer;
  // The crew proposes; a person chooses what is shown (docs/APPS.md rule 1).
  if (writer.value.kind === "agent") return err("forbidden");
  const proven = requireVerified(app, writer.value);
  if (!proven.ok) return proven;
  if (isMirror(app, repo)) return err("mirrored");
  const record = getAppByRepo(app.db, repo.id);
  if (record === undefined) return err("not_found");
  if (!isSafeOid(oid)) return err("not_a_commit");
  const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
  const stat = await readerFor(dir).stat(oid);
  if (!stat.ok || stat.value.type !== "commit") return err("not_a_commit");
  const runtime = appsRuntime(app);
  if (runtime === undefined) return err("no_runtime");
  if (!allowed(app, writer.value.id, record.id)) return err("rate_limited");

  app.bus.append({
    kind: "app.build_preview",
    repoId: repo.id,
    actorId: writer.value.id,
    payload: { env: buildEnv(oid), oid },
  });
  const { env, run } = await runtime.previewBuild(record, repo, oid, writer.value.id);
  return ok({ env, url: runtime.urlFor(record, env), run });
}
