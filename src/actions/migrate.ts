/**
 * Migrate: bring a repository here for good. A mirror keeps answering to
 * its origin; a migration does not. It is a one-time clone of the whole
 * history — every branch, every tag — into a native repository that is
 * yours from the first second: no `origin_id`, no write-through, nothing
 * that reaches back. After it, the forge is where the repository lives.
 * What it keeps of the source is where it came from, as links and nothing
 * more (`core/provenance.ts`, #3293): the address, and what that forks when
 * its host says — the header's "Migrated from … · fork of …" line.
 *
 * The source is one of two things. A repository on an origin you have
 * connected is read with that origin's credential, and the credential
 * reaches git the one way `origins/credentials.ts` allows — a header in the
 * environment, scoped to the origin's host — never argv, never the URL. A
 * pasted URL is cloned anonymously: public repositories only.
 *
 * From a connected origin the conversations come too (`origins/carry.ts`):
 * every issue with its comments and labels, each milestone (title,
 * description, due date, state) and the open pull requests as
 * pulls here, on the branches the clone brought — each opening with a link
 * back to the original; one from a fork has its head under
 * `refs/pull/<n>/head` and waits for a writer to approve it to run. A
 * pasted URL brings the history alone.
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
import { setMirrorTarget } from "../core/migrate_mirror.ts";
import { getOriginFor } from "../core/origins.ts";
import { recordProvenance } from "../core/provenance.ts";
import { getRepoById, type Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { runGitCapture } from "../git/env.ts";
import { isSafeRef } from "../git/guard.ts";
import { repoDir } from "../git/repos.ts";
import { isTrustedHost } from "../origins/trusted-hosts.ts";
import { type Resolve, vetHost } from "../kernel/outbound.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { carryConversations, plural } from "../origins/carry.ts";
import { providerForOrigin } from "../origins/credential.ts";
import { redact, safeRemoteUrl, secretsIn } from "../origins/credentials.ts";
import { MIRROR_REFSPECS, snapshotRefs } from "../origins/git-mirror.ts";
import { lookupLineage } from "../origins/lineage.ts";
import {
  localTips,
  pickWorkBranch,
  remoteTips,
  type Who,
} from "../origins/work-branch.ts";
import {
  advance,
  createJob,
  getJob,
  runningJob,
  type MirrorJob,
} from "../origins/jobs.ts";
import type { Provider } from "../origins/types.ts";
import { requireUser } from "./access.ts";
import { REPO_INIT_FAILED, REPO_NAME_RULES } from "./repo_words.ts";
import { enableApp } from "./apps.ts";
import { addToCrew } from "./crew.ts";
import {
  createRepo,
  deleteRepo,
  updateRepoSettings,
  type CreateRepoActionError,
} from "./repos.ts";
import { tell, toldWords } from "./tell.ts";
import { putFollow, upstreamUrl } from "../core/upstream_follow.ts";
import { pinFor, remoteGitEnv, type Pin } from "../git/remote-env.ts";
import { AT_REPOSITORY_LIMIT, NO_SUCH_AGENT } from "./crew_limit_words.ts";

/** The whole clone — the HEAD probe and the fetch — gets this long. */
export const MIGRATE_TIMEOUT_MS = 120_000;

export type MigrateSource =
  | { readonly originId: string; readonly fullName: string }
  | { readonly url: string };

export type AfterMigration = "leave" | "archive" | "mirror";

/** The form's word, or `leave` for anything else. */
export function afterChoice(raw: string): AfterMigration {
  return raw === "archive" || raw === "mirror" ? raw : "leave";
}

export interface MigrateInput {
  readonly source: MigrateSource;
  /** The actor, or an org they can write to. */
  readonly owner?: string;
  /** Defaults to the source's own name. */
  readonly name?: string;
  /** @default "private" */
  readonly visibility?: "public" | "private";
  /**
   * The branch the app lives on — the default branch here and the one the
   * crew is pointed at. Left out, the branch with the person's newest
   * commits (`origins/work-branch.ts`), else the source's default.
   */
  readonly branch?: string;
  /** Put an agent on it: the crew makes it run here. */
  readonly crew?: { readonly agent: string; readonly autonomous: boolean };
  /**
   * What happens to the source afterwards, when it is on a connected
   * origin: left alone (the default), archived there, or kept as a
   * read-only mirror this forge pushes to after every landing.
   * @default "leave"
   */
  readonly after?: AfterMigration;
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
  | "invalid_branch"
  | "no_such_agent"
  | "not_a_builder";

/** What the clone reads from, resolved: where, and how to authenticate. */
interface Resolved {
  readonly url: string;
  /** Shown to people and kept on the job: the URL, or `owner/name`. */
  readonly label: string;
  readonly originId: string;
  readonly name: string;
  readonly description: string;
  /** Where a person reads the source: the address the line links (#3293). */
  readonly webUrl: string;
  /**
   * What the source forks, nearest first, as its origin reported it — or
   * `undefined` for a pasted address, whose host is asked after the clone.
   */
  readonly parents: readonly string[] | undefined;
  /**
   * Private where it came from: its name and owner are not this forge's to
   * publish, so its trail starts hidden whatever it is migrated as.
   */
  readonly private: boolean;
  readonly authEnv: () => Promise<Record<string, string>>;
  /** The address `vetHost` passed, when the host was vetted: git must dial it, not look the name up again. */
  readonly pin?: Pin;
  /** A connected origin's adapter: what issues and pulls are read through. */
  readonly provider?: Provider;
  /** The person, as the source's commits may name them. */
  readonly who: Who;
  /** The source's own parent on its host, when it is a fork. */
  readonly parentUrl?: string;
}

/** Why the work branch is the one it is: said in the job and the brief. */
type WorkReason = "picked" | "newest" | "default";

interface WorkBranch {
  readonly name: string;
  readonly reason: WorkReason;
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
  if (input.crew !== undefined) {
    const asked = getAgentByName(app.db, input.crew.agent);
    if (!asked) return err("no_such_agent");
    if (!asked.roles.includes("builder")) return err("not_a_builder");
  }
  const branch = (input.branch ?? "").trim();
  if (branch !== "" && !isSafeRef(branch)) return err("invalid_branch");

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
  void runMigration(app, user.value, repo, source.value, {
    branch: branch === "" ? undefined : branch,
    crew: input.crew,
    after: input.after ?? "leave",
    jobId: job.id,
    lookup: input.resolve,
  });
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
export function migrateMessage(error: MigrateError, limit = AT_REPOSITORY_LIMIT): string {
  switch (error) {
    case "invalid_url":
      return "That is not a URL this forge will clone from. Paste an https:// (or http://) address of a public repository, with no password in it. A git:// address is not supported: use its https:// address.";
    case "private_host":
      return "That address is inside the network, not a public repository. An admin may bring it here; connect the host as an origin instead.";
    case "no_such_origin":
      return "That origin is not one you have connected, or it has no such repository.";
    case "unreachable":
      return "The origin could not be reached. Try again, or reconnect it under Settings → Connected accounts.";
    case "no_such_agent":
      return NO_SUCH_AGENT;
    case "not_a_builder":
      return "That agent is not a builder, so it cannot take a migration. Pick a builder, or change its roles under Settings → Crew.";
    case "invalid_branch":
      return "That is not a branch name git would take.";
    case "name_taken":
      return "That owner already has a repository by that name. Pick another name.";
    case "invalid_name":
      return REPO_NAME_RULES;
    case "git_init_failed":
      return REPO_INIT_FAILED;
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

export async function resolveSource(
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
      user.isAdmin ||
      app.config.migrateFromPrivateHosts === true ||
      isTrustedHost(new URL(url).hostname);
    let pin: Pin | undefined;
    if (!mayReachPrivate) {
      const hostname = new URL(url).hostname;
      if (isPrivateHost(hostname)) return err("private_host");
      // A public-looking name can resolve inside the network.
      const vetted = await vetHost(hostname, resolve ? { resolve } : {});
      if (!vetted.ok && vetted.error === "refused") return err("private_host");
      if (!vetted.ok) return err("unreachable");
      pin = pinFor(url, vetted.value[0]!);
    }
    return ok({
      ...(pin ? { pin } : {}),
      url,
      label: url,
      originId: "",
      name: nameFromUrl(url),
      description: "",
      webUrl: url,
      parents: undefined,
      // Cloned without logging in, so anyone could already read it.
      private: false,
      authEnv: () => Promise.resolve({}),
      who: { logins: [user.username], emails: [user.email] },
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
    webUrl: remote.value.htmlUrl,
    parents: [
      ...(remote.value.parent === null ? [] : [remote.value.parent]),
      ...(remote.value.root === undefined ? [] : [remote.value.root]),
    ],
    private: remote.value.private,
    // Only the header: the origin's credential reaches this one git
    // invocation scoped to its host, and the repository never learns it.
    authEnv: () => provider.value.gitAuthEnv(url),
    provider: provider.value,
    who: { logins: [origin.login, user.username], emails: [user.email] },
    ...(remote.value.parent === null
      ? {}
      : { parentUrl: `${origin.webUrl.replace(/\/+$/, "")}/${remote.value.parent}` }),
  });
}

/** What git runs a migration fetch with: the vetted address pinned when there is one. */
export function fetchEnv(
  source: Pick<Resolved, "pin">,
  authEnv: Record<string, string>,
): Record<string, string> {
  return remoteGitEnv(authEnv, source.pin);
}

/** The job itself. Nothing here throws out: a detached promise must not. */
async function runMigration(
  app: App,
  user: User,
  repo: Repo,
  source: Resolved,
  asked: {
    readonly branch: string | undefined;
    readonly crew: MigrateInput["crew"];
    readonly after: AfterMigration;
    readonly jobId: string;
    /** How a pasted address's host is looked up for its lineage (#3293). */
    readonly lookup: Resolve | undefined;
  },
): Promise<void> {
  const { crew, jobId, lookup } = asked;
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
    let current = getRepoById(app.db, repo.id) ?? repo;

    // The conversations, when an origin can be asked for them. A refusal
    // part-way keeps what arrived and says so; the history is the move.
    let conversations = "";
    const refs = cloned.value.refs;
    if (source.provider !== undefined) {
      advance(jobId, { stage: "issues", detail: "reading issues" });
      const carried = await carryConversations({
        db: app.db,
        provider: source.provider,
        fullName: source.label,
        repoId: current.id,
        actorId: user.id,
        report: (stage, detail) => advance(jobId, { stage, detail }),
      });
      // A fork's head is fetched where the forge keeps pull heads, not as
      // a branch: no push event runs it, and no branch the clone brought
      // is overwritten. Its pull waits for a writer to approve it to run.
      await fetchForkHeads(
        app,
        current,
        source,
        carried.forkPulls.map((p) => p.number),
      );
      const forks = carried.forkPulls.length;
      conversations = `; ${plural(carried.issues, "issue")}, ${plural(carried.pulls, "open pull request")}${forks === 0 ? "" : ` (${forks} from forks, waiting for your approval to run here)`}, ${plural(carried.comments, "comment")}${carried.milestones === 0 ? "" : `, ${plural(carried.milestones, "milestone")}`}${carried.error === "" ? "" : ` (the origin stopped part-way: ${redact(carried.error)})`}`;
      app.bus.append({
        kind: "repo.imported",
        repoId: current.id,
        actorId: user.id,
        payload: {
          fullName: source.label,
          issues: carried.issues,
          pulls: carried.pulls,
          comments: carried.comments,
          via: "migrate",
        },
      });
    }
    storageStale(app, repo.ownerId);

    // The default branch here is the work branch: the one picked, else
    // the one with the person's newest commits, else the source's default
    // — and a source that never said which keeps the forge's own, or the
    // branch it plainly meant.
    const branches = [...refs.keys()]
      .filter((ref) => ref.startsWith("refs/heads/"))
      .map((ref) => ref.slice("refs/heads/".length));
    const fallback = [
      cloned.value.head,
      current.defaultBranch,
      "master",
      ...branches.sort(),
    ].find((b) => b !== undefined && branches.includes(b));
    const work = await workBranch(app, current, source, asked.branch, branches, fallback);
    if (work !== undefined && work.name !== current.defaultBranch) {
      const moved = await updateRepoSettings(app, user, current, {
        defaultBranch: work.name,
      });
      if (moved.ok) current = moved.value;
    }

    // The history arrived without a push, so nothing downstream heard it.
    // One event, shaped like a push, says so — the feed, webhooks and the
    // default branch's check see what landed.
    if (refs.size > 0) {
      app.bus.append({
        kind: "push",
        repoId: current.id,
        actorId: user.id,
        payload: {
          updates: [...refs].map(([ref, newOid]) => ({
            ref,
            oldOid: "0".repeat(40),
            newOid,
          })),
          via: "migrate",
          from: source.label,
        },
      });
    }

    // Where it came from, kept as links and nothing more (#3293): a pasted
    // address's host is asked once, anonymously, what it forks. A private
    // source's trail is kept hidden until its owner turns it on.
    recordProvenance(app.db, current.id, {
      shown: !source.private,
      url: source.webUrl,
      parents:
        source.parents ??
        (await lookupLineage(source.url, lookup ? { resolve: lookup } : {})),
    });

    // The source becomes the upstream this repository follows (#3442): on
    // when the crew runs it on its own, off — but filled in — otherwise.
    // Only an https or http source can be followed.
    const followUrl = upstreamUrl(source.url);
    if (followUrl !== undefined)
      putFollow(app.db, {
        repoId: current.id,
        url: followUrl,
        branch: cloned.value.head ?? work?.name ?? current.defaultBranch,
        enabled: crew?.autonomous === true,
        byId: user.id,
        originId: source.originId,
        ...(source.parentUrl === undefined ? {} : { parentUrl: source.parentUrl }),
      });

    const where = `${current.ownerName}/${current.name}`;
    let detail = `migrated as ${where} — ${plural(branches.length, "branch", "branches")}, ${plural(refs.size - branches.length, "tag")}${conversations}`;
    if (work !== undefined)
      detail += `. Working on ${work.name}, ${reasonWords(work.reason)}${asked.branch !== undefined && work.reason !== "picked" ? ` (${asked.branch} did not come with the clone)` : ""}`;
    detail += await afterWords(app, user, current, source, asked.after, refs);
    if (crew !== undefined) {
      advance(jobId, { stage: "crew", detail: `putting ${crew.agent} on it` });
      detail += `. ${await putCrewOn(app, user, current, source, crew, work)}`;
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

/**
 * The source, after the move, as the person chose. Only a repository read
 * through a connected origin has a source to touch. Archiving needs admin
 * there; without it the migration stands and the words say so.
 */
async function afterWords(
  app: App,
  user: User,
  repo: Repo,
  source: Resolved,
  after: AfterMigration,
  refs: ReadonlyMap<string, string>,
): Promise<string> {
  if (after === "leave" || source.provider === undefined) return "";
  if (after === "archive") {
    const done = await source.provider.archiveRepo(source.label);
    if (done.ok) return `. ${source.label} is archived on its origin`;
    return done.error.error === "forbidden" ||
      done.error.error === "unauthorized" ||
      done.error.error === "not_found"
      ? `. ${source.label} was not archived: the connected account lacks admin rights there. Archive it on the origin yourself`
      : `. ${source.label} was not archived: the origin could not be reached`;
  }
  const tips: Record<string, string> = {};
  for (const [ref, oid] of refs) if (ref.startsWith("refs/heads/")) tips[ref] = oid;
  setMirrorTarget(app.db, {
    repoId: repo.id,
    originId: source.originId,
    fullName: source.label,
    cloneUrl: source.url,
    tips,
  });
  return `. ${source.label} stays as a read-only mirror: every landing here is pushed to it`;
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
  const env = fetchEnv(source, authEnv);
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
 * Which branch the app lives on. A picked branch that arrived wins; else
 * the newest branch tip that is the person's — by the clone's authors, and
 * by the origin's account logins when there is an origin to ask — else the
 * fallback.
 */
async function workBranch(
  app: App,
  repo: Repo,
  source: Resolved,
  picked: string | undefined,
  branches: readonly string[],
  fallback: string | undefined,
): Promise<WorkBranch | undefined> {
  if (picked !== undefined && branches.includes(picked))
    return { name: picked, reason: "picked" };
  const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
  let tips = await localTips(dir, source.who);
  if (source.provider !== undefined) {
    const remote = await remoteTips(source.provider, source.label, source.who);
    const theirs = new Set(
      (remote ?? []).filter((t) => t.mine).map((t) => `${t.name}\0${t.oid}`),
    );
    tips = tips.map((t) =>
      theirs.has(`${t.name}\0${t.oid}`) ? { ...t, mine: true } : t,
    );
  }
  const name = pickWorkBranch(tips, fallback);
  if (name === undefined) return undefined;
  return {
    name,
    reason: tips.some((t) => t.mine && t.name === name) ? "newest" : "default",
  };
}

function reasonWords(reason: WorkReason): string {
  switch (reason) {
    case "picked":
      return "the branch picked";
    case "newest":
      return "the branch with your newest commits";
    case "default":
      return "the source's default branch";
  }
}

/**
 * Bring the heads of pulls opened from forks: the origin serves each as
 * `refs/pull/<n>/head` (GitHub and Forgejo alike), and it lands under the
 * same name here — the forge's own namespace for pull heads, which a push
 * cannot write and the clone never brings. One fetch; a fetch that fails
 * leaves those pulls showing the head the origin reported, still waiting.
 */
async function fetchForkHeads(
  app: App,
  repo: Repo,
  source: Resolved,
  numbers: readonly number[],
): Promise<void> {
  if (numbers.length === 0) return;
  const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
  const authEnv = await source.authEnv();
  await runGitCapture(
    [
      "fetch",
      "--no-write-fetch-head",
      "--no-recurse-submodules",
      "--quiet",
      "--",
      source.url,
      ...numbers.map((n) => `+refs/pull/${n}/head:refs/pull/${n}/head`),
    ],
    {
      cwd: dir,
      env: fetchEnv(source, authEnv),
      timeoutMs: MIGRATE_TIMEOUT_MS,
    },
  );
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
  work: WorkBranch | undefined,
): Promise<string> {
  const said: string[] = [];
  const added = addToCrew(app, user, repo, crew.agent, "builder");
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
  const told = await tell(app, user, repo, importerBrief(repo, source.label, work));
  said.unshift(told.ok ? toldWords(told.value) : "The crew could not be told.");
  return said.join(" ");
}

/**
 * What the crew is told about a migrated repository. The golden path's
 * contract (docs/APPS.md), from the other side: someone else's project,
 * made to run here with the smallest diff that does it.
 */
export function importerBrief(
  repo: Repo,
  from: string,
  work?: WorkBranch,
): string {
  const branch = work?.name ?? repo.defaultBranch;
  const why =
    work?.reason === "picked"
      ? "the branch the person who migrated it picked"
      : work?.reason === "newest"
        ? "the branch with the newest commits of the person who migrated it"
        : "the source's default branch";
  return `Make ${repo.name} run here

${repo.name} was migrated to this forge from ${from} — every branch and tag, its history intact. It is someone else's project. Make it run here as an app without changing what it does.

The app is on the branch \`${branch}\` — ${why}, and the default branch here. Start from \`${branch}\` and open your pull against it; the other branches are history, not the app.

Adapt, don't rewrite:

- Read before you write: the language, how it starts today, how it reads its port and configuration, where it keeps state, how it installs and tests.
- Declare it in \`forge.json\` at the root, under \`app\`: \`run\` (the command that starts it) and \`health\` (a path that answers once it is up); \`install\` and \`test\` when the repository has them.
- Listen on the port in \`PORT\`, on \`HOST\`. A hard-coded port becomes the fallback, not the rule.
- Keep every piece of persistent state — a SQLite file, uploads, a data folder — under \`FORGE_APP_DATA\`. It must start on an empty one and restart on a full one.
- The forge runs processes, not containers: no Dockerfile, no compose file. Read those only to learn what the app needs. A second service it cannot do without (a database server, a queue) becomes the app's embedded or file mode where it has one.
- Its data: if it used a database server elsewhere (Postgres, MySQL), say in the pull where the rows are and what it uses now. Leave the old database untouched. Move the app's state under \`FORGE_APP_DATA\` (bun:sqlite, or the app's embedded mode). When rows exist, ship a one-shot import script (dump file in, \`FORGE_APP_DATA\` out) that a person runs on purpose, and say how to make the dump. Files and uploads are copied by a person with \`bun scripts/copy-app-files.ts <source-dir>\`, which compares a SHA-256 manifest at both ends; the app only reads them from \`FORGE_APP_DATA\`. Never commit or read at boot a connection string to the old database.
- Keep its routes, pages and behaviour as they were. The smallest diff a person can review quickly — no refactors, no restyling, no dependency churn beyond what running here needs.
- Write down what could not fit — a service the forge cannot run, a secret you do not have — plainly, in the pull, so a person can decide. An honest blocker beats a broken deploy.

Done means the pull's preview starts, answers its \`health\` path, and does what the original did.`;
}

