/**
 * Bring an app whole (#8904): paste the link to an app on another forge and
 * it is mirrored here, registered as an app and deployed, with its link back
 * kept (a mirror knows its origin, so improvements flow to the author).
 *
 * What comes: the code and its history, and how it builds and runs (its own
 * `forge.json`). What never comes by itself: data, variables and secrets.
 * The app lands private; what it asks for (the names in its `.env.example`)
 * is listed and asked for in one form.
 *
 * The page and the terminal both call this; it is the same two steps an
 * agent already has (`mirror` an origin repository, then enable the app).
 */

import type { App } from "../app.ts";
import { getAppByRepo, slugFor, getAppBySlug, SLUG_MAX, type AppRecord } from "../core/apps.ts";
import { listAppEnvNames } from "../core/app_env.ts";
import { listOrigins } from "../core/origins.ts";
import { getRepoById, type Repo } from "../core/repos.ts";
import { isActive, type User } from "../core/users.ts";
import { readerFor } from "../git/read.ts";
import { repoDir } from "../git/repos.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { startMirror } from "../origins/mirror.ts";
import type { MirrorJob } from "../origins/jobs.ts";
import { needsOf, originOnHost, parseBringLink } from "../origins/bring.ts";
import { requireVerified } from "./verify.ts";
import { appLimitWords } from "./app_limit.ts";
import { enableApp, setAppEnvVar } from "./apps.ts";

export type BringError =
  | { readonly kind: "unauthorized" }
  | { readonly kind: "unverified" }
  | { readonly kind: "invalid"; readonly message: string }
  /** No connected account on that forge: sign in there first. */
  | { readonly kind: "connect"; readonly host: string };

const LINK_WORDS = {
  empty: "Paste the link to an app.",
  not_a_link: "That is not a link to a repository (https://host/owner/name).",
  not_a_repository: "That link does not name a repository: it needs the owner and the name.",
} as const;

/** Start bringing the app at `link`; the job is the first deploy's first half. */
export function startBring(
  app: App,
  actor: User | undefined,
  link: string,
): Result<{ job: MirrorJob; originId: string }, BringError> {
  if (actor === undefined || !isActive(actor) || actor.kind === "agent")
    return err({ kind: "unauthorized" });
  const proven = requireVerified(app, actor);
  if (!proven.ok) return err({ kind: "unverified" });
  const parsed = parseBringLink(link);
  if (!parsed.ok) return err({ kind: "invalid", message: LINK_WORDS[parsed.error] });
  const origin = originOnHost(listOrigins(app.db, actor.id), parsed.value.host);
  if (origin === undefined) return err({ kind: "connect", host: parsed.value.host });
  const job = startMirror(app, actor, origin, parsed.value.fullName);
  return ok({ job, originId: origin.id });
}

export interface Brought {
  readonly repo: Repo;
  readonly app: AppRecord;
  /** Names the app asks for, with whether each is already set. */
  readonly needs: readonly { readonly name: string; readonly set: boolean }[];
}

function freeSlug(app: App, name: string, owner: string): string {
  const base = slugFor(`${name}-${owner}`).slice(0, SLUG_MAX - 3).replace(/-+$/, "");
  for (let n = 1; n < 100; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    if (getAppBySlug(app.db, candidate) === undefined) return candidate;
  }
  return `${base}-${Date.now().toString(36).slice(-4)}`;
}

/** What a landed copy is, read only: registered or not, and what it asks for. */
export interface Looked {
  readonly repo: Repo;
  readonly app: AppRecord | undefined;
  readonly needs: readonly { readonly name: string; readonly set: boolean }[];
}

type NotYet = { kind: "invalid"; message: string };

/** Read a landed copy without changing anything: safe for a GET. Only the job's owner gets here. */
export async function bringLook(app: App, actor: User, job: MirrorJob): Promise<Result<Looked, NotYet>> {
  if (job.repo === undefined) return err({ kind: "invalid", message: "the copy is not made yet" });
  const repo = getRepoById(app.db, job.repo.id);
  if (repo === undefined || repo.ownerId !== actor.id)
    return err({ kind: "invalid", message: "the copy is not made yet" });
  const record = getAppByRepo(app.db, repo.id);
  const example = await readerFor(repoDir(app.reposRoot, repo.ownerName, repo.name)).object(
    "HEAD:.env.example",
  );
  const names = example.ok && example.value.type === "blob"
    ? needsOf(new TextDecoder().decode(example.value.body.slice(0, 65_536)))
    : [];
  const have = new Set(record === undefined ? [] : listAppEnvNames(app.db, record.id).map((e) => e.name));
  return ok({ repo, app: record, needs: names.map((name) => ({ name, set: have.has(name) })) });
}

/**
 * Once the mirror is whole: register it as an app (private, once; asking
 * again lands on the same app) and read what it asks for. A mutation: call
 * it from a POST or a terminal key, never a GET.
 */
export async function bringLanded(
  app: App,
  actor: User,
  job: MirrorJob,
): Promise<Result<Brought, NotYet>> {
  const looked = await bringLook(app, actor, job);
  if (!looked.ok) return looked;
  let record = looked.value.app;
  if (record === undefined) {
    // Private first: the code may be public, running it for the world is a choice.
    const enabled = enableApp(app, actor, looked.value.repo, {
      slug: freeSlug(app, looked.value.repo.name, actor.username),
      access: "private",
    });
    if (!enabled.ok)
      return err({
        kind: "invalid",
        message:
          enabled.error === "app_limit"
            ? appLimitWords(app, actor.id)
            : `the app could not be registered: ${enabled.error}`,
      });
    record = enabled.value;
  }
  return ok({ repo: looked.value.repo, app: record, needs: looked.value.needs });
}

/** The one form: set each non-empty value, for names the app asked for only. */
export async function setBroughtEnv(
  app: App,
  actor: User,
  brought: Brought,
  values: ReadonlyMap<string, string>,
): Promise<number> {
  let count = 0;
  for (const { name } of brought.needs) {
    const value = values.get(name);
    if (value === undefined || value === "") continue;
    const set = await setAppEnvVar(app, actor, brought.repo, name, value);
    if (set.ok) count++;
  }
  return count;
}
