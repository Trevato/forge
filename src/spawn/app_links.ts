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
import { canWrite, getRepo, type Repo } from "../core/repos.ts";
import {
  followAad,
  getFollow,
  isFollowTaking,
  putFollow,
  type FollowTaking,
} from "../core/upstream_follow.ts";
import { getUserById, type User } from "../core/users.ts";
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
  /** The read credential for a private parent repository, until the child seals it. */
  readonly token?: string;
  readonly offeredAt?: string;
  readonly appliedAt?: string;
  readonly severedAt?: string;
  /** Why the child did not link it: its history does not hold `anchor`, or its owner had set the repository up otherwise. */
  readonly refused?: "history" | "own";
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
    e["refused"] === "history" || e["refused"] === "own"
      ? e["refused"]
      : undefined;
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
 * The commit that proves a child's copy is this repository's: its first, on the default branch.
 * A copy made by a spawn holds it, and so does anything that grew from it; an unrelated
 * repository that only shares the name does not. (A date would not do: commit dates are the
 * author's, and a commit landed after the spawn can carry an older one.) "" when there are no commits.
 */
export async function anchorOf(app: App, parent: Repo): Promise<string> {
  const dir = repoDir(app.reposRoot, parent.ownerName, parent.name);
  const roots = await runGit(["rev-list", "--max-parents=0", `refs/heads/${parent.defaultBranch}`], { cwd: dir });
  const first = roots.ok ? (roots.value.trim().split("\n").at(-1) ?? "") : "";
  return OID.test(first) ? first : "";
}

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

/** How a child follows its parent's code, when it chose; else what a new child takes. */
function modeFor(doc: Record<string, unknown> | undefined): FollowTaking {
  const link = doc?.["forgeCode"];
  const mode =
    typeof link === "object" && link !== null
      ? (link as Record<string, unknown>)["mode"]
      : undefined;
  return isFollowTaking(mode) ? mode : DEFAULT_MODE;
}

export interface Offered {
  readonly offered: string[];
  readonly revoked: string[];
}

/**
 * Offer a child the link to each app it was given that has none: written into its `parent.json`,
 * nothing else touched, and only for an app it was not offered, did not answer, or severed. Also
 * ends the follow tokens of an app the child severed. Idempotent; the child decides.
 */
export async function offerAppLinks(app: App, child: Child): Promise<Offered> {
  const out: { offered: string[]; revoked: string[] } = {
    offered: [],
    revoked: [],
  };
  const dir = childDirOf(app, child.bodyId);
  const doc = await readDoc(dir);
  const org = typeof doc?.["org"] === "string" ? doc["org"] : undefined;
  if (doc === undefined || org === undefined) return out;
  const entries = entriesOf(doc);
  const next: AppEntry[] = [...entries];
  let changed = false;
  for (const ref of child.apps) {
    if (!REPO.test(ref)) continue;
    const [o, n] = ref.split("/") as [string, string];
    const parent = getRepo(app.db, o, n);
    if (parent === undefined) continue;
    const at = next.findIndex((e) => e.upstream === ref);
    const have = at < 0 ? undefined : next[at];
    if (have?.severedAt !== undefined) {
      if (revokeFollowTokens(app.db, parent.id, child.name) > 0)
        out.revoked.push(ref);
      continue;
    }
    if (
      have !== undefined &&
      (have.appliedAt !== undefined ||
        have.offeredAt !== undefined ||
        have.refused !== undefined)
    )
      continue;
    const anchor = await anchorOf(app, parent);
    if (anchor === "") continue;
    const token = followToken(app, parent, {
      name: child.name,
      url: child.url,
      ownerId: child.ownerId,
    });
    const entry: AppEntry = {
      repo: have?.repo ?? `${org}/${n}`,
      upstream: ref,
      url: repoUrl(app, ref),
      branch: parent.defaultBranch,
      mode: modeFor(doc),
      anchor,
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

/** What was said in the log already, by forge name and reason: a failure that stays is said once, not each minute. */
const said = new Set<string>();

/**
 * The child's side of an offer: link each offered app whose repository's default branch still
 * holds `anchor`, unless its owner severed or set it up otherwise; record the answer. Each app is
 * its own try: one that cannot be linked (a key file the forge refuses, a repository it cannot
 * read) is left offered, with the reason on its entry for the parent to show, and the rest go on.
 * Never throws. `label` is the forge's name in the log. Answers the repositories linked, so the
 * caller can look upstream at once.
 */
export async function applyAppLinks(app: App, named?: string): Promise<Applied> {
  const done: Applied = { linked: [], refused: [] };
  const dir = app.config.dataDir;
  let todo: AppEntry[] = [];
  let label = named ?? "this forge";
  try {
    const doc = await readDoc(dir);
    if (named === undefined && typeof doc?.["name"] === "string") label = doc["name"];
    todo = entriesOf(doc).filter(
      (e) => e.url !== undefined && e.appliedAt === undefined && e.severedAt === undefined && e.refused === undefined,
    );
  } catch (error) {
    app.log.warn("app links not read", { forge: label, reason: reasonOf(error) });
    return done;
  }
  for (const e of todo) {
    try {
      await applyOne(app, dir, e, done, label);
    } catch (error) {
      const why = reasonOf(error);
      if (!said.has(`${label}:${e.repo}:${why}`)) {
        said.add(`${label}:${e.repo}:${why}`);
        app.log.warn("app link not applied", { forge: label, repo: e.repo, reason: why });
      }
      if (e.failed !== why) await patchEntry(dir, e.upstream, (x) => ({ ...x, failed: why })).catch(() => {});
    }
  }
  return done;
}

async function applyOne(app: App, dir: string, e: AppEntry, done: Applied, label: string): Promise<void> {
  const [o, n] = e.repo.split("/") as [string, string];
  const repo = getRepo(app.db, o, n);
  if (repo === undefined) return; // not there (yet): the offer stands
  const row = getFollow(app.db, repo.id);
  if (row?.severedAt !== null && row?.severedAt !== undefined) {
    await patchEntry(dir, e.upstream, (x) => ({ ...withoutToken(x), severedAt: row.severedAt! }));
    return;
  }
  if (row !== undefined) {
    // A person already set this repository up (an upstream of their own, or turned following off): theirs stands.
    const same = row.enabled && row.via === "parent" && row.url === e.url;
    await patchEntry(dir, e.upstream, (x) =>
      same ? { ...withoutToken(x), appliedAt: x.appliedAt ?? new Date().toISOString() } : { ...withoutToken(x), refused: "own" },
    );
    return;
  }
  const home = repoDir(app.reposRoot, repo.ownerName, repo.name);
  const tip = await resolveOid(home, `refs/heads/${repo.defaultBranch}`);
  const holds =
    tip !== undefined &&
    e.anchor !== undefined &&
    isSafeOid(e.anchor) &&
    (await runGit(["merge-base", "--is-ancestor", e.anchor, tip], { cwd: home })).ok;
  if (!holds) {
    await patchEntry(dir, e.upstream, (x) => ({ ...withoutToken(x), refused: "history" }));
    done.refused.push(e.repo);
    return;
  }
  const by = ownerOf(app, repo);
  if (by === undefined) return;
  // Sealed by this forge's own app instance, with its own key: the parent never opens a child's key for this.
  const credentialEnc = e.token === undefined ? "" : seal(dir, e.token, followAad(repo.id));
  putFollow(app.db, {
    repoId: repo.id,
    url: e.url!,
    branch: e.branch ?? repo.defaultBranch,
    enabled: true,
    byId: by.id,
    originId: "",
    mode: e.mode ?? DEFAULT_MODE,
    via: "parent",
    credentialEnc,
  });
  await patchEntry(dir, e.upstream, (x) => ({ ...withoutToken(x), appliedAt: new Date().toISOString() }));
  announce(app, repo, by, e);
  app.log.info("app linked to its upstream", { forge: label, repo: e.repo, upstream: e.upstream, mode: e.mode ?? DEFAULT_MODE });
  done.linked.push(e.repo);
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
  readonly state:
    | "following"
    | "offered"
    | "severed"
    | "not-linked"
    | "not-yet"
    | "failed";
  /** For `failed`: why, in one line with no path. */
  readonly why?: string;
  readonly mode: FollowTaking | null;
  readonly severedAt: string | null;
  /** Whether this forge holds a live read credential for it. */
  readonly credential: boolean;
}

/** The apps a child was given and whether it still follows each, as its `parent.json` says; empty when it was given none. */
export async function appLinkLines(
  app: App,
  child: Child,
): Promise<AppLinkLine[]> {
  const entries = entriesOf(await readDoc(childDirOf(app, child.bodyId)));
  return child.apps.map((ref) => {
    const e = entries.find((x) => x.upstream === ref);
    const parent = REPO.test(ref)
      ? getRepo(app.db, ...(ref.split("/") as [string, string]))
      : undefined;
    const credential =
      parent !== undefined &&
      followTokenCount(app.db, parent.id, child.name) > 0;
    const why = e?.failed ?? offerFailed.get(child.name);
    const state: AppLinkLine["state"] =
      e?.severedAt === undefined && e?.appliedAt === undefined && why !== undefined
        ? "failed"
        : e === undefined
        ? "not-yet"
        : e.severedAt !== undefined
          ? "severed"
          : e.appliedAt !== undefined
            ? "following"
            : e.refused !== undefined
              ? "not-linked"
              : e.offeredAt !== undefined
                ? "offered"
                : "not-yet";
    return {
      upstream: ref,
      repo: e?.repo ?? ref,
      state,
      ...(state === "failed" && why !== undefined ? { why } : {}),
      mode: e?.mode ?? null,
      severedAt: e?.severedAt ?? null,
      credential,
    };
  });
}

/** The sentence a line says on the parent's page. */
export function appLinkWords(l: AppLinkLine): string {
  switch (l.state) {
    case "following":
      return `${l.upstream}: follows it${l.mode === "take-updates" ? ", taking updates" : ", telling its owner"}`;
    case "offered":
      return `${l.upstream}: offered the link; it applies it when it next wakes`;
    case "severed":
      return `${l.upstream}: severed by its owner${l.severedAt === null ? "" : ` on ${l.severedAt.slice(0, 10)}`}; nothing is followed or sent`;
    case "not-linked":
      return `${l.upstream}: not linked; the child's copy is not this repository's history`;
    case "not-yet":
      return `${l.upstream}: not linked yet`;
    case "failed":
      return `${l.upstream}: could not offer the link: ${l.why ?? "unknown"}`;
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

