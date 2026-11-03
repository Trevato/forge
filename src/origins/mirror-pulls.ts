/**
 * Mirror pulls in (#9011): a repository that pushes to a read-only mirror
 * (`mirror-out.ts`) takes the pulls people open *there* as pulls here. The
 * mirror stays a plain copy: nothing is pushed to it but trunk's own refs —
 * here we only read its open pulls, fetch each head into
 * `refs/heads/mirror-pull/<n>`, and leave one comment on the mirror pull
 * saying where it went.
 *
 * A pull brought in names its author (`origin_author`) and links back
 * (`origin_html_url`), so it is a guest pull (`guest.ts`): no secrets, no
 * crew, until a person approves it — unless its author is a trusted source
 * on the mirror's host, which `pull_source` records.
 *
 * It runs by event (the mirror's webhook, `hook.ts`) and by a sweep for
 * anything missed. Both key on the mirror pull's URL, and one run at a time
 * per repository, so the two never make two copies of one pull.
 */

import type { App } from "../app.ts";
import { openPull } from "../actions/pulls.ts";
import { getMirrorTarget, type MirrorTarget } from "../core/migrate_mirror.ts";
import { getOriginById } from "../core/origins.ts";
import { getPull, retargetPull } from "../core/pulls.ts";
import { getRepoById, type Repo } from "../core/repos.ts";
import { cleanAccount, cleanHost, recordPullSource } from "../core/trusted_sources.ts";
import { getUserById } from "../core/users.ts";
import { cappedFetch } from "../git/capped-fetch.ts";
import { resolveOid, writeRef } from "../git/merge.ts";
import { REMOTE_PROTOCOLS } from "../git/remote-env.ts";
import { repoDir } from "../git/repos.ts";
import { createLog } from "../kernel/log.ts";
import { providerForOrigin } from "./credential.ts";
import { forgetGuestApproval } from "./guest.ts";
import { vettedEnv } from "./git-mirror.ts";
import { hookSecret, hookUrl } from "./hook-secret.ts";
import { verifySignature } from "../core/webhooks.ts";
import type { Provider, RemoteIssue } from "./types.ts";

const log = createLog("mirror-pulls");

/** How often every mirror is swept for a pull its webhook did not announce. */
export const MIRROR_PULLS_EVERY_MS = 5 * 60_000;
/** Pages of open pulls read per sweep; a mirror with more is read next time. */
const MAX_PAGES = 5;
const FETCH_TIMEOUT_MS = 120_000;
/** The most a mirror pull's head may bring that trunk does not already hold. */
export const MAX_FETCH_BYTES = 200 * 1024 * 1024;
const MAX_TITLE = 200;
const MAX_BODY = 60_000;

/** The branch here that carries mirror pull `n`'s head. */
export const mirrorPullBranch = (n: number): string => `mirror-pull/${n}`;

/** Fetch the mirror's `refs/pull/<n>/head` into `ref`; the oid it landed at. */
export type FetchHead = (
  app: App,
  repo: Repo,
  target: MirrorTarget,
  provider: Provider,
  number: number,
  ref: string,
) => Promise<string | undefined>;

export interface MirrorPullsDeps {
  readonly provider?: Provider;
  readonly fetchHead?: FetchHead;
}

export interface MirrorPullsReport {
  /** Local numbers of the pulls opened this run. */
  readonly opened: number[];
  /** Local numbers of the pulls whose head moved on the mirror. */
  readonly moved: number[];
  readonly error: string;
}

const running = new Map<string, Promise<MirrorPullsReport>>();

/**
 * Bring `repo`'s mirror's open pulls in. A second caller while one runs
 * waits for it and then runs again, so an event heard mid-run is not lost.
 */
export async function bringMirrorPulls(
  app: App,
  repo: Repo,
  deps: MirrorPullsDeps = {},
): Promise<MirrorPullsReport> {
  const before = running.get(repo.id);
  const run = (before ?? Promise.resolve())
    .catch(() => undefined)
    .then(() => bringOnce(app, repo, deps));
  running.set(repo.id, run);
  try {
    return await run;
  } finally {
    if (running.get(repo.id) === run) running.delete(repo.id);
  }
}

async function bringOnce(app: App, repo: Repo, deps: MirrorPullsDeps): Promise<MirrorPullsReport> {
  const opened: number[] = [];
  const moved: number[] = [];
  const done = (error = ""): MirrorPullsReport => ({ opened, moved, error });
  const target = getMirrorTarget(app.db, repo.id);
  if (!target) return done();
  const origin = getOriginById(app.db, target.originId);
  if (!origin) return done("the mirror's origin was disconnected");
  const opener = getUserById(app.db, origin.userId);
  if (!opener) return done("the mirror's origin has no account here");
  let provider = deps.provider;
  if (provider === undefined) {
    const made = providerForOrigin(app, origin);
    if (!made.ok) return done("the mirror's origin needs to be reconnected");
    provider = made.value;
  }
  const host = cleanHost(origin.webUrl) ?? "";
  const fetchHead = deps.fetchHead ?? fetchFromMirror;
  const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);

  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const listed = await provider.listIssues(target.fullName, {
      kind: "pull",
      state: "open",
      ...(cursor === undefined ? {} : { cursor }),
    });
    if (!listed.ok) return done(`the mirror's pulls could not be read: ${listed.error.message}`);
    for (const remote of listed.value.items) {
      if (remote.pull === undefined || !isMirrorPullUrl(remote.htmlUrl)) continue;
      try {
        await bringOne(app, repo, { target, provider, fetchHead, dir, host, opener, opened, moved }, remote);
      } catch (error) {
        log.error("mirror pull not brought", { repo: repo.id, number: remote.number, error: String(error) });
      }
    }
    if (listed.value.next === null) break;
    cursor = listed.value.next;
  }
  return done();
}

interface Run {
  readonly target: MirrorTarget;
  readonly provider: Provider;
  readonly fetchHead: FetchHead;
  readonly dir: string;
  readonly host: string;
  readonly opener: NonNullable<ReturnType<typeof getUserById>>;
  readonly opened: number[];
  readonly moved: number[];
}

/** A link back is an http(s) URL and nothing else, because a page renders it. */
const isMirrorPullUrl = (url: string): boolean => {
  const parsed = URL.parse(url);
  return parsed !== null && (parsed.protocol === "https:" || parsed.protocol === "http:") && url.length <= 500;
};

/** The number of the pull here that a mirror pull became, by its URL. */
export function broughtFrom(app: App, repoId: string, url: string): number | undefined {
  return (
    app.db
      .query<{ number: number }, [string, string]>(
        "SELECT number FROM issue WHERE repo_id = ?1 AND kind = 'pull' AND origin_html_url = ?2",
      )
      .get(repoId, url)?.number ?? undefined
  );
}

async function bringOne(app: App, repo: Repo, run: Run, remote: RemoteIssue): Promise<void> {
  const number = remote.number;
  const branch = mirrorPullBranch(number);
  const known = broughtFrom(app, repo.id, remote.htmlUrl);
  if (known !== undefined) {
    // Already here: follow a head that moved, while the pull is open here.
    const pull = getPull(app.db, repo.id, known);
    if (!pull || pull.state !== "open" || pull.mergedAt !== null) return;
    if (pull.headOid === remote.pull?.headOid) return;
    const oid = await run.fetchHead(app, repo, run.target, run.provider, number, `refs/heads/${branch}`);
    if (oid === undefined || oid === pull.headOid) return;
    // Nobody here pushed this head: an approval given to the last one does
    // not carry over to it.
    forgetGuestApproval(app.db, pull.id);
    retargetPull(app.db, pull.id, branch, oid);
    await writeRef(run.dir, `refs/pull/${pull.number}/head`, oid);
    run.moved.push(pull.number);
    return;
  }

  const oid = await run.fetchHead(app, repo, run.target, run.provider, number, `refs/heads/${branch}`);
  if (oid === undefined) return;
  // A run that raced this one may have brought it while we fetched.
  if (broughtFrom(app, repo.id, remote.htmlUrl) !== undefined) return;
  const base = remote.pull?.baseBranch ?? "";
  const baseBranch =
    base !== "" && (await resolveOid(run.dir, `refs/heads/${base}`)) !== undefined ? base : repo.defaultBranch;
  const author = oneLine(remote.author, 100) || "someone";
  const title = oneLine(remote.title, MAX_TITLE) || `${run.target.fullName}#${number}`;
  const body = `From @${author} on ${remote.htmlUrl}\n\n${remote.body}`.slice(0, MAX_BODY);
  // A guest from its first row: the origin is written with the pull, never after.
  const made = await openPull(app, run.opener, repo, {
    title,
    body,
    baseBranch,
    headBranch: branch,
    origin: { author, htmlUrl: remote.htmlUrl },
  });
  if (!made.ok) {
    log.warn("mirror pull not opened", { repo: repo.id, number, error: String(made.error) });
    return;
  }
  const pull = made.value;
  const account = cleanAccount(author);
  if (run.host !== "" && account !== undefined)
    recordPullSource(app.db, { pullId: pull.id, host: run.host, account, via: [] });
  run.opened.push(pull.number);

  const here = pullUrl(app, repo, pull.number);
  const said = await run.provider.createComment(
    run.target.fullName,
    number,
    `This pull continues on ${here ?? `${repo.ownerName}/${repo.name}#${pull.number}`}, where it is reviewed and landed. This repository is a mirror; what lands there comes back here.`,
  );
  if (!said.ok) log.warn("mirror pull comment failed", { repo: repo.id, number, error: said.error.message });
}

function pullUrl(app: App, repo: Repo, number: number): string | undefined {
  const base = app.config.url;
  if (base === undefined || !/^https?:\/\//i.test(base)) return undefined;
  return `${base.replace(/\/+$/, "")}/${encodeURIComponent(repo.ownerName)}/${encodeURIComponent(repo.name)}/pulls/${number}`;
}

const oneLine = (text: string, max: number): string =>
  text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max);

/**
 * The real fetch: the mirror's clone URL, vetted and pinned, with the
 * origin's credential, and capped in bytes (`capped-fetch.ts`).
 */
const fetchFromMirror: FetchHead = async (app, repo, target, provider, number, ref) => {
  const authEnv = await provider.gitAuthEnv(target.cloneUrl);
  const pinned = await vettedEnv(target.cloneUrl, authEnv, REMOTE_PROTOCOLS);
  if (!pinned.ok) return undefined;
  const fetched = await cappedFetch({
    dir: repoDir(app.reposRoot, repo.ownerName, repo.name),
    url: target.cloneUrl,
    from: `refs/pull/${number}/head`,
    ref,
    maxBytes: MAX_FETCH_BYTES,
    timeoutMs: FETCH_TIMEOUT_MS,
    env: pinned.value,
  });
  if (!fetched.ok) log.warn("mirror pull head not fetched", { repo: repo.id, number, reason: fetched.reason });
  return fetched.ok ? fetched.oid : undefined;
};

/**
 * A delivery from the read-only mirror this repository pushes to: someone
 * opened or moved a pull there. Believed for "look again" only — the mirror's
 * open pulls are read and brought in (below), not answered from
 * the body. The origin is not kept waiting for the fetch.
 */
export async function receiveMirrorHook(
  app: App,
  repo: Repo,
  raw: string,
  signature: string | null,
  deps: MirrorPullsDeps = {},
): Promise<boolean> {
  if (signature === null || !getMirrorTarget(app.db, repo.id)) return false;
  if (!(await verifySignature(hookSecret(app, repo), raw, signature))) return false;
  void bringMirrorPulls(app, repo, deps).catch((error: unknown) =>
    app.log.error("mirror pulls failed", { repoId: repo.id, error: String(error) }),
  );
  return true;
}

/**
 * Ask the mirror this repository pushes to for its pull events, once.
 * Best effort: the sweep still finds what a missing hook would have said.
 */
export async function watchMirror(app: App, repo: Repo, provider: Provider): Promise<void> {
  const target = getMirrorTarget(app.db, repo.id);
  const url = hookUrl(app, repo);
  if (!target || url === undefined || provider.watch === undefined) return;
  await provider.watch(target.fullName, { url, secret: hookSecret(app, repo) });
}

/** Every repository that pushes to a mirror. */
function mirroredRepos(app: App): Repo[] {
  return app.db
    .query<{ repo_id: string }, []>("SELECT repo_id FROM migrate_mirror")
    .all()
    .map((r) => getRepoById(app.db, r.repo_id))
    .filter((r): r is Repo => r !== undefined);
}

/** One sweep over every mirror. Never throws. */
export async function sweepMirrorPulls(app: App, deps: MirrorPullsDeps = {}): Promise<void> {
  for (const repo of mirroredRepos(app)) {
    try {
      const report = await bringMirrorPulls(app, repo, deps);
      if (report.error !== "") log.warn("mirror pulls", { repo: repo.id, error: report.error });
    } catch (error) {
      log.error("mirror pulls sweep failed", { repo: repo.id, error: String(error) });
    }
  }
}

/** Ask each mirror for its webhook, once per boot. Never throws. */
async function watchAll(app: App): Promise<void> {
  for (const repo of mirroredRepos(app)) {
    const target = getMirrorTarget(app.db, repo.id);
    const origin = target === undefined ? undefined : getOriginById(app.db, target.originId);
    const provider = origin === undefined ? undefined : providerForOrigin(app, origin);
    if (!provider?.ok) continue;
    try {
      await watchMirror(app, repo, provider.value);
    } catch (error) {
      log.warn("mirror webhook not set", { repo: repo.id, error: String(error) });
    }
  }
}

/** The sweep on a clock, once on boot. Returns the stop. */
export function startMirrorPulls(app: App): () => void {
  let busy = false;
  let first = true;
  const tick = (): void => {
    if (busy) return;
    busy = true;
    const watching = first ? watchAll(app) : Promise.resolve();
    first = false;
    void watching.then(() => sweepMirrorPulls(app)).finally(() => {
      busy = false;
    });
  };
  const timer = setInterval(tick, MIRROR_PULLS_EVERY_MS);
  tick();
  return () => clearInterval(timer);
}
