/**
 * App actions: make a repository an app, make a new app from nothing,
 * change how it is served, take it down, and redeploy or stop an
 * environment. Admin over the repository turns an app on and off and
 * changes its settings; a writer may redeploy or stop; anyone who can read
 * the repository may look at it and open its environments.
 */

import type { App } from "../app.ts";
import { appsRuntime, type EnvStatus } from "../apps/runtime.ts";
import { grantUrl } from "../apps/proxy.ts";
import { scaffoldFiles } from "../apps/scaffold.ts";
import {
  isEnvName,
  previewEnv,
  type EnvName,
  type PreviewData,
} from "../apps/data.ts";
import {
  createApp as insertApp,
  deleteApp as removeApp,
  getAppByRepo,
  slugFor,
  updateApp as patchApp,
  type AppAccess,
  type AppRecord,
  type CreateAppError,
  type UpdateAppError,
} from "../core/apps.ts";
import {
  deleteAppEnv,
  isAppEnvScope,
  listAppEnvNames,
  setAppEnv,
  type AppEnvError,
  type AppEnvName,
  type AppEnvScope,
} from "../core/app_env.ts";
import { addCrew, getAgentByName } from "../core/agents.ts";
import { listAllAgents } from "./crew.ts";
import { plan, planIssueBody, planningAvailable } from "../crew/plan.ts";
import type { Issue } from "../core/issues.ts";
import { getPull } from "../core/pulls.ts";
import { canWrite, type Repo } from "../core/repos.ts";
import type { Run } from "../core/runs.ts";
import type { User } from "../core/users.ts";
import { resolveOid } from "../git/merge.ts";
import { repoDir } from "../git/repos.ts";
import { sshCommand } from "../ssh/command.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import {
  requireReader,
  requireRepoAdmin,
  requireUser,
  requireWriter,
  type AccessError,
} from "./access.ts";
import { assignIssue, openIssue } from "./issues.ts";
import {
  commitToBranch,
  createRepo,
  type CreateRepoActionError,
} from "./repos.ts";

export interface AppSettingsInput {
  slug?: string;
  access?: AppAccess;
  previewData?: PreviewData;
}

/** Turn an existing repository into an app. */
export function enableApp(
  app: App,
  actor: User | undefined,
  repo: Repo,
  input: AppSettingsInput = {},
): Result<AppRecord, "not_found" | CreateAppError> {
  const admin = requireRepoAdmin(app, actor, repo);
  if (!admin.ok) return admin;
  const created = insertApp(app.db, {
    repoId: repo.id,
    slug: input.slug ?? slugFor(repo.name),
    access: input.access ?? repo.visibility,
    ...(input.previewData === undefined
      ? {}
      : { previewData: input.previewData }),
  });
  if (!created.ok) return created;
  app.bus.append({
    kind: "app.created",
    repoId: repo.id,
    actorId: admin.value.id,
    payload: { slug: created.value.slug },
  });
  return created;
}

export function updateAppSettings(
  app: App,
  actor: User | undefined,
  repo: Repo,
  patch: AppSettingsInput,
): Result<AppRecord, "not_found" | UpdateAppError> {
  const admin = requireRepoAdmin(app, actor, repo);
  if (!admin.ok) return admin;
  const record = getAppByRepo(app.db, repo.id);
  if (!record) return err("not_found");
  const updated = patchApp(app.db, record.id, patch);
  if (!updated.ok) return updated;
  if (!updated.value) return err("not_found");
  app.bus.append({
    kind: "app.updated",
    repoId: repo.id,
    actorId: admin.value.id,
    payload: { slug: updated.value.slug, access: updated.value.access },
  });
  return ok(updated.value);
}

// ---- the app's environment ----

/** The names set, for an admin. Never a value: those are write-only. */
export function listAppEnv(
  app: App,
  actor: User | undefined,
  repo: Repo,
): Result<AppEnvName[], "not_found"> {
  const admin = requireRepoAdmin(app, actor, repo);
  if (!admin.ok) return admin;
  const record = getAppByRepo(app.db, repo.id);
  if (!record) return err("not_found");
  return ok(listAppEnvNames(app.db, record.id));
}

/**
 * Set a variable in a scope and redeploy the environments that read it.
 * The event names the variable and its scope and nothing else; the value
 * is sealed in the row and goes nowhere but into the app's process.
 */
export async function setAppEnvVar(
  app: App,
  actor: User | undefined,
  repo: Repo,
  name: string,
  value: string,
  scope: string = "all",
): Promise<Result<AppEnvName, "not_found" | AppEnvError>> {
  const admin = requireRepoAdmin(app, actor, repo);
  if (!admin.ok) return admin;
  const record = getAppByRepo(app.db, repo.id);
  if (!record) return err("not_found");
  const set = setAppEnv(
    app.db,
    app.config.dataDir,
    record.id,
    name,
    value,
    scope,
  );
  if (!set.ok) return set;
  app.bus.append({
    kind: "app.env_set",
    repoId: repo.id,
    actorId: admin.value.id,
    payload: { name, scope: set.value.scope },
  });
  await redeployScope(app, record, repo, set.value.scope);
  return set;
}

/** Remove a variable from a scope and redeploy the environments that read it. */
export async function deleteAppEnvVar(
  app: App,
  actor: User | undefined,
  repo: Repo,
  name: string,
  scope: string = "all",
): Promise<Result<void, "not_found" | "no_such_var">> {
  const admin = requireRepoAdmin(app, actor, repo);
  if (!admin.ok) return admin;
  const record = getAppByRepo(app.db, repo.id);
  if (!record) return err("not_found");
  if (!isAppEnvScope(scope) || !deleteAppEnv(app.db, record.id, name, scope))
    return err("no_such_var");
  app.bus.append({
    kind: "app.env_deleted",
    repoId: repo.id,
    actorId: admin.value.id,
    payload: { name, scope },
  });
  await redeployScope(app, record, repo, scope);
  return ok();
}

/**
 * A process reads its environment once, at start: a change reaches the
 * app only through a new process. `redeploy` is what steps past the
 * same-commit guard. A variable for every environment reconciles all of
 * them; one scoped to production or to previews leaves the other running
 * as it was — a test key rotated for previews never restarts production.
 */
async function redeployScope(
  app: App,
  record: AppRecord,
  repo: Repo,
  scope: AppEnvScope,
): Promise<void> {
  await appsRuntime(app)?.reconcileApp(
    record,
    repo,
    "redeploy",
    scope === "all" ? undefined : scope,
  );
}

/** Stop serving the repository as an app. Data and checkouts are removed. */
export function disableApp(
  app: App,
  actor: User | undefined,
  repo: Repo,
): Result<void, "not_found"> {
  const admin = requireRepoAdmin(app, actor, repo);
  if (!admin.ok) return admin;
  const record = getAppByRepo(app.db, repo.id);
  if (!record) return err("not_found");
  removeApp(app.db, record.id);
  app.bus.append({
    kind: "app.deleted",
    repoId: repo.id,
    actorId: admin.value.id,
    payload: { slug: record.slug },
  });
  return ok();
}

export interface NewAppInput {
  name: string;
  /** The actor, or an org they can write to. */
  owner?: string;
  /** What the app should become; becomes the first issue when given. */
  description?: string;
  /** @default "private" */
  visibility?: "public" | "private";
  /** An agent to put on the crew and hand the first issue to. */
  agent?: string;
  /**
   * Turn the sentence into a checklist and pick the agent instead of
   * `agent` naming one. Ignored without a description, or when `agent` is
   * also given.
   */
  pickAgent?: boolean;
}

export interface NewAppResult {
  readonly repo: Repo;
  readonly app: AppRecord;
  /** The first issue, when a description was given and an agent named. */
  readonly issue?: Issue;
  /** Who the plan picked and why, when `pickAgent` landed one. */
  readonly plan?: { agent: string; summary: string; confidence: number };
}

export type NewAppError =
  | CreateRepoActionError
  | CreateAppError
  | "scaffold_failed"
  | "no_such_agent";

/**
 * The golden path's first step, as one call: a repository with a working
 * app in it, an app record so production starts, and — when asked — the
 * first issue assigned to an agent on the crew.
 */
export async function newApp(
  app: App,
  actor: User | undefined,
  input: NewAppInput,
): Promise<Result<NewAppResult, NewAppError>> {
  const user = requireUser(actor);
  if (!user.ok) return user;
  const agent =
    input.agent === undefined || input.agent === ""
      ? undefined
      : getAgentByName(app.db, input.agent);
  if (input.agent && !agent) return err("no_such_agent");

  const repo = await createRepo(app, user.value, {
    name: input.name,
    visibility: input.visibility ?? "private",
    description: input.description ?? "",
    ...(input.owner === undefined ? {} : { owner: input.owner }),
  });
  if (!repo.ok) return repo;
  const committed = await commitToBranch(app, user.value, repo.value, {
    message: `Start ${input.name}`,
    files: scaffoldFiles({
      name: input.name,
      description: input.description ?? "",
    }),
  });
  if (!committed.ok) return err("scaffold_failed");
  const record = enableApp(app, user.value, repo.value, {});
  // The creator administers the repository they just made, so `not_found`
  // here can only mean the row vanished under us — a failed scaffold.
  if (!record.ok)
    return err(record.error === "not_found" ? "scaffold_failed" : record.error);

  const description = (input.description ?? "").trim();
  let chosen = agent;
  let body = description;
  let picked: NewAppResult["plan"];

  // Off the critical path only in the sense that a slow or absent decider
  // costs at most `PLAN_TIMEOUT_MS` and never a wrong answer (crew/plan.ts):
  // the repository, the app and production above have already started.
  if (!agent && input.pickAgent && description !== "") {
    const binary = process.env["FORGE_CLAUDE"] ?? "claude";
    if (planningAvailable(binary)) {
      const roster = listAllAgents(app, user.value);
      const agents = roster.ok ? roster.value : [];
      if (agents.length > 0) {
        const result = await plan(
          {
            name: input.name,
            description,
            agents: agents.map((a) => ({ name: a.user.username, brief: a.brief })),
          },
          { binary },
        );
        const match =
          result && agents.find((a) => a.user.username === result.agent);
        if (result && match) {
          chosen = match;
          body = planIssueBody(result);
          picked = {
            agent: result.agent,
            summary: result.summary,
            confidence: result.confidence,
          };
        }
      }
    }
  }

  let issue: Issue | undefined;
  if (chosen) {
    addCrew(app.db, repo.value.id, chosen.user.id, user.value.id);
    app.bus.append({
      kind: "crew.added",
      repoId: repo.value.id,
      actorId: user.value.id,
      payload: { agent: chosen.user.username },
    });
  }
  // The sentence is the one thing the person wrote: it opens the first
  // issue whether or not anyone was picked for it, unassigned when not.
  if (body !== "") {
    const opened = openIssue(app, user.value, repo.value, {
      title: `Build ${input.name}`,
      body,
    });
    if (opened.ok) {
      issue = opened.value;
      if (chosen) {
        const assigned = assignIssue(
          app,
          user.value,
          repo.value,
          opened.value,
          chosen.user,
        );
        issue = assigned.ok ? assigned.value : opened.value;
      }
    }
  }
  return ok({
    repo: repo.value,
    app: record.value,
    ...(issue === undefined ? {} : { issue }),
    ...(picked === undefined ? {} : { plan: picked }),
  });
}

export interface AppView {
  readonly app: AppRecord;
  readonly environments: EnvStatus[];
  /** Whether a runtime is serving at all (`FORGE_APPS=0` means no). */
  readonly serving: boolean;
}

/**
 * The command that opens an environment's terminal interface, or undefined
 * when the forge runs without SSH. The login name is the app (`notes`) or
 * the preview (`notes--12`); the key decides who you are.
 */
export function sshCommandFor(
  app: App,
  record: AppRecord,
  env: EnvName,
): string | undefined {
  // Without a runtime nothing can answer that ssh, so there is no command.
  return appsRuntime(app)?.sshFor(record, env);
}

/**
 * The one fact behind every "Terminal" line a page draws: the exact
 * command, or — when there is nothing to show — why: this environment's
 * app declares no `tty`, or this forge itself has no SSH listener
 * (`app.config.sshPort`, `0` on a forge hosted as an app of another —
 * issue #283). A status that has never been live does not know its `tty`
 * yet, so the command still shows when SSH is on; the environment's own
 * state already says it is not running.
 */
export function terminalFor(
  app: App,
  record: AppRecord,
  env: EnvName,
  status: EnvStatus | undefined,
): { readonly command?: string; readonly reason?: "no_tty" | "no_listener" } {
  if (status?.tty === null) return { reason: "no_tty" };
  const command = sshCommandFor(app, record, env);
  if (command !== undefined) return { command };
  return sshCommand(app) === undefined ? { reason: "no_listener" } : {};
}

/** What is running, for anyone who can see the repository. */
export function appView(
  app: App,
  actor: User | undefined,
  repo: Repo,
): Result<AppView, "not_found"> {
  const reader = requireReader(app, actor, repo);
  if (!reader.ok) return reader;
  const record = getAppByRepo(app.db, repo.id);
  if (!record) return err("not_found");
  const runtime = appsRuntime(app);
  return ok({
    app: record,
    environments: runtime === undefined ? [] : runtime.status(record),
    serving: runtime !== undefined,
  });
}

export type EnvError = "not_found" | "no_runtime" | "no_such_env";

/** The URL to open an environment at — via a grant for a private app. */
export function openEnvUrl(
  app: App,
  actor: User | undefined,
  repo: Repo,
  env: string,
  path = "/",
  /** The hostname the visitor asked for, when it is one of this app's. */
  host?: string,
): Result<string, EnvError | "unauthorized"> {
  const reader = requireReader(app, actor, repo);
  if (!reader.ok) return reader;
  const record = getAppByRepo(app.db, repo.id);
  if (!record) return err("not_found");
  if (!isEnvName(env)) return err("no_such_env");
  const runtime = appsRuntime(app);
  if (runtime === undefined) return err("no_runtime");
  // A grant names a person, so the app hears who they are: a signed-in
  // visitor always goes in through one, public app or private. Anonymous
  // visitors walk into a public app and get a private one's answer.
  if (actor !== undefined) {
    const who = {
      id: actor.id,
      name: actor.username,
      role: canWrite(app.db, repo, actor)
        ? ("admin" as const)
        : ("user" as const),
    };
    return ok(grantUrl(runtime, { app: record, env }, path, host, who));
  }
  if (record.access === "private") return err("unauthorized");
  const base = new URL(runtime.urlFor(record, env));
  if (host !== undefined) base.hostname = host.replace(/:\d+$/, "");
  return ok(`${base.origin}${path === "/" ? "" : path}`);
}

/** Deploy an environment again at its current commit. */
export async function redeployEnv(
  app: App,
  actor: User | undefined,
  repo: Repo,
  env: string,
): Promise<
  Result<Run | undefined, AccessError | EnvError | "nothing_to_deploy">
> {
  const writer = requireWriter(app, actor, repo);
  if (!writer.ok) return writer;
  const record = getAppByRepo(app.db, repo.id);
  if (!record) return err("not_found");
  if (!isEnvName(env)) return err("no_such_env");
  const runtime = appsRuntime(app);
  if (runtime === undefined) return err("no_runtime");
  const commit = await commitFor(app, repo, env);
  if (commit === undefined) return err("nothing_to_deploy");
  return ok(
    runtime.requestDeploy(
      record,
      repo,
      env,
      commit,
      "redeploy",
      writer.value.id,
    ),
  );
}

/** Stop an environment's process, keeping its data. A redeploy brings it back. */
export async function stopEnv(
  app: App,
  actor: User | undefined,
  repo: Repo,
  env: string,
): Promise<Result<void, AccessError | EnvError>> {
  const writer = requireWriter(app, actor, repo);
  if (!writer.ok) return writer;
  const record = getAppByRepo(app.db, repo.id);
  if (!record) return err("not_found");
  if (!isEnvName(env)) return err("no_such_env");
  const runtime = appsRuntime(app);
  if (runtime === undefined) return err("no_runtime");
  await runtime.stopEnv(record, env);
  app.bus.append({
    kind: "app.stopped",
    repoId: repo.id,
    actorId: writer.value.id,
    payload: { env },
  });
  return ok();
}

async function commitFor(
  app: App,
  repo: Repo,
  env: EnvName,
): Promise<string | undefined> {
  const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
  if (env === "production")
    return resolveOid(dir, `refs/heads/${repo.defaultBranch}`);
  const pull = getPull(app.db, repo.id, Number(env.slice(5)));
  if (!pull || pull.state !== "open") return undefined;
  const ref = pull.crossRepo
    ? `refs/pull/${pull.number}/head`
    : `refs/heads/${pull.headBranch}`;
  return (await resolveOid(dir, ref)) ?? (pull.headOid || undefined);
}

export { previewEnv };
