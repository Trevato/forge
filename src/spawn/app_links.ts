/**
 * The apps a spawn sends down stay linked to where they came from. Each app in a child is the
 * parent's repository with its whole history (the same commit ids), and this is the link that
 * keeps it that way: an ordinary followed upstream (`core/upstream_follow.ts`, the `upstream`
 * tool), pointing at the parent forge's repository, taking its new commits by default and
 * never rewriting the child's own. One follow mechanism, not a second one for spawned apps.
 *
 * `parent.json` is the record both sides share, as it already is for the heartbeat and the
 * model credit. Its `apps` list holds one entry per app the child was given:
 *
 *   the parent writes   url, branch, mode, anchor, token?, offeredAt   (an offer)
 *   the child writes    appliedAt | severedAt | refused                (its answer)
 *
 * Born with its apps, a child is linked at once (`linkAppAtBirth`, the parent has the child's
 * database open). A child spawned before this existed is offered the link by its parent
 * (`reconcileAppLinks`, which only offers); the child applies it (`applyAppLinks`) when its
 * repository's history still contains `anchor`, the parent repository's first commit (the one
 * the child's copy was made from), so an unrelated repository that happens to share a name is never linked, and only
 * while its owner has not severed it.
 *
 * A private parent repository is read with a follow token (`core/proposal_token.ts`, read-only,
 * one repository, ended by the parent or by the child's sever); the child seals it with its own
 * key and the plain copy leaves `parent.json` the moment it does.
 */

import { existsSync } from "node:fs";
import { rename } from "node:fs/promises";
import { join } from "node:path";
import type { App } from "../app.ts";
import { childDirOf, childNamed, listChildren, type Child } from "../actions/spawn.ts";
import {
  getOrg,
  listTeamMembers,
  listTeams,
  OWNERS_TEAM,
} from "../core/orgs.ts";
import {
  followTokenCount,
  mintProposalToken,
  parseOrigin,
  revokeFollowTokens,
} from "../core/proposal_token.ts";
import { canWrite, getRepo, getRepoById, listReposOwnedBy, type Repo } from "../core/repos.ts";
import {
  followAad,
  getFollow,
  isFollowTaking,
  putFollow,
  setFollowTaking,
  type FollowTaking,
} from "../core/upstream_follow.ts";
import { getUserById, getUserByName, type User } from "../core/users.ts";
import { runGit } from "../git/env.ts";
import { isSafeOid } from "../git/guard.ts";
import { resolveOid } from "../git/merge.ts";
import { repoDir } from "../git/repos.ts";
import { seal } from "../kernel/secret.ts";
import { DEFAULT_MODE, originOf } from "./chain.ts";

/** One app in `parent.json`, as the two sides write it. */
export interface AppEntry {
  /** `<org>/<name>` in the child. */
  readonly repo: string;
  /** `<owner>/<name>` in the parent. */
  readonly upstream: string;
  readonly url?: string;
  readonly branch?: string;
  readonly mode?: FollowTaking;
  /** A commit of the parent's repository the child's copy must hold: its first. */
  readonly anchor?: string;
  /** More of its commits: the copy is the same repository when it holds any of them or `anchor`. */
  readonly anchors?: readonly string[];
  /** The read credential for a private parent repository, until the child seals it. */
  readonly token?: string;
  readonly offeredAt?: string;
  readonly appliedAt?: string;
  readonly severedAt?: string;
  /** Why the child did not link it: its history does not hold `anchor`, or its owner had set the repository up otherwise. */
  readonly refused?: "history" | "own" | "code";
  /** Why the child could not link it yet (one line, no path); the offer stands and is tried again. */
  readonly failed?: string;
}

const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const OID = /^[0-9a-f]{40,64}$/;
const iso = (v: unknown): string | undefined =>
  typeof v === "string" && v.length <= 40 && !Number.isNaN(Date.parse(v))
    ? v
    : undefined;

function readEntry(v: unknown): AppEntry | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const e = v as Record<string, unknown>;
  if (typeof e["repo"] !== "string" || !REPO.test(e["repo"])) return undefined;
  if (typeof e["upstream"] !== "string" || !REPO.test(e["upstream"]))
    return undefined;
  const url =
    typeof e["url"] === "string" &&
    originOf(e["url"]) !== "" &&
    e["url"].length <= 300
      ? e["url"]
      : undefined;
  const branch =
    typeof e["branch"] === "string" && e["branch"].length <= 200
      ? e["branch"]
      : undefined;
  const token =
    typeof e["token"] === "string" && /^[\x21-\x7e]{8,200}$/.test(e["token"])
      ? e["token"]
      : undefined;
  const refused =
    e["refused"] === "history" || e["refused"] === "own" || e["refused"] === "code"
      ? e["refused"]
      : undefined;
  const anchors = Array.isArray(e["anchors"])
    ? e["anchors"].filter((x): x is string => typeof x === "string" && OID.test(x)).slice(0, 16)
    : [];
  const failed =
    typeof e["failed"] === "string" && e["failed"] !== ""
      ? e["failed"].slice(0, 200)
      : undefined;
  return {
    repo: e["repo"],
    upstream: e["upstream"],
    ...(url === undefined ? {} : { url }),
    ...(branch === undefined ? {} : { branch }),
    ...(isFollowTaking(e["mode"]) ? { mode: e["mode"] } : {}),
    ...(typeof e["anchor"] === "string" && OID.test(e["anchor"])
      ? { anchor: e["anchor"] }
      : {}),
    ...(anchors.length === 0 ? {} : { anchors }),
    ...(token === undefined ? {} : { token }),
    ...(iso(e["offeredAt"]) === undefined
      ? {}
      : { offeredAt: iso(e["offeredAt"])! }),
    ...(iso(e["appliedAt"]) === undefined
      ? {}
      : { appliedAt: iso(e["appliedAt"])! }),
    ...(iso(e["severedAt"]) === undefined
      ? {}
      : { severedAt: iso(e["severedAt"])! }),
    ...(refused === undefined ? {} : { refused }),
    ...(failed === undefined ? {} : { failed }),
  };
}

const docPath = (dir: string): string => join(dir, "parent.json");

async function readDoc(
  dir: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    const doc = await Bun.file(docPath(dir)).json();
    return typeof doc === "object" && doc !== null && !Array.isArray(doc)
      ? (doc as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** The apps `parent.json` lists; entries that are not one are left out. */
export const entriesOf = (
  doc: Record<string, unknown> | undefined,
): AppEntry[] =>
  Array.isArray(doc?.["apps"])
    ? (doc!["apps"] as unknown[])
        .map(readEntry)
        .filter((e): e is AppEntry => e !== undefined)
    : [];

/** The document with `apps` replaced, everything else it holds kept; atomic, private to its owner. */
async function writeEntries(
  dir: string,
  doc: Record<string, unknown>,
  apps: readonly AppEntry[],
): Promise<void> {
  const path = docPath(dir);
  await Bun.write(`${path}.tmp`, JSON.stringify({ ...doc, apps }), {
    mode: 0o600,
  });
  await rename(`${path}.tmp`, path);
}

/** Change one entry of a child's `parent.json` (re-read just before, so a parallel writer's other entries stand). */
async function patchEntry(
  dir: string,
  upstream: string,
  change: (e: AppEntry) => AppEntry,
  add?: AppEntry,
): Promise<void> {
  const doc = await readDoc(dir);
  if (doc === undefined) return;
  const entries = entriesOf(doc);
  const at = entries.findIndex((e) => e.upstream === upstream);
  if (at < 0) {
    if (add !== undefined)
      await writeEntries(dir, doc, [...entries, change(add)]);
    return;
  }
  await writeEntries(
    dir,
    doc,
    entries.map((e, i) => (i === at ? change(e) : e)),
  );
}

/** The address of this forge a child follows its apps at. */
export const parentAddress = (app: App): string =>
  app.config.url ?? `http://${app.config.host ?? "localhost"}`;

/** A repository's git address on this forge. */
export const repoUrl = (app: App, upstream: string): string =>
  `${parentAddress(app).replace(/\/+$/, "")}/${upstream}.git`;

/**
 * Commits that prove a child's copy is this repository's: its first, and some spread through its
 * default branch's history. A copy made by a spawn holds all of them; an unrelated repository that
 * only shares the name holds none, since a commit id is a hash of its history; and a repository
 * rewritten since still shows the child's copy through any commit it kept. (A date would not do:
 * commit dates are the author's.) Empty when there are no commits.
 */
export async function anchorsOf(app: App, parent: Repo): Promise<string[]> {
  const dir = repoDir(app.reposRoot, parent.ownerName, parent.name);
  const ref = `refs/heads/${parent.defaultBranch}`;
  const roots = await runGit(["rev-list", "--max-parents=0", ref], { cwd: dir });
  const first = roots.ok ? roots.value.trim().split("\n").filter((l) => OID.test(l)) : [];
  const walked = await runGit(["rev-list", "--first-parent", "--max-count=2000", ref], { cwd: dir });
  const line = walked.ok ? walked.value.trim().split("\n").filter((l) => OID.test(l)) : [];
  const spread: string[] = [];
  for (let i = 0; i < ANCHORS_MAX && line.length > 0; i++) spread.push(line[Math.floor((i * line.length) / ANCHORS_MAX)]!);
  return [...new Set([...first.slice(-1), ...first, ...spread])].slice(0, ANCHORS_MAX + 4);
}

const ANCHORS_MAX = 8;

/** The person a follow token for `repo` is minted as: the spawner, when they may read it, else the repository's owner when that is a person. */
function mintingUser(
  app: App,
  parent: Repo,
  ownerId: string | undefined,
): User | undefined {
  const spawner =
    ownerId === undefined ? undefined : getUserById(app.db, ownerId);
  if (spawner !== undefined && spawner.kind === "user") return spawner;
  const owner = getUserById(app.db, parent.ownerId);
  return owner?.kind === "user" ? owner : undefined;
}

/** A read credential for a private parent repository, made for one child; undefined for a public one or when none can be made. */
function followToken(
  app: App,
  parent: Repo,
  child: { name: string; url: string; ownerId?: string | undefined },
): string | undefined {
  if (parent.visibility === "public") return undefined;
  const as = mintingUser(app, parent, child.ownerId);
  if (as === undefined) return undefined;
  // The origin is only a label on the token: the child's address when it is an https one.
  const label = parseOrigin(child.url) ?? `https://${child.name}.invalid/`;
  const minted = mintProposalToken(app.db, as.id, parent.id, {
    child: child.name,
    origin: label,
    readOnly: true,
  });
  return minted.ok ? minted.value.token : undefined;
}

export interface Offered {
  readonly offered: string[];
  readonly revoked: string[];
}

/** Why an app was not offered, by `<child>:<app>`, as the last pass found it; absent when it was or needs none. */
const notOffered = new Map<string, string>();

/** The forge's own code is followed as the forge's code (`forgeCode`), not as an app. */
const OWN_CODE = "forge";

/**
 * Offer a child the link to each app it was given that has none: written into its `parent.json`,
 * nothing else touched, and only for an app it was not offered, did not answer, or severed. Also
 * ends the follow tokens of an app the child severed. Idempotent; the child decides. An app it
 * cannot offer is not skipped quietly: the reason is kept (`notOffered`) for the list and the log.
 */
export async function offerAppLinks(app: App, child: Child): Promise<Offered> {
  const out: { offered: string[]; revoked: string[] } = { offered: [], revoked: [] };
  const skip = (ref: string, why: string | undefined): void => {
    if (why === undefined) notOffered.delete(`${child.name}:${ref}`);
    else notOffered.set(`${child.name}:${ref}`, why);
  };
  const dir = childDirOf(app, child.bodyId);
  const doc = await readDoc(dir);
  const org = typeof doc?.["org"] === "string" ? doc["org"] : undefined;
  if (doc === undefined || org === undefined) {
    for (const ref of child.apps) skip(ref, "the child's parent.json is missing or names no organisation");
    return out;
  }
  const entries = entriesOf(doc);
  const next: AppEntry[] = [...entries];
  let changed = false;
  for (const ref of child.apps) {
    skip(ref, undefined);
    if (!REPO.test(ref)) {
      skip(ref, "its name is not owner/name");
      continue;
    }
    const [o, n] = ref.split("/") as [string, string];
    const parent = getRepo(app.db, o, n);
    if (parent === undefined) {
      skip(ref, `${ref} no longer exists on this forge (renamed, moved or deleted)`);
      continue;
    }
    const at = next.findIndex((e) => e.upstream === ref);
    const have = at < 0 ? undefined : next[at];
    if (have?.severedAt !== undefined) {
      if (revokeFollowTokens(app.db, parent.id, child.name) > 0) out.revoked.push(ref);
      continue;
    }
    // A refusal on the first commit alone (an earlier release) is asked again with more of its history to hold.
    const reask = have?.refused === "history" && have.anchors === undefined;
    if (have !== undefined && !reask && (have.appliedAt !== undefined || have.offeredAt !== undefined || have.refused !== undefined)) continue;
    // The forge's own code has its own link, to this forge's code: it is not followed twice.
    if (n === OWN_CODE && doc["forgeCode"] !== undefined) {
      skip(ref, "it is the forge's own code, followed as the forge's code");
      continue;
    }
    const anchors = await anchorsOf(app, parent);
    if (anchors.length === 0) {
      skip(ref, `${ref} has no commits on its default branch`);
      continue;
    }
    const token = followToken(app, parent, { name: child.name, url: child.url, ownerId: child.ownerId });
    if (parent.visibility !== "public" && token === undefined) {
      skip(ref, `${ref} is private and no person here can mint it a read credential`);
      continue;
    }
    const entry: AppEntry = {
      repo: have?.repo ?? `${org}/${n}`,
      upstream: ref,
      url: repoUrl(app, ref),
      branch: parent.defaultBranch,
      // An app's default is to take its updates: it falls back to a pull by itself when the child has commits of its own.
      mode: DEFAULT_MODE,
      anchor: anchors[0]!,
      anchors,
      ...(token === undefined ? {} : { token }),
      offeredAt: new Date().toISOString(),
    };
    if (at < 0) next.push(entry);
    else next[at] = entry;
    out.offered.push(ref);
    changed = true;
  }
  if (changed) await writeEntries(dir, doc, next);
  return out;
}

let lastReconcile = 0;
/** Why the parent could not offer a child its links, by child name, as the last pass found it. */
const offerFailed = new Map<string, string>();
/** How often the parent looks over its children's app links. */
export const RECONCILE_EVERY_MS = 5 * 60_000;

/**
 * The parent's pass over every child it made: offer links to children that lack them, end the
 * credentials of the ones that severed. Never throws; a child that cannot be read is tried again.
 * `force` ignores the pace.
 */
export async function reconcileAppLinks(
  app: App,
  force = false,
  now = Date.now(),
): Promise<Record<string, Offered>> {
  if (!force && now - lastReconcile < RECONCILE_EVERY_MS) return {};
  lastReconcile = now;
  const done: Record<string, Offered> = {};
  try {
    for (const child of await listChildren(app)) {
      if (!child.done || child.apps.length === 0) continue;
      try {
        const r = await offerAppLinks(app, child);
        if (r.offered.length > 0 || r.revoked.length > 0) {
          done[child.name] = r;
          app.log.info("app links offered", { forge: child.name, offered: r.offered.join(","), revoked: r.revoked.join(",") });
          app.bus.append({
            kind: "forge.app_links",
            payload: {
              name: child.name,
              offered: r.offered.length,
              revoked: r.revoked.length,
            },
          });
        }
        offerFailed.delete(child.name);
        // Every app it was sent ends the pass in one stated condition, said once while it holds.
        reportLines(app, child.name, await appLinkLines(app, child));
      } catch (error) {
        const why = reasonOf(error);
        offerFailed.set(child.name, why);
        if (!said.has(`${child.name}:offer:${why}`)) {
          said.add(`${child.name}:offer:${why}`);
          app.log.warn("app links not offered", { forge: child.name, reason: why });
        }
      }
    }
  } catch (error) {
    app.log.warn("app links pass failed", { error: String(error) });
  }
  return done;
}

// ---- the child's side ------------------------------------------------------

/** Who the child's follow acts as: the repository's owner when a person, else the first of its organisation's Owners. */
export function ownerOf(app: App, repo: Repo): User | undefined {
  const owner = getUserById(app.db, repo.ownerId);
  if (owner?.kind === "user") return owner;
  const org =
    owner?.kind === "org" ? getOrg(app.db, owner.username) : undefined;
  const team =
    org === undefined
      ? undefined
      : listTeams(app.db, org.id).find((t) => t.name === OWNERS_TEAM);
  return team === undefined ? undefined : listTeamMembers(app.db, team.id)[0];
}

/** What the child's owner is told, in the words every door uses. */
export const linkedWords = (
  repo: string,
  upstream: string,
  host: string,
): string =>
  `${repo} now follows ${upstream} on ${host}: it takes the new commits by itself and keeps your own. Sever it from the repository's settings or with the sever tool.`;

const hostOf = (url: string): string => {
  const u = URL.parse(url);
  return u === null ? url : u.host;
};

function announce(app: App, repo: Repo, by: User, e: AppEntry): void {
  app.bus.append({
    kind: "repo.upstream_follow",
    repoId: repo.id,
    actorId: by.id,
    payload: {
      enabled: true,
      branch: e.branch ?? repo.defaultBranch,
      via: "parent",
      says: linkedWords(
        `${repo.ownerName}/${repo.name}`,
        e.upstream,
        hostOf(e.url ?? ""),
      ),
    },
  });
  app.bus.append({
    kind: "repo.following",
    repoId: repo.id,
    actorId: by.id,
    payload: { enabled: true },
  });
}

/**
 * Link one app in a child's database as the child is made: its history is the parent's by
 * construction, so nothing is asked of it. Idempotent. Answers the `apps` entry for `parent.json`.
 */
export async function linkAppAtBirth(
  app: App,
  child: App,
  childDir: string,
  input: { org: string; upstream: string; parent: Repo; repo: Repo; by: User; name: string; url: string; ownerId?: string | undefined; mode: FollowTaking },
): Promise<AppEntry> {
  const url = repoUrl(app, input.upstream);
  // The forge's own code is followed as the forge's code, never twice.
  if (input.repo.name === OWN_CODE) return { repo: `${input.org}/${input.repo.name}`, upstream: input.upstream, refused: "code" };
  const anchor = await resolveOid(repoDir(child.reposRoot, input.repo.ownerName, input.repo.name), `refs/heads/${input.repo.defaultBranch}`);
  if (getFollow(child.db, input.repo.id) === undefined) {
    const token = followToken(app, input.parent, { name: input.name, url: input.url, ownerId: input.ownerId });
    putFollow(child.db, {
      repoId: input.repo.id,
      url,
      branch: input.parent.defaultBranch,
      enabled: true,
      byId: input.by.id,
      originId: "",
      mode: input.mode,
      via: "parent",
      credentialEnc: token === undefined ? "" : seal(childDir, token, followAad(input.repo.id)),
    });
  }
  const at = new Date().toISOString();
  return {
    repo: `${input.org}/${input.repo.name}`,
    upstream: input.upstream,
    url,
    branch: input.parent.defaultBranch,
    mode: input.mode,
    ...(anchor === undefined ? {} : { anchor }),
    offeredAt: at,
    appliedAt: at,
  };
}

export interface Applied {
  readonly linked: string[];
  readonly refused: string[];
}

/**
 * One line, with no path in it, for why an app could not be linked: it is shown on the parent's
 * /forges row and logged once, and a path names a directory id, not a forge.
 */
export function reasonOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const open = /is mode (\d+); it must be 0600/.exec(text);
  if (open !== null) return `its secret key file is mode ${open[1]}; it must be 600`;
  return text.replace(/\/[^\s"']+/g, "<file>").replace(/\s+/g, " ").trim().slice(0, 160) || "failed";
}

/** What was said in the log already: a state that holds is said once, not each minute. */
const said = new Set<string>();

/** Say one app's condition once, while it holds; the same words again are not repeated. */
function say(app: App, level: "info" | "warn", forge: string, upstream: string, words: string): void {
  const key = `${forge}:${upstream}:${words}`;
  if (said.has(key)) return;
  said.add(key);
  app.log[level]("app link", { forge, app: upstream, state: words });
}

/**
 * The child's side of an offer: link each offered app whose copy still shares the parent's
 * history, unless its owner severed or set it up otherwise; record the answer. Each app is its
 * own try: one that cannot be linked (a key file the forge refuses, a repository it cannot read)
 * is left offered, with the reason on its entry for the parent to show, and the rest go on. Every
 * app it was offered is said once in the log with its condition (linked, already linked, severed,
 * refused and why, waiting and why). Never throws. `named` is the forge's name in the log.
 * Answers the repositories linked, so the caller can look upstream at once.
 */
export async function applyAppLinks(app: App, named?: string): Promise<Applied> {
  const done: Applied = { linked: [], refused: [] };
  const dir = app.config.dataDir;
  let all: AppEntry[] = [];
  let label = named ?? "this forge";
  try {
    const doc = await readDoc(dir);
    if (named === undefined && typeof doc?.["name"] === "string") label = doc["name"];
    all = entriesOf(doc);
  } catch (error) {
    app.log.warn("app links not read", { forge: label, reason: reasonOf(error) });
    return done;
  }
  for (const e of all) {
    if (e.url === undefined) continue; // not offered: the parent says why
    try {
      if (e.severedAt !== undefined) say(app, "info", label, e.upstream, "severed by its owner");
      else if (e.refused !== undefined) say(app, "info", label, e.upstream, `refused: ${REFUSED_WORDS[e.refused]}`);
      else if (e.appliedAt !== undefined) await keepApplied(app, dir, e, label);
      else await applyOne(app, dir, e, done, label);
    } catch (error) {
      const why = reasonOf(error);
      say(app, "warn", label, e.upstream, `not linked: ${why}`);
      if (e.failed !== why) await patchEntry(dir, e.upstream, (x) => ({ ...x, failed: why })).catch(() => {});
    }
  }
  return done;
}

/** Why an app was refused, in words that need no code to read. */
const REFUSED_WORDS = {
  history: "no commit of the parent's repository is in this copy (it is another repository, or one side rewrote its history)",
  own: "its owner set this repository up otherwise",
  code: "it is the forge's own code, which the forge follows as its code (the chain), not as an app",
} as const;

/** An app linked before: said once, and a link the repair made with `tell-me` is brought to the default (take-updates). */
async function keepApplied(app: App, dir: string, e: AppEntry, label: string): Promise<void> {
  const repo = findCopy(app, e);
  const row = repo === undefined ? undefined : getFollow(app.db, repo.id);
  // The repair first offered `tell-me` to children whose forge code was `tell-me`: that was never a person's choice for an app.
  // A person's choice since is a change of the row alone, which the entry does not know of, so only a row still equal to the offer is moved.
  if (repo !== undefined && row?.via === "parent" && row.enabled && row.mode === "tell-me" && e.mode === "tell-me" && e.offeredAt !== e.appliedAt) {
    setFollowTaking(app.db, repo.id, DEFAULT_MODE);
    await patchEntry(dir, e.upstream, (x) => ({ ...x, mode: DEFAULT_MODE }));
    app.log.info("app link now takes updates", { forge: label, repo: e.repo, upstream: e.upstream, was: "tell-me" });
    say(app, "info", label, e.upstream, `already linked, takes updates`);
    return;
  }
  const how = row === undefined ? "recorded as linked" : row.mode === "take-updates" ? "takes updates" : "tells its owner of updates";
  say(app, "info", label, e.upstream, `already linked, ${how}`);
}

/** Where a child's copy of an app is: where it was sent, or else the repository of the same name or one of its owner's that holds the parent's history. */
function findCopy(app: App, e: AppEntry): Repo | undefined {
  const [o, n] = e.repo.split("/") as [string, string];
  return getRepo(app.db, o, n);
}

async function holdsHistory(app: App, repo: Repo, e: AppEntry): Promise<boolean> {
  const home = repoDir(app.reposRoot, repo.ownerName, repo.name);
  // A repository row whose directory is not there holds nothing: that is an answer, not an error.
  if (!existsSync(home)) return false;
  const tip = await resolveOid(home, `refs/heads/${repo.defaultBranch}`);
  if (tip === undefined) return false;
  for (const anchor of [e.anchor, ...(e.anchors ?? [])]) {
    if (anchor !== undefined && isSafeOid(anchor) && (await runGit(["merge-base", "--is-ancestor", anchor, tip], { cwd: home })).ok) return true;
  }
  return false;
}

/**
 * The repository here that is this app's copy. Where it was sent is tried first; a copy the owner
 * renamed or moved is found by what it holds (any commit of the parent's history), among the
 * repositories of the same name and then the child's own, never by name alone.
 */
async function locate(app: App, e: AppEntry): Promise<Repo | undefined> {
  const sent = findCopy(app, e);
  if (sent !== undefined) return sent;
  const [o] = e.repo.split("/") as [string, string];
  const upstreamName = e.upstream.split("/")[1]!;
  const org = getUserByName(app.db, o);
  const owned = org === undefined ? [] : listReposOwnedBy(app.db, org.id);
  const named = app.db.query<{ id: string }, [string]>("SELECT id FROM repo WHERE name = ?1 AND archived_at IS NULL LIMIT 20").all(upstreamName);
  const candidates = [...named.map((r) => getRepoById(app.db, r.id)), ...owned.slice(0, 100)].filter((r): r is Repo => r !== undefined && r.archivedAt === null);
  const seen = new Set<string>();
  for (const r of candidates) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    if (await holdsHistory(app, r, e)) return r;
  }
  return undefined;
}

async function applyOne(app: App, dir: string, e: AppEntry, done: Applied, label: string): Promise<void> {
  const repo = await locate(app, e);
  if (repo === undefined) {
    const why = `no repository here holds ${e.upstream}'s history (${e.repo} is gone, renamed to something that is not it, or never copied)`;
    say(app, "warn", label, e.upstream, `waiting: ${why}`);
    if (e.failed !== why) await patchEntry(dir, e.upstream, (x) => ({ ...x, failed: why }));
    return;
  }
  const here = `${repo.ownerName}/${repo.name}`;
  const row = getFollow(app.db, repo.id);
  if (row?.severedAt !== null && row?.severedAt !== undefined) {
    await patchEntry(dir, e.upstream, (x) => ({ ...withoutToken(x), repo: here, severedAt: row.severedAt! }));
    say(app, "info", label, e.upstream, "severed by its owner");
    return;
  }
  if (row !== undefined) {
    // A person already set this repository up (an upstream of their own, or turned following off): theirs stands.
    const same = row.enabled && row.via === "parent" && row.url === e.url;
    await patchEntry(dir, e.upstream, (x) =>
      same ? { ...withoutToken(x), repo: here, appliedAt: x.appliedAt ?? new Date().toISOString() } : { ...withoutToken(x), repo: here, refused: "own" },
    );
    say(app, "info", label, e.upstream, same ? "already linked" : `refused: ${REFUSED_WORDS.own}`);
    return;
  }
  if (!(await holdsHistory(app, repo, e))) {
    await patchEntry(dir, e.upstream, (x) => ({ ...withoutToken(x), repo: here, refused: "history" }));
    say(app, "info", label, e.upstream, `refused: ${REFUSED_WORDS.history}`);
    done.refused.push(here);
    return;
  }
  const by = ownerOf(app, repo);
  if (by === undefined) {
    const why = `${here} has no owner here who may write it`;
    say(app, "warn", label, e.upstream, `waiting: ${why}`);
    if (e.failed !== why) await patchEntry(dir, e.upstream, (x) => ({ ...x, failed: why }));
    return;
  }
  // Sealed by this forge's own app instance, with its own key: the parent never opens a child's key for this.
  const credentialEnc = e.token === undefined ? "" : seal(dir, e.token, followAad(repo.id));
  putFollow(app.db, {
    repoId: repo.id,
    url: e.url!,
    branch: e.branch ?? repo.defaultBranch,
    enabled: true,
    byId: by.id,
    originId: "",
    // An app takes its updates by default; with commits of its own the same mode proposes them as a pull.
    mode: DEFAULT_MODE,
    via: "parent",
    credentialEnc,
  });
  await patchEntry(dir, e.upstream, (x) => ({ ...withoutToken(x), repo: here, mode: DEFAULT_MODE, appliedAt: new Date().toISOString() }));
  announce(app, repo, by, e);
  app.log.info("app linked to its upstream", { forge: label, repo: here, upstream: e.upstream, mode: DEFAULT_MODE });
  say(app, "info", label, e.upstream, "linked");
  done.linked.push(here);
}

/** An entry answered: the plain credential is gone with it, and so is any failure it had. */
const withoutToken = (e: AppEntry): AppEntry => {
  const { token: _gone, failed: _failed, ...rest } = e;
  return rest;
};

/** The child severed this app's link: written where the parent reads it, the credential's plain copy gone. */
export async function markAppSevered(
  app: App,
  repo: Repo,
  at: string,
): Promise<void> {
  const name = `${repo.ownerName}/${repo.name}`;
  try {
    const doc = await readDoc(app.config.dataDir);
    const e = entriesOf(doc).find((x) => x.repo === name);
    if (e === undefined) return;
    await patchEntry(app.config.dataDir, e.upstream, (x) => ({
      ...withoutToken(x),
      severedAt: x.severedAt ?? at,
    }));
  } catch (error) {
    app.log.warn("sever not recorded for the parent", {
      repo: name,
      error: String(error),
    });
  }
}

// ---- what the parent shows ---------------------------------------------------

export interface AppLinkLine {
  /** `<owner>/<name>` here. */
  readonly upstream: string;
  /** `<org>/<name>` in the child. */
  readonly repo: string;
  readonly state: "following" | "offered" | "severed" | "not-linked" | "not-offered" | "failed";
  /** Why, for every state but `following` and `severed`: one line, no path. */
  readonly why?: string;
  /** For `offered`: since when, ISO. */
  readonly since?: string;
  readonly mode: FollowTaking | null;
  readonly severedAt: string | null;
  /** Whether this forge holds a live read credential for it. */
  readonly credential: boolean;
}

/**
 * The apps a child was given and how each stands, as its `parent.json` and this forge's last pass
 * say: every app is in exactly one state, and any that is not linked says why. Reads the child's
 * file, so it is for a pass, never for a request (`servedRows`).
 */
export async function appLinkLines(app: App, child: Child): Promise<AppLinkLine[]> {
  const entries = entriesOf(await readDoc(childDirOf(app, child.bodyId)));
  return child.apps.map((ref) => {
    const e = entries.find((x) => x.upstream === ref);
    const parent = REPO.test(ref) ? getRepo(app.db, ...(ref.split("/") as [string, string])) : undefined;
    const credential = parent !== undefined && followTokenCount(app.db, parent.id, child.name) > 0;
    const base = { upstream: ref, repo: e?.repo ?? ref, mode: e?.mode ?? null, severedAt: e?.severedAt ?? null, credential };
    if (e?.severedAt !== undefined) return { ...base, state: "severed" as const };
    if (e?.appliedAt !== undefined) return { ...base, state: "following" as const };
    if (e?.refused !== undefined) return { ...base, state: "not-linked" as const, why: REFUSED_WORDS[e.refused] };
    if (e?.failed !== undefined) return { ...base, state: "failed" as const, why: e.failed };
    if (e?.offeredAt !== undefined) return { ...base, state: "offered" as const, since: e.offeredAt };
    return { ...base, state: "not-offered" as const, why: notOffered.get(`${child.name}:${ref}`) ?? offerFailed.get(child.name) ?? "not looked at yet by this forge's pass" };
  });
}

/** The sentence a line says on the parent's page and in its log. */
export function appLinkWords(l: AppLinkLine): string {
  switch (l.state) {
    case "following":
      return `${l.upstream}: follows it${l.mode === "take-updates" ? ", taking updates" : ", telling its owner"}`;
    case "offered":
      return `${l.upstream}: offered the link${l.since === undefined ? "" : ` at ${l.since.slice(0, 16).replace("T", " ")} UTC`}; the child has not applied it yet`;
    case "severed":
      return `${l.upstream}: severed by its owner${l.severedAt === null ? "" : ` on ${l.severedAt.slice(0, 10)}`}; nothing is followed or sent`;
    case "not-linked":
      return `${l.upstream}: refused: ${l.why ?? "its copy is not this repository's history"}`;
    case "not-offered":
      return `${l.upstream}: not offered: ${l.why ?? "unknown"}`;
    case "failed":
      return `${l.upstream}: could not offer the link: ${l.why ?? "unknown"}`;
  }
}

/** One line for a row: how many of its apps are followed, and which are not and why. */
export function appLinkSummary(lines: readonly AppLinkLine[]): string | null {
  if (lines.length === 0) return null;
  const on = lines.filter((l) => l.state === "following").length;
  const off = lines.filter((l) => l.state === "severed").length;
  const rest = lines.filter((l) => l.state !== "following" && l.state !== "severed");
  const parts = [`follows ${on} of ${lines.length} apps`];
  if (off > 0) parts.push(`${off} severed by its owner`);
  for (const l of rest) parts.push(`${l.upstream.split("/")[1]}: ${l.state === "offered" ? "offered, not applied yet" : (l.why ?? l.state)}`);
  return parts.join("; ");
}

/** Say each app's condition in the log, once while it holds. */
export function reportLines(app: App, forge: string, lines: readonly AppLinkLine[]): void {
  for (const l of lines) {
    // An offer the child has not taken in ten minutes is said again, louder: it is not running the code that takes it, or cannot.
    const stale = l.state === "offered" && l.since !== undefined && Date.now() - Date.parse(l.since) > 10 * 60_000;
    const words = `parent sees: ${appLinkWords(l)}${stale ? "; not applied after ten minutes (is the child awake and on this release?)" : ""}`;
    say(app, l.state === "failed" || l.state === "not-offered" || stale ? "warn" : "info", forge, l.upstream, words);
  }
}

/**
 * For the heartbeat's answer: the tip of each followed app on this forge's default branch, by the
 * child's own repository, so a child in a cell of its own learns an app landed without waiting
 * for its clock. Only apps it applied and did not sever; bounded.
 */
export async function appTipsFor(
  app: App,
  name: string,
): Promise<Record<string, string>> {
  const child = await childNamed(app, name);
  if (child === undefined) return {};
  const tips: Record<string, string> = {};
  for (const e of entriesOf(await readDoc(childDirOf(app, child.bodyId))).slice(
    0,
    50,
  )) {
    if (e.appliedAt === undefined || e.severedAt !== undefined) continue;
    const [o, n] = e.upstream.split("/") as [string, string];
    const parent = getRepo(app.db, o, n);
    if (parent === undefined) continue;
    const tip = await resolveOid(
      repoDir(app.reposRoot, o, n),
      `refs/heads/${parent.defaultBranch}`,
    );
    if (tip !== undefined) tips[e.repo] = tip;
  }
  return tips;
}

/** Whether the actor may sever here: the follow's own check is `canAdmin`; this names the person a follow acts as. */
export const followsAs = (
  app: App,
  repo: Repo,
  byId: string,
): User | undefined => {
  const by = getUserById(app.db, byId);
  if (by !== undefined && by.kind === "user" && canWrite(app.db, repo, by))
    return by;
  const owner = ownerOf(app, repo);
  return owner !== undefined && canWrite(app.db, repo, owner)
    ? owner
    : undefined;
};

