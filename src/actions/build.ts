/**
 * Talk builds an app (#11010). One prompt makes the repository from a
 * template and starts a conversation in it; each turn that changes code is a
 * commit on the conversation's branch, numbered v1, v2, …; Restore makes a
 * new version from an old one; Publish merges the branch to the default
 * branch, which deploys production. Versions are the branch's commits, read
 * from git: nothing about them is stored twice.
 */

import type { App } from "../app.ts";
import { appsRuntime } from "../apps/runtime.ts";
import { previewEnv } from "../apps/data.ts";
import { offeredTemplates } from "../core/app_templates.ts";
import { type ChatBuild, branchFor, chatBuildOf, setBuildPublished, startChatBuild, unpublishedBuilds } from "../core/chat_build.ts";
import { RateLimiter } from "../core/ratelimit.ts";
import { commitIdentity } from "../core/commit_identity.ts";
import { getAppByRepo } from "../core/apps.ts";
import { createConversation, dropConversation, getConversation, renameConversation, TITLE_MAX } from "../core/conversations.ts";
import { getPull } from "../core/pulls.ts";
import { getRepoById, type Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { diffCommit, type Diff } from "../git/diff.ts";
import { runGit } from "../git/env.ts";
import { moveRefLeased } from "../git/branches.ts";
import { resolveOid, treeOf } from "../git/merge.ts";
import { repoDir } from "../git/repos.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { requireUser, requireWriter } from "./access.ts";
import { newAppFromSentence } from "./apps.ts";
import { createBranch } from "./branches.ts";
import { ensureBuildPull, type Version, versionsIn } from "./build_pull.ts";
import { mergePull } from "./pulls.ts";
import { deleteRepo } from "./repos.ts";
import { talk, type TalkRefusal } from "./talk.ts";

export { VERSIONS_MAX, type Version } from "./build_pull.ts";

export interface BuildState {
  readonly build: ChatBuild;
  readonly repoName: string;
  readonly versions: readonly Version[];
  /** The preview of the newest version, once there is a version and its environment exists. */
  readonly previewUrl: string | null;
  readonly previewState: string | null;
  /** Production's address, shown once published. */
  readonly productionUrl: string | null;
  readonly published: boolean;
}

/** Builds a person may start in an hour, and may hold unpublished at once. */
export const BUILDS_PER_HOUR = 5;
export const UNPUBLISHED_MAX = 10;

const limiters = new WeakMap<App, RateLimiter>();

/** Throttle by user id (never a header): false past `BUILDS_PER_HOUR` an hour. */
function takeBuild(app: App, user: User): boolean {
  let limiter = limiters.get(app);
  if (limiter === undefined) {
    limiter = new RateLimiter({ perMinute: BUILDS_PER_HOUR, adminPerMinute: BUILDS_PER_HOUR, enabled: true, windowMs: 3_600_000 });
    limiters.set(app, limiter);
  }
  return limiter.take(`build:${user.id}`, "rw").allowed;
}

export type BuildError = "unauthorized" | "not_found" | "no_name" | "no_version" | "nothing_to_publish" | "moved" | "bad_template" | "rate_limited" | "too_many_builds" | "failed";

export const BUILD_WORDS: Readonly<Record<string, string>> = {
  unauthorized: "Sign in to build.",
  not_found: "No such build.",
  no_name: "Say what you want to build in a few words.",
  no_version: "There is no such version.",
  nothing_to_publish: "Nothing to publish yet: no version has changed the app.",
  moved: "The build changed while you did that. Try again.",
  bad_template: "That template is not on offer to you.",
  rate_limited: `At most ${BUILDS_PER_HOUR} builds an hour; try again later.`,
  too_many_builds: `You hold ${UNPUBLISHED_MAX} builds that are not published; publish one first.`,
  failed: "That did not go through.",
};

/** A prompt as a one-line title. */
const titleOf = (prompt: string): string => prompt.replace(/\s+/g, " ").trim().slice(0, TITLE_MAX);

/**
 * Make the repository from the template, start the chat on its branch and
 * send the prompt. `said` is the refusal when the agent could not take the
 * words (no account, resting): the build still exists and the person can send again.
 */
export async function startBuild(
  app: App,
  actor: User | undefined,
  input: { readonly prompt: string; readonly template?: string },
): Promise<Result<{ build: ChatBuild; repo: Repo; said: TalkRefusal | undefined }, BuildError>> {
  const user = requireUser(actor);
  if (!user.ok) return user;
  const template = input.template === undefined || input.template === "" ? undefined : input.template;
  // The API reaches this too: a template is only ever one the person can see.
  if (template !== undefined && !offeredTemplates(app.db, user.value).includes(template)) return err("bad_template");
  if (unpublishedBuilds(app.db, user.value.id) >= UNPUBLISHED_MAX) return err("too_many_builds");
  if (!takeBuild(app, user.value)) return err("rate_limited");
  // Cheapest step first, so a refusal there leaves nothing; later failures take back what was made.
  const conversation = createConversation(app.db, user.value.id);
  if (!conversation.ok) return err("failed");
  const made = await newAppFromSentence(app, user.value, { sentence: input.prompt, ...(template === undefined ? {} : { template }) });
  if (!made.ok) {
    dropConversation(app.db, user.value.id, conversation.value.id);
    // Words that name nothing cost nothing, so they do not use up the hour.
    if (made.code === "no_name") limiters.get(app)?.refund(`build:${user.value.id}`);
    return err(made.code === "no_name" ? "no_name" : "failed");
  }
  const branch = await createBranch(app, user.value, made.repo, { name: branchFor(conversation.value.id) });
  if (!branch.ok) {
    await deleteRepo(app, user.value, made.repo);
    dropConversation(app.db, user.value.id, conversation.value.id);
    return err("failed");
  }
  const build = startChatBuild(app.db, conversation.value.id, made.repo.id);
  renameConversation(app.db, user.value.id, conversation.value.id, titleOf(input.prompt));
  const said = talk(app, user.value, input.prompt, [], "queue", conversation.value.id);
  return ok({ build, repo: made.repo, said: said.ok ? undefined : said.error });
}

/** The build of one of the person's own conversations, with the repository it is in. */
function buildOf(app: App, user: User, conversationId: string): { build: ChatBuild; repo: Repo } | undefined {
  if (getConversation(app.db, user.id, conversationId) === undefined) return undefined;
  const build = chatBuildOf(app.db, conversationId);
  const repo = build === undefined ? undefined : getRepoById(app.db, build.repoId);
  return build === undefined || repo === undefined ? undefined : { build, repo };
}

/**
 * Where the build stands. Pure: a read never opens the pull (a turn's end,
 * Restore and Publish do, `build_pull.ts`).
 */
export async function buildState(app: App, actor: User | undefined, conversationId: string): Promise<Result<BuildState, BuildError>> {
  const user = requireUser(actor);
  if (!user.ok) return user;
  const found = buildOf(app, user.value, conversationId);
  if (found === undefined) return err("not_found");
  const { repo } = found;
  const { build } = found;
  const versions = build.publishedAt === null ? await versionsIn(app, repo, build) : [];
  const record = getAppByRepo(app.db, repo.id);
  const runtime = appsRuntime(app);
  const env = build.pullNumber === null ? undefined : previewEnv(build.pullNumber);
  const status = record === undefined || runtime === undefined || env === undefined ? undefined : runtime.envStatus(record, env);
  return ok({
    build,
    repoName: `${repo.ownerName}/${repo.name}`,
    versions,
    previewUrl: record === undefined || runtime === undefined || env === undefined || build.publishedAt !== null ? null : runtime.urlFor(record, env),
    previewState: build.publishedAt !== null ? null : (status?.state ?? null),
    productionUrl: build.publishedAt === null || record === undefined || runtime === undefined ? null : runtime.urlFor(record, "production"),
    published: build.publishedAt !== null,
  });
}

/** The diff one version made, against the version before it. */
export async function versionDiff(app: App, actor: User | undefined, conversationId: string, number: number): Promise<Result<Diff, BuildError>> {
  const user = requireUser(actor);
  if (!user.ok) return user;
  const found = buildOf(app, user.value, conversationId);
  if (found === undefined) return err("not_found");
  const version = (await versionsIn(app, found.repo, found.build)).find((v) => v.number === number);
  if (version === undefined) return err("no_version");
  const diff = await diffCommit(repoDir(app.reposRoot, found.repo.ownerName, found.repo.name), version.oid);
  return diff.ok ? ok(diff.value) : err("failed");
}

/** A new version holding exactly what an earlier one held; history is kept, nothing is rewritten. */
export async function restoreVersion(app: App, actor: User | undefined, conversationId: string, number: number): Promise<Result<Version, BuildError>> {
  const user = requireUser(actor);
  if (!user.ok) return user;
  const found = buildOf(app, user.value, conversationId);
  if (found === undefined) return err("not_found");
  const { repo, build } = found;
  if (build.publishedAt !== null) return err("not_found");
  const writer = requireWriter(app, user.value, repo);
  if (!writer.ok) return err("not_found");
  const versions = await versionsIn(app, repo, build);
  const from = versions.find((v) => v.number === number);
  if (from === undefined) return err("no_version");
  const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
  const tip = await resolveOid(dir, `refs/heads/${build.branch}`);
  const tree = await treeOf(dir, from.oid);
  if (tip === undefined || tree === undefined) return err("failed");
  const who = commitIdentity(app.config, writer.value);
  const made = await runGit(["commit-tree", tree, "-p", tip, "-m", `Restore v${number}\n\nThe app as it was at v${number}: ${from.subject}`], {
    cwd: dir,
    env: { GIT_AUTHOR_NAME: who.name, GIT_AUTHOR_EMAIL: who.email, GIT_COMMITTER_NAME: who.name, GIT_COMMITTER_EMAIL: who.email },
  });
  if (!made.ok) return err("failed");
  const oid = made.value.trim();
  const moved = await moveRefLeased(dir, `refs/heads/${build.branch}`, oid, tip);
  if (!moved.ok) return err(moved.error === "ref_moved" ? "moved" : "failed");
  // `update-ref` runs no hooks: announce the push as a git push would be, so the preview deploys.
  app.bus.append({ kind: "push", repoId: repo.id, actorId: writer.value.id, payload: { updates: [{ ref: `refs/heads/${build.branch}`, oldOid: tip, newOid: oid }], viaApi: true } });
  await ensureBuildPull(app, writer.value, build, repo);
  return ok({ number: versions.length + 1, oid, subject: `Restore v${number}`, date: new Date().toISOString() });
}

/** Merge the branch to the default branch, which deploys production. */
export async function publishBuild(app: App, actor: User | undefined, conversationId: string): Promise<Result<{ productionUrl: string | null }, BuildError>> {
  const user = requireUser(actor);
  if (!user.ok) return user;
  const state = await buildState(app, user.value, conversationId);
  if (!state.ok) return state;
  const repo = getRepoById(app.db, state.value.build.repoId);
  if (repo === undefined) return err("not_found");
  if (state.value.published) return ok({ productionUrl: state.value.productionUrl });
  const writer = requireWriter(app, user.value, repo);
  if (!writer.ok) return err("not_found");
  const build = await ensureBuildPull(app, writer.value, state.value.build, repo);
  if (build.pullNumber === null || state.value.versions.length === 0) return err("nothing_to_publish");
  const pull = getPull(app.db, repo.id, build.pullNumber);
  if (pull === undefined) return err("not_found");
  const merged = await mergePull(app, user.value, repo, pull, "merge");
  if (!merged.ok) return err("failed");
  setBuildPublished(app.db, conversationId);
  const after = await buildState(app, user.value, conversationId);
  return ok({ productionUrl: after.ok ? after.value.productionUrl : null });
}
