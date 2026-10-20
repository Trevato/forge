/**
 * Migrate: bring a repository here for good. A mirror keeps answering to
 * its origin; a migration does not. It is a one-time clone of the whole
 * history — every branch, every tag — into a native repository that is
 * yours from the first second: no `origin_id`, no write-through, nothing
 * that reaches back. After it, the forge is where the repository lives.
 *
 * The source is one of two things. A repository on an origin you have
 * connected is read with that origin's credential, and the credential
 * reaches git the one way `origins/credentials.ts` allows — a header in the
 * environment, scoped to the origin's host — never argv, never the URL. A
 * pasted URL is cloned anonymously: public repositories only.
 *
 * The clone runs as a job (`origins/jobs.ts`, the mirror's registry), so a
 * page can watch it. With a crew asked for, the same job then puts the
 * agent on the crew, makes the repository an app, and tells the crew one
 * thing: make it run here, adapting rather than rewriting.
 */

import { NOT_A_MEMBER } from "../core/roles.ts";
import { requireVerified } from "./verify.ts";
import type { App } from "../app.ts";
import { getAgentByName } from "../core/agents.ts";
import { storageStale } from "../core/storage.ts";
import { getOriginFor } from "../core/origins.ts";
import { getRepoById, type Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { runGitCapture } from "../git/env.ts";
import { isSafeRef } from "../git/guard.ts";
import { repoDir } from "../git/repos.ts";
import { type Resolve, vetHost } from "../kernel/outbound.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { providerForOrigin } from "../origins/credential.ts";
import { redact, safeRemoteUrl, secretsIn } from "../origins/credentials.ts";
import { MIRROR_REFSPECS, snapshotRefs } from "../origins/git-mirror.ts";
import {
  advance,
  createJob,
  getJob,
  runningJob,
  type MirrorJob,
} from "../origins/jobs.ts";
import { requireUser } from "./access.ts";
import { enableApp } from "./apps.ts";
import { addToCrew } from "./crew.ts";
import {
  createRepo,
  deleteRepo,
  updateRepoSettings,
  type CreateRepoActionError,
} from "./repos.ts";
import { tell, toldWords } from "./tell.ts";
import { remoteGitEnv } from "../git/remote-env.ts";

/** The whole clone — the HEAD probe and the fetch — gets this long. */
export const MIGRATE_TIMEOUT_MS = 120_000;

/** The transports a migration will speak. Anything else is refused. */
const ALLOWED_PROTOCOL = "https:http:git";

export type MigrateSource =
  | { readonly originId: string; readonly fullName: string }
  | { readonly url: string };

export interface MigrateInput {
  readonly source: MigrateSource;
  /** The actor, or an org they can write to. */
  readonly owner?: string;
  /** Defaults to the source's own name. */
  readonly name?: string;
  /** @default "private" */
  readonly visibility?: "public" | "private";
  /** Put an agent on it: the crew makes it run here. */
  readonly crew?: { readonly agent: string; readonly autonomous: boolean };
  /** Name → addresses, for the private-address check. Tests inject it. */
  readonly resolve?: Resolve;
}

export interface MigrateStarted {
  /** The new repository — empty until the job has fetched into it. */
  readonly repo: Repo;
  readonly job: MirrorJob;
}

export type MigrateError =
  | CreateRepoActionError
  | "unverified"
  | "invalid_url"
  | "private_host"
  | "no_such_origin"
  | "unreachable"
  | "no_such_agent";

/** What the clone reads from, resolved: where, and how to authenticate. */
interface Resolved {
  readonly url: string;
  /** Shown to people and kept on the job: the URL, or `owner/name`. */
  readonly label: string;
  readonly originId: string;
  readonly name: string;
  readonly description: string;
  readonly authEnv: () => Promise<Record<string, string>>;
}

/**
 * Start a migration. Everything a person can get wrong — the URL, the
 * name, the owner, the agent — is refused here, before anything exists;
 * what is left for the job is the network.
 */
export async function migrateRepo(
  app: App,
  actor: User | undefined,
  input: MigrateInput,
): Promise<Result<MigrateStarted, MigrateError | "unverified">> {
  const user = requireUser(actor);
  if (!user.ok) return user;
  const proven = requireVerified(app, user.value);
  if (!proven.ok) return proven;

  const source = await resolveSource(app, user.value, input.source, input.resolve);
  if (!source.ok) return source;
  if (input.crew !== undefined && !getAgentByName(app.db, input.crew.agent))
    return err("no_such_agent");

  // A double-click joins the migration already under way rather than
  // failing the second one on the name the first just took.
  const running = runningJob(
    source.value.originId,
    source.value.label,
    "migrate",
    user.value.id,
  );
  if (running?.repo !== undefined)
    return ok({ repo: running.repo, job: running });

  const name = (input.name ?? "").trim() || source.value.name;
  const created = await createRepo(app, user.value, {
    name,
    visibility: input.visibility ?? "private",
    description: source.value.description,
    ...(input.owner === undefined || input.owner === ""
      ? {}
      : { owner: input.owner }),
  });
  if (!created.ok) return created;
  const repo = created.value;

  const job = createJob(source.value.originId, source.value.label, {
    kind: "migrate",
    actorId: user.value.id,
  });
  advance(job.id, { stage: "creating", repo });
  void runMigration(app, user.value, repo, source.value, input.crew, job.id);
  return ok({ repo, job: getJob(job.id) ?? job });
}

/**
 * A migration job as the person who started it may see it. The id is
 * unguessable, but unguessable is not an access check: anyone else's job,
 * and any mirror job, is `not_found`.
 */
export function migrationJobFor(
  actor: User | undefined,
  jobId: string,
): Result<MirrorJob, "unauthorized" | "not_found"> {
  const user = requireUser(actor);
  if (!user.ok) return user;
  const job = getJob(jobId);
  if (
    job === undefined ||
    job.kind !== "migrate" ||
    job.actorId !== user.value.id
  )
    return err("not_found");
  return ok(job);
}

/** A refusal in words a person can act on. */
export function migrateMessage(error: MigrateError, limit = "at the repositories limit"): string {
  switch (error) {
    case "invalid_url":
      return "That is not a URL this forge will clone from. Paste an https:// (or http://, git://) address of a public repository, with no password in it.";
    case "private_host":
      return "That address is inside the network, not a public repository. An admin may bring it here; connect the host as an origin instead.";
    case "no_such_origin":
      return "That origin is not one you have connected, or it has no such repository.";
    case "unreachable":
      return "The origin could not be reached. Try again, or reconnect it under Settings → Origins.";
    case "no_such_agent":
      return "That agent is not on this forge.";
    case "name_taken":
      return "That owner already has a repository by that name. Pick another name.";
    case "invalid_name":
      return "Names start with a letter or digit; no spaces, no .git.";
    case "git_init_failed":
      return "The repository could not be initialised on disk.";
    case "forbidden_owner":
      return "You cannot create repositories for that owner.";
    case "unauthorized":
      return "Sign in first.";
    case "unverified":
      return "Verify your email first: follow the link we sent, or ask for another under Settings.";
    case "refused":
      return "New accounts cannot create repositories yet.";
    case "not_member":
      return `Not made: ${NOT_A_MEMBER}.`;
    case "repository_limit":
      return `Not made: ${limit}.`;
    case "storage_limit":
      return "Not made: this account is at the forge's storage limit. Delete a repository or app data first.";
  }
}

/**
 * A pasted address, made into one git may be handed — or `undefined`.
 * `github.com/a/b` gets the `https://` a person meant; `file://`, `ssh://`,
 * `ext::`, a `-`-leading string and a URL carrying a password never reach
 * git at all (invariant 8). The transports themselves are pinned again at
 * the fetch, with `GIT_ALLOW_PROTOCOL`, in case a redirect has other ideas.
 */
export function migrateUrl(raw: string): string | undefined {
  let text = raw.trim();
  if (text === "" || text.startsWith("-") || /[\s\x00-\x1f]/.test(text))
    return undefined;
  if (!text.includes("://") && /^[A-Za-z0-9.-]+\.[A-Za-z]{2,}\//.test(text))
    text = `https://${text}`;
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return undefined;
  }
  if (parsed.hostname === "") return undefined;
  if (parsed.username !== "" || parsed.password !== "") return undefined;
  if (parsed.protocol === "git:") return parsed.toString();
  return safeRemoteUrl(parsed.toString());
}

/**
 * Whether a hostname names something inside the network rather than on the
 * open internet: loopback, link-local, the private ranges, `.localhost`,
 * and the unspecified address. Names are not resolved here: that is
 * `vetHost`'s job, which runs after this literal check.
 */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h === "0.0.0.0")
    return true;
  const v4 = privateV4(h);
  if (v4 !== undefined) return v4;
  const groups = expandV6(h);
  if (groups === undefined) return false;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;
  if (groups.every((g) => g === 0)) return true; // ::
  if ([g0, g1, g2, g3, g4].every((g) => g === 0)) {
    if (g5 === 0 && g6 === 0 && g7 === 1) return true; // ::1
    // ::ffff:a.b.c.d — an IPv4 address in IPv6 clothes: judge the IPv4.
    if (g5 === 0xffff)
      return (
        privateV4(
          `${(g6! >> 8) & 0xff}.${g6! & 0xff}.${(g7! >> 8) & 0xff}.${g7! & 0xff}`,
        ) === true
      );
  }
  if ((g0! & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g0! & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
  return false;
}

/** Dotted IPv4 → inside the network?; `undefined` when not IPv4 at all. */
function privateV4(h: string): boolean | undefined {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4 === null) return undefined;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  return (
    a === 127 ||
    a === 10 ||
    a === 0 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

/**
 * An IPv6 literal as eight 16-bit groups, `::` expanded and a trailing
 * dotted IPv4 folded in; `undefined` when the text is not IPv6.
 */
function expandV6(h: string): number[] | undefined {
  if (!h.includes(":")) return undefined;
  let text = h;
  const dotted = /:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(text);
  if (dotted !== null) {
    const p = dotted[1]!.split(".").map(Number);
    if (p.some((n) => n > 255)) return undefined;
    text =
      text.slice(0, dotted.index) +
      `:${((p[0]! << 8) | p[1]!).toString(16)}:${((p[2]! << 8) | p[3]!).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const parse = (part: string): number[] | undefined => {
    if (part === "") return [];
    const out: number[] = [];
    for (const g of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return undefined;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = parse(halves[0]!);
  const tail = halves.length === 2 ? parse(halves[1]!) : [];
  if (head === undefined || tail === undefined) return undefined;
  if (halves.length === 1) return head.length === 8 ? head : undefined;
  const fill = 8 - head.length - tail.length;
  if (fill < 1) return undefined;
  return [...head, ...new Array<number>(fill).fill(0), ...tail];
}

/** The last path segment without `.git`: what the repository was called. */
function nameFromUrl(url: string): string {
  const path = new URL(url).pathname.replace(/\/+$/, "");
  const last = path.split("/").pop() ?? "";
  return last.replace(/\.git$/i, "");
}

async function resolveSource(
  app: App,
  user: User,
  source: MigrateSource,
  resolve?: Resolve,
): Promise<Result<Resolved, MigrateError>> {
  if ("url" in source) {
    const url = migrateUrl(source.url);
    if (url === undefined) return err("invalid_url");
    // A host inside the network — this machine, the cluster, a private
    // range — is not a public repository, and a pasted address must not
    // become a way to knock on it. An admin may; a forge run for one person
    // may say so once (`FORGE_MIGRATE_PRIVATE_HOSTS=1`).
    const mayReachPrivate =
      user.isAdmin || app.config.migrateFromPrivateHosts === true;
    if (!mayReachPrivate) {
      const hostname = new URL(url).hostname;
      if (isPrivateHost(hostname)) return err("private_host");
      // A public-looking name can resolve inside the network.
      const vetted = await vetHost(hostname, resolve ? { resolve } : {});
      if (!vetted.ok && vetted.error === "refused") return err("private_host");
    }
    return ok({
      url,
      label: url,
      originId: "",
      name: nameFromUrl(url),
      description: "",
      authEnv: () => Promise.resolve({}),
    });
  }
  const origin = getOriginFor(app.db, user.id, source.originId);
  if (!origin) return err("no_such_origin");
  const provider = providerForOrigin(app, origin);
  if (!provider.ok) return err("unreachable");
  const remote = await provider.value.getRepo(source.fullName);
  if (!remote.ok)
    return err(
      remote.error.error === "not_found" ? "no_such_origin" : "unreachable",
    );
  const url = safeRemoteUrl(remote.value.cloneUrl);
  if (url === undefined) return err("unreachable");
  return ok({
    url,
    label: remote.value.fullName,
    originId: origin.id,
    name: remote.value.name,
    description: remote.value.description,
    // Only the header: the origin's credential reaches this one git
    // invocation scoped to its host, and the repository never learns it.
    authEnv: () => provider.value.gitAuthEnv(url),
  });
}

/** The job itself. Nothing here throws out: a detached promise must not. */
async function runMigration(
  app: App,
  user: User,
  repo: Repo,
  source: Resolved,
  crew: MigrateInput["crew"],
  jobId: string,
): Promise<void> {
  const fail = async (error: string): Promise<void> => {
    // An empty repository nobody asked for is clutter, and it holds the
    // name a retry wants: a clone that did not happen leaves nothing.
    await deleteRepo(app, user, repo);
    advance(jobId, { stage: "failed", detail: "", error });
  };
  try {
    advance(jobId, { stage: "fetching", detail: "every branch and tag" });
    const cloned = await cloneInto(app, repo, source);
    if (!cloned.ok) return await fail(cloned.error);
    storageStale(app, repo.ownerId);
    let current = getRepoById(app.db, repo.id) ?? repo;

    // The source's default branch is kept; a source that never said which
    // keeps the forge's own, or the branch it plainly meant.
    const branches = [...cloned.value.refs.keys()]
      .filter((ref) => ref.startsWith("refs/heads/"))
      .map((ref) => ref.slice("refs/heads/".length));
    const wanted = [
      cloned.value.head,
      current.defaultBranch,
      "master",
      ...branches.sort(),
    ].find((b) => b !== undefined && branches.includes(b));
    if (wanted !== undefined && wanted !== current.defaultBranch) {
      const moved = await updateRepoSettings(app, user, current, {
        defaultBranch: wanted,
      });
      if (moved.ok) current = moved.value;
    }

    // The history arrived without a push, so nothing downstream heard it.
    // One event, shaped like a push, says so — the feed, webhooks and the
    // default branch's check see what landed.
    if (cloned.value.refs.size > 0) {
      app.bus.append({
        kind: "push",
        repoId: current.id,
        actorId: user.id,
        payload: {
          updates: [...cloned.value.refs].map(([ref, newOid]) => ({
            ref,
            oldOid: "0".repeat(40),
            newOid,
          })),
          via: "migrate",
          from: source.label,
        },
      });
    }

    const where = `${current.ownerName}/${current.name}`;
    let detail = `migrated as ${where} — ${plural(branches.length, "branch", "branches")}, ${plural(cloned.value.refs.size - branches.length, "tag")}`;
    if (crew !== undefined) {
      advance(jobId, { stage: "crew", detail: `putting ${crew.agent} on it` });
      detail += `. ${await putCrewOn(app, user, current, source, crew)}`;
    }
    advance(jobId, {
      stage: "done",
      detail,
      repo: getRepoById(app.db, current.id) ?? current,
    });
  } catch (error) {
    await fail(redact(String(error))).catch(() => undefined);
  }
}

interface Cloned {
  readonly head: string | undefined;
  readonly refs: ReadonlyMap<string, string>;
}

/**
 * Fetch every branch and tag into the bare repository. Not `--mirror` (it
 * drags every `refs/pull/*` in and marks the remote as one to push-mirror
 * to) and not `--single-branch`: the explicit branch-and-tag refspecs are
 * exactly the history, nothing more. No remote is configured — the URL is
 * used once and forgotten, which is what makes this a migration and not a
 * mirror.
 */
async function cloneInto(
  app: App,
  repo: Repo,
  source: Resolved,
): Promise<Result<Cloned, string>> {
  const deadline = Date.now() + MIGRATE_TIMEOUT_MS;
  const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
  const authEnv = await source.authEnv();
  const env = remoteGitEnv(authEnv, undefined, ALLOWED_PROTOCOL);
  const said = (stderr: string, fallback: string): string =>
    redact(stderr.trim(), ...secretsIn(authEnv))
      .split("\n")
      .find((line) => line.trim() !== "") ?? fallback;
  const remaining = (): number => Math.max(1_000, deadline - Date.now());

  const probe = await runGitCapture(
    ["ls-remote", "--symref", "--", source.url, "HEAD"],
    { cwd: dir, env, timeoutMs: remaining() },
  );
  if (probe.code !== 0)
    return err(
      `The source could not be read: ${said(probe.stderr, "no reason given")}`,
    );
  const symref = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(probe.stdout)?.[1];
  const head = symref !== undefined && isSafeRef(symref) ? symref : undefined;

  const fetched = await runGitCapture(
    [
      "fetch",
      "--no-write-fetch-head",
      "--no-recurse-submodules",
      "--quiet",
      "--",
      source.url,
      ...MIRROR_REFSPECS,
    ],
    { cwd: dir, env, timeoutMs: remaining() },
  );
  if (fetched.code !== 0) {
    const late = Date.now() >= deadline;
    return err(
      late
        ? `The clone did not finish within ${MIGRATE_TIMEOUT_MS / 1000} seconds.`
        : `The clone failed: ${said(fetched.stderr, "no reason given")}`,
    );
  }
  const { refs } = await snapshotRefs(dir);
  return ok({ head, refs });
}

/**
 * The crew half: the agent joins, the repository becomes an app, autonomy
 * is set when asked, and the crew is told the one thing it is there for.
 * Each step says what happened; one that fails does not undo the clone.
 */
async function putCrewOn(
  app: App,
  user: User,
  repo: Repo,
  source: Resolved,
  crew: NonNullable<MigrateInput["crew"]>,
): Promise<string> {
  const said: string[] = [];
  const added = addToCrew(app, user, repo, crew.agent);
  if (!added.ok) return `${crew.agent} could not join the crew.`;
  const made = enableApp(app, user, repo, {});
  if (!made.ok)
    said.push(
      made.error === "slug_taken"
        ? "Another app already answers to its name, so it is not an app yet — rename it and turn it on under Settings."
        : "It could not be made an app.",
    );
  if (crew.autonomous) {
    const set = await updateRepoSettings(app, user, repo, {
      autonomy: "autonomous",
      autonomyBy: user.id,
    });
    if (!set.ok) said.push("Autonomy could not be turned on.");
  }
  const told = await tell(app, user, repo, importerBrief(repo, source.label));
  said.unshift(told.ok ? toldWords(told.value) : "The crew could not be told.");
  return said.join(" ");
}

/**
 * What the crew is told about a migrated repository. The golden path's
 * contract (docs/APPS.md), from the other side: someone else's project,
 * made to run here with the smallest diff that does it.
 */
export function importerBrief(repo: Repo, from: string): string {
  return `Make ${repo.name} run here

${repo.name} was migrated to this forge from ${from} — every branch and tag, its history intact. It is someone else's project. Make it run here as an app without changing what it does.

Adapt, don't rewrite:

- Read before you write: the language, how it starts today, how it reads its port and configuration, where it keeps state, how it installs and tests.
- Declare it in \`forge.json\` at the root, under \`app\`: \`run\` (the command that starts it) and \`health\` (a path that answers once it is up); \`install\` and \`test\` when the repository has them.
- Listen on the port in \`PORT\`, on \`HOST\`. A hard-coded port becomes the fallback, not the rule.
- Keep every piece of persistent state — a SQLite file, uploads, a data folder — under \`FORGE_APP_DATA\`. It must start on an empty one and restart on a full one.
- The forge runs processes, not containers: no Dockerfile, no compose file. Read those only to learn what the app needs. A second service it cannot do without (a database server, a queue) becomes the app's embedded or file mode where it has one.
- Its data: if it used a database server elsewhere (Postgres, MySQL), say in the pull where the rows are and what it uses now. Leave the old database untouched. Move the app's state under \`FORGE_APP_DATA\` (bun:sqlite, or the app's embedded mode). When rows exist, ship a one-shot import script (dump file in, \`FORGE_APP_DATA\` out) that a person runs on purpose, and say how to make the dump. Never commit or read at boot a connection string to the old database.
- Keep its routes, pages and behaviour as they were. The smallest diff a person can review quickly — no refactors, no restyling, no dependency churn beyond what running here needs.
- Write down what could not fit — a service the forge cannot run, a secret you do not have — plainly, in the pull, so a person can decide. An honest blocker beats a broken deploy.

Done means the pull's preview starts, answers its \`health\` path, and does what the original did.`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
