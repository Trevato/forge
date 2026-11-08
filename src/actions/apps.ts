/**
 * App actions: make a repository an app, make a new app from nothing,
 * change how it is served, take it down, and redeploy or stop an
 * environment. Admin over the repository turns an app on and off and
 * changes its settings; a writer may redeploy or stop; anyone who can read
 * the repository may look at it and open its environments.
 */

import { pullDir } from "../core/pulls.ts";
import { getIssue } from "../core/issues.ts";
import { mayView } from "../core/sealed.ts";
import { deriveAppName } from "../web/pages/apps-name.ts";
import { REPO_INIT_FAILED, REPO_NAME_RULES } from "./repo_words.ts";
import { NO_SUCH_AGENT } from "./crew_limit_words.ts";
import { requireVerified } from "./verify.ts";
import { requireAppRoom } from "./app_limit.ts";
import type { App } from "../app.ts";
import { checkWord, type CheckWord } from "../apps/check_word.ts";
import { openPulls } from "../apps/door_pulls.ts";
import { goldenPath, goldenPathLine } from "../apps/golden_path.ts";
import { appVitals, type AppVitals } from "../apps/vitals.ts";
import { appsRuntime, envsFor, type EnvStatus } from "../apps/runtime.ts";
import { grantUrl, originFor, sideForViewer, sideReader } from "../apps/proxy.ts";
import { plainLine } from "../apps/side.ts";
import { scaffoldFiles } from "../apps/scaffold.ts";
import {
  envBuild,
  isEnvName,
  previewEnv,
  type EnvName,
  type PreviewData,
} from "../apps/data.ts";
import {
  createApp as insertApp,
  deleteApp as removeApp,
  getAppByRepo,
  getAppBySlug,
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
import { canAdmin, canEnterApp, canWrite, getRepo, type Repo } from "../core/repos.ts";
import type { Run } from "../core/runs.ts";
import { type User } from "../core/users.ts";
import { resolveOid } from "../git/merge.ts";
import { previewCommit } from "../git/combined.ts";
import { repoDir } from "../git/repos.ts";
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
  deleteRepo,
  resolveOwner,
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
): Result<AppRecord, "not_found" | CreateAppError | "unverified" | "app_limit"> {
  const admin = requireRepoAdmin(app, actor, repo);
  if (!admin.ok) return admin;
  const proven = requireVerified(app, admin.value);
  if (!proven.ok) return proven;
  const room = requireAppRoom(app, admin.value, repo.ownerId);
  if (!room.ok) return room;
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
  | "no_such_agent"
  | "not_a_builder"
  | "app_limit";

/**
 * The golden path's first step, as one call: a repository with a working
 * app in it, an app record so production starts, and — when asked — the
 * first issue assigned to an agent on the crew.
 */
export async function newApp(
  app: App,
  actor: User | undefined,
  input: NewAppInput,
  /** Told how long each stretch took (`repo`, `scaffold`, `app`, `issue`), for Server-Timing. */
  onPhase: (name: string, ms: number) => void = () => {},
): Promise<Result<NewAppResult, NewAppError | "unverified">> {
  const user = requireUser(actor);
  if (!user.ok) return user;
  const proven = requireVerified(app, user.value);
  if (!proven.ok) return proven;
  const agent =
    input.agent === undefined || input.agent === ""
      ? undefined
      : getAgentByName(app.db, input.agent);
  if (input.agent && !agent) return err("no_such_agent");
  if (agent && !agent.roles.includes("builder")) return err("not_a_builder");

  // Refuse at the limit before a repository exists to take back.
  // The owner is resolved with the actor's rights, as createRepo does, so
  // the count of an account they may not create under is never told.
  const ownerId = resolveOwner(app, user.value, input.owner ?? "");
  if (ownerId === undefined) return err("forbidden_owner");
  const room = requireAppRoom(app, user.value, ownerId);
  if (!room.ok) return room;

  // Refuse a taken slug before anything exists to take back.
  // A name the owner already has stays `name_taken`, which createRepo says.
  if (
    getAppBySlug(app.db, slugFor(input.name)) &&
    !getRepo(app.db, input.owner || user.value.username, input.name)
  )
    return err("slug_taken");

  let mark = performance.now();
  const lap = (name: string): void => {
    const now = performance.now();
    onPhase(name, now - mark);
    mark = now;
  };
  const repo = await createRepo(app, user.value, {
    name: input.name,
    visibility: input.visibility ?? "private",
    description: input.description ?? "",
    ...(input.owner === undefined ? {} : { owner: input.owner }),
  });
  lap("repo");
  if (!repo.ok) return repo;
  const committed = await commitToBranch(app, user.value, repo.value, {
    message: `Start ${input.name}`,
    files: scaffoldFiles({
      name: input.name,
      description: input.description ?? "",
    }),
  });
  lap("scaffold");
  if (!committed.ok) {
    await deleteRepo(app, user.value, repo.value);
    return err("scaffold_failed");
  }
  const record = enableApp(app, user.value, repo.value, {});
  lap("app");
  // The creator administers the repository they just made, so `not_found`
  // here can only mean the row vanished under us — a failed scaffold.
  if (!record.ok) {
    await deleteRepo(app, user.value, repo.value);
    return err(record.error === "not_found" ? "scaffold_failed" : record.error);
  }

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
      const agents = roster.ok ? roster.value.filter((a) => a.roles.includes("builder")) : [];
      if (agents.length > 0) {
        const result = await plan(
          {
            name: input.name,
            description,
            agents: agents.map((a) => ({
              name: a.user.username,
              brief: a.brief,
            })),
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
    addCrew(app.db, repo.value.id, chosen.user.id, user.value.id, "builder");
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
  lap("issue");
  return ok({
    repo: repo.value,
    app: record.value,
    ...(issue === undefined ? {} : { issue }),
    ...(picked === undefined ? {} : { plan: picked }),
  });
}

/** How many suffixed names (`x-2`, `x-3`, …) a derived name will try before giving up. */
const MAX_NAME_ATTEMPTS = 30;

/** Nothing in the sentence a slug can carry: punctuation only, or a script `[a-z0-9]` cannot. */
export const NO_NAME_ERROR =
  "That doesn't leave anything to make a name from — type one below.";

/** Error code → the words a person is shown, for the web form and the terminal alike. */
export const NEW_APP_ERRORS: Record<string, string> = {
  no_name: NO_NAME_ERROR,
  name_taken: "That owner already has a repository by that name.",
  invalid_name: REPO_NAME_RULES,
  git_init_failed: REPO_INIT_FAILED,
  invalid_slug:
    "That name makes no usable hostname — start it with a letter or digit.",
  slug_taken:
    "Another app already answers to that hostname. Pick another name.",
  already_app: "That repository is already an app.",
  scaffold_failed: "The starter app could not be committed.",
  no_such_agent: NO_SUCH_AGENT,
  not_a_builder: "That agent is not a builder, so it cannot be handed a new app. Pick a builder.",
};

export interface NewAppFromSentenceInput extends Omit<NewAppInput, "name"> {
  /** The sentence the app is named from; it is also the first issue's description unless `description` is given. */
  sentence: string;
}

export type NewAppFromSentence =
  | ({ readonly ok: true; readonly name: string } & NewAppResult)
  | { readonly ok: false; readonly code: string };

/**
 * `newApp` with the name derived from a sentence: the derived name first,
 * then `name-2`, `name-3`, … while the owner already has it, up to
 * MAX_NAME_ATTEMPTS. A sentence with nothing to name from is `no_name`.
 */
export async function newAppFromSentence(
  app: App,
  actor: User | undefined,
  { sentence, description, ...rest }: NewAppFromSentenceInput,
  onPhase?: (name: string, ms: number) => void,
): Promise<NewAppFromSentence> {
  const base = deriveAppName(sentence);
  if (base === undefined) return { ok: false, code: "no_name" };
  let name = base;
  let made = await newApp(app, actor, { ...rest, description: description ?? sentence, name }, onPhase);
  for (let n = 2; !made.ok && made.error === "name_taken" && n <= MAX_NAME_ATTEMPTS; n++) {
    name = `${base}-${n}`;
    made = await newApp(app, actor, { ...rest, description: description ?? sentence, name }, onPhase);
  }
  return made.ok ? { ok: true, name, ...made.value } : { ok: false, code: made.error };
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
  const port = app.config.sshPort;
  return port === undefined || port <= 0 ? { reason: "no_listener" } : {};
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
    environments: envsFor(app, actor, record),
    serving: runtime !== undefined,
  });
}

/**
 * An app's visitors and speed, for those who administer its repository: the
 * same gate as the settings card, so every door shows them to the same people.
 */
export function appVisitors(app: App, actor: User | undefined, repo: Repo): AppVitals | undefined {
  if (!canAdmin(app.db, repo, actor)) return undefined;
  const record = getAppByRepo(app.db, repo.id);
  return record === undefined ? undefined : appVitals(app.db, record.id);
}

/** The golden path's pace line, for whoever may read the app's repository; `""` until there is one. */
export function appPace(app: App, actor: User | undefined, repo: Repo): string {
  if (!requireReader(app, actor, repo).ok) return "";
  const record = getAppByRepo(app.db, repo.id);
  return record === undefined ? "" : goldenPathLine(goldenPath(app.db, record));
}

export interface AppPullLine {
  readonly number: number;
  readonly title: string;
  readonly check: CheckWord;
  /** The pull's preview address, or `undefined` when the forge serves none. */
  readonly preview: string | undefined;
}

/**
 * The app's open pulls with their check word and preview address, for a
 * signed-in viewer who may read the repository; a guest gets none.
 */
export function appPullLines(app: App, actor: User | undefined, repo: Repo): AppPullLine[] {
  if (actor === undefined) return [];
  const record = getAppByRepo(app.db, repo.id);
  if (record === undefined) return [];
  const runtime = appsRuntime(app);
  return openPulls(app.db, repo, actor).map((p) => ({
    number: p.number,
    title: p.title,
    check: checkWord(p.run, p.headOid),
    preview: runtime?.urlFor(record, previewEnv(p.number)),
  }));
}

export interface AppPreview {
  readonly number: number;
  readonly title: string;
  /** The preview's environment, as the studio's previews list reads it. */
  readonly env: EnvStatus;
}

/**
 * The open pulls that have a preview environment, newest first, each with
 * that environment — the studio's previews list (`studio/previews.ts`) for a
 * door that cannot draw a page. One `status()` read for every row, never one
 * per pull. `undefined` when the actor may not read the repository or it is
 * no app, so "no previews" is only ever said to someone who may see them.
 */
export function appPreviews(app: App, actor: User | undefined, repo: Repo): AppPreview[] | undefined {
  if (!requireReader(app, actor, repo).ok) return undefined;
  const record = getAppByRepo(app.db, repo.id);
  if (record === undefined) return undefined;
  const envs = new Map(envsFor(app, actor, record).map((e) => [e.env, e] as const));
  return openPulls(app.db, repo, actor, 50).flatMap((p) => {
    const env = envs.get(previewEnv(p.number));
    return env === undefined ? [] : [{ number: p.number, title: p.title, env }];
  });
}

/**
 * The other side of the app for its production terminal, gated as the pill
 * is (an active reader of the repository; a guest gets none): production's
 * address, then the newest open preview when there is one.
 */
export function appSideLines(app: App, actor: User | undefined, repo: Repo): string[] {
  const record = getAppByRepo(app.db, repo.id);
  const runtime = appsRuntime(app);
  if (record === undefined || runtime === undefined) return [];
  if (sideReader(app.db, record, actor) === undefined) return [];
  const preview = sideForViewer(runtime, record, "production", actor);
  return [
    `Production: ${runtime.urlFor(record, "production")}`,
    ...(preview === null ? [] : [`${preview.label} ${preview.url}`]),
  ].map(plainLine);
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
  const record = getAppByRepo(app.db, repo.id);
  // A person a private app names may enter it without reading the
  // repository (#752); everyone else needs to read it first.
  const named =
    record !== undefined &&
    record.access === "private" &&
    actor !== undefined &&
    canEnterApp(app.db, repo, record, actor);
  if (!named) {
    const reader = requireReader(app, actor, repo);
    if (!reader.ok) return reader;
  }
  if (!record) return err("not_found");
  if (!isEnvName(env)) return err("no_such_env");
  // A private app is for its writers, its crew and the people it names;
  // anyone else who can read the repository gets the answer a stranger
  // gets, and nobody is told why.
  if (record.access === "private" && actor !== undefined)
    if (!canEnterApp(app.db, repo, record, actor))
      return err("not_found");
  // A sealed pull's preview is its report's: for those who may see it, and
  // through a grant only (`core/sealed.ts`).
  const sealedNumber = /^pull-(\d+)$/.exec(env)?.[1];
  const sealed =
    sealedNumber === undefined
      ? undefined
      : getIssue(app.db, repo.id, Number(sealedNumber));
  if (sealed?.sealed === true && !mayView(app.db, repo, sealed, actor))
    return err("not_found");
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
  const origin = originFor(runtime, { app: record, env }, host);
  return ok(`${origin}${path === "/" ? "" : path}`);
}

/** Deploy an environment again at its current commit. */
export async function redeployEnv(
  app: App,
  actor: User | undefined,
  repo: Repo,
  env: string,
): Promise<
  Result<Run | undefined, AccessError | EnvError | "nothing_to_deploy" | "unverified">
> {
  const writer = requireWriter(app, actor, repo);
  if (!writer.ok) return writer;
  const proven = requireVerified(app, writer.value);
  if (!proven.ok) return proven;
  const record = getAppByRepo(app.db, repo.id);
  if (!record) return err("not_found");
  if (!isEnvName(env)) return err("no_such_env");
  const runtime = appsRuntime(app);
  if (runtime === undefined) return err("no_runtime");
  const commit = await commitFor(app, repo, record, env);
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
  record: AppRecord,
  env: EnvName,
): Promise<string | undefined> {
  const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
  if (env === "production")
    return resolveOid(dir, `refs/heads/${repo.defaultBranch}`);
  // A build preview names its commit only by its short sha: the commit it
  // serves is the one the runtime holds for it, while it is held.
  if (envBuild(env) !== undefined)
    return appsRuntime(app)?.envStatus(record, env)?.commitOid || undefined;
  const pull = getPull(app.db, repo.id, Number(env.slice(5)));
  if (!pull || pull.state !== "open") return undefined;
  const at = await pullDir(app.db, app.reposRoot, repo, pull);
  // A fork's pull combined on our side previews the combined build (#9012).
  return previewCommit(at, pull);
}

export { previewEnv };
