/**
 * The thank-you note (#9013): when a pull whose author lives elsewhere lands
 * — a fork a person keeps, a pull brought from the mirror, work from another
 * forge — its author reads, on the pull and, where the origin takes a
 * comment, on the origin pull, that it landed, in which commit, and what
 * changed between their head and main on the way: slices landed first,
 * merges of the base into their branch (conflicts resolved), a squash.
 *
 * Never for crew pulls, and once per landing: the note names the landing
 * commit, and a pull that already carries a note naming it gets no second.
 */

import type { App } from "../app.ts";
import { addComment, getIssueById, landingThanked } from "../core/issues.ts";
import { fromKeptFork } from "../core/landing_kind.ts";
import { getMirrorTarget } from "../core/migrate_mirror.ts";
import { getOriginById } from "../core/origins.ts";
import type { Pull } from "../core/pulls.ts";
import type { Repo } from "../core/repos.ts";
import { pullSourceOf } from "../core/trusted_sources.ts";
import { getUserById } from "../core/users.ts";
import { runGit } from "../git/env.ts";
import { isSafeOid } from "../git/guard.ts";
import { carriedSummary, type MergeStrategy } from "../git/merge.ts";
import { repoDir } from "../git/repos.ts";
import { landedSlices } from "../git/slices.ts";
import { createLog } from "../kernel/log.ts";
import { providerForOrigin } from "./credential.ts";
import type { Provider } from "./types.ts";

const log = createLog("thanks");

/** Who is thanked, and the origin pull to tell as well, when there is one. */
export interface Thanked {
  /** As the note writes it: `@user` here, a bare name or `account@host` elsewhere. */
  readonly name: string;
  readonly originUrl: string | null;
}

/** A merge of the base into the author's branch, on the way to landing. */
export interface Resolution {
  readonly oid: string;
  readonly subject: string;
}

export interface Landed {
  readonly name: string;
  readonly number: number;
  readonly mergeOid: string;
  /** The landing commit's page, when the forge knows its own URL. */
  readonly commitUrl: string | null;
  readonly strategy: MergeStrategy;
  readonly baseBranch: string;
  readonly commits: number;
  readonly authors: readonly string[];
  readonly files: number;
  /** The slices that landed before this one, oldest first: their merge commits. */
  readonly slices: readonly string[];
  readonly resolved: readonly Resolution[];
}

/** A name as it may stand in a note: no markdown, no line breaks, bounded. */
const cleanName = (s: string): string => s.replace(/[^A-Za-z0-9._@-]/g, "").slice(0, 100);

/** A commit author's name as it may stand in a note: letters, spaces and marks, no markdown. */
const cleanAuthor = (s: string): string =>
  s.replace(/[^\p{L}\p{N} .'@-]/gu, "").replace(/\s+/g, " ").trim().slice(0, 100);

/** A commit subject as it may stand in a code span. */
const cleanSubject = (s: string): string =>
  s.replace(/[\u0000-\u001f\u007f`]+/g, " ").trim().slice(0, 80);

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? "" : "s"}`;

/** Whom a landed pull thanks, or nobody: crew pulls and pulls made here are not thanked. */
export function whomToThank(app: App, pull: Pull): Thanked | undefined {
  const author = getUserById(app.db, pull.authorId);
  if (author === undefined || author.kind === "agent") return undefined;
  const issue = getIssueById(app.db, pull.id);
  const fromMirror = issue?.originAuthor ?? null;
  if (fromMirror !== null && cleanName(fromMirror) !== "")
    return { name: cleanName(fromMirror), originUrl: issue?.originUrl ?? null };
  const source = pullSourceOf(app.db, pull.id);
  if (source !== undefined) {
    const name = cleanName(`${source.account}@${source.host}`);
    if (name !== "") return { name, originUrl: null };
  }
  if (fromKeptFork(app.db, pull)) return { name: `@${cleanName(author.username)}`, originUrl: null };
  return undefined;
}

/** The note itself: plain data in, markdown out. */
export function thanksNote(l: Landed): string {
  const short = l.mergeOid.slice(0, 12);
  const commit = l.commitUrl === null ? `\`${short}\`` : `[\`${short}\`](${l.commitUrl})`;
  const who = l.authors.length === 0 ? "you" : l.authors.map(cleanAuthor).filter(Boolean).join(", ") || "you";
  const how =
    l.strategy === "merge"
      ? `as a merge, so your commits are ancestors of ${l.baseBranch} and \`git merge ${l.baseBranch}\` on your side stays clean`
      : `squashed into one commit on ${l.baseBranch}`;
  const lines = [
    `Thank you, ${l.name}: pull #${l.number} landed in ${commit}.`,
    "",
    `${plural(l.commits, "commit")} by ${who} touched ${plural(l.files, "file")}, landed ${how}.`,
  ];
  const changed: string[] = [];
  if (l.slices.length > 0)
    changed.push(
      `- landed in ${plural(l.slices.length + 1, "slice")}: ${[...l.slices.map((s) => `\`${s.slice(0, 12)}\``), commit].join(", ")}`,
    );
  if (l.resolved.length > 0)
    changed.push(
      `- conflicts resolved: ${plural(l.resolved.length, "merge")} of ${l.baseBranch} into your branch (${l.resolved
        .map((r) => `\`${r.oid.slice(0, 12)}\` ${cleanSubject(r.subject)}`.trim())
        .join("; ")})`,
    );
  if (l.strategy === "squash" && l.commits > 1) changed.push(`- your ${plural(l.commits, "commit")} became one`);
  lines.push("");
  if (changed.length === 0) lines.push("Nothing changed on the way: it landed as you pushed it.");
  else lines.push("What changed from your head on the way:", ...changed);
  return lines.join("\n");
}

/** Merges of the base into the pull's range: where its conflicts were resolved. */
async function resolutions(dir: string, baseOid: string, headOid: string): Promise<Resolution[]> {
  if (!isSafeOid(baseOid) || !isSafeOid(headOid)) return [];
  const out = await runGit(["log", "--merges", "--max-count=20", "--format=%H %s", `${baseOid}..${headOid}`], {
    cwd: dir,
  });
  if (!out.ok) return [];
  return out.value
    .split("\n")
    .filter(Boolean)
    .map((line) => ({ oid: line.slice(0, 40), subject: line.slice(41) }))
    .reverse();
}

/** The commit's first parent: the base as it stood before the landing. */
async function firstParent(dir: string, oid: string): Promise<string | undefined> {
  if (!isSafeOid(oid)) return undefined;
  const out = await runGit(["rev-parse", `${oid}^1`], { cwd: dir });
  const p = out.ok ? out.value.trim() : "";
  return isSafeOid(p) ? p : undefined;
}

function commitUrl(app: App, repo: Repo, oid: string): string | null {
  const base = app.config.url;
  if (base === undefined || !/^https?:\/\//i.test(base)) return null;
  return `${base.replace(/\/+$/, "")}/${encodeURIComponent(repo.ownerName)}/${encodeURIComponent(repo.name)}/commit/${oid}`;
}

/** The origin pull's number, read from its link back. */
const originNumber = (url: string): number | undefined => {
  const m = /\/(\d{1,9})\/?$/.exec(URL.parse(url)?.pathname ?? "");
  return m === null ? undefined : Number(m[1]);
};

/** Tell the origin pull, through the mirror this repository pushes to. Never throws. */
export async function thankOnOrigin(
  app: App,
  repo: Repo,
  originUrl: string,
  body: string,
  provider?: Provider,
): Promise<boolean> {
  const number = originNumber(originUrl);
  const target = getMirrorTarget(app.db, repo.id);
  if (number === undefined || target === undefined) return false;
  let p = provider;
  if (p === undefined) {
    const origin = getOriginById(app.db, target.originId);
    if (origin === undefined) return false;
    const made = providerForOrigin(app, origin);
    if (!made.ok) return false;
    p = made.value;
  }
  try {
    const said = await p.createComment(target.fullName, number, body);
    if (!said.ok) log.warn("thanks not posted on the origin", { repo: repo.id, number, error: said.error.message });
    return said.ok;
  } catch (error) {
    log.warn("thanks not posted on the origin", { repo: repo.id, number, error: String(error) });
    return false;
  }
}

/**
 * Thank a landed pull's author, once: the note on the pull, written before
 * this returns, and nothing when it is not theirs to get. The origin's copy
 * is sent without waiting, so a landing never waits on another host; it
 * never throws, a failure is logged (`thankOnOrigin`).
 */
export async function thankAuthor(
  app: App,
  repo: Repo,
  pull: Pull,
  landing: { readonly mergeOid: string; readonly strategy: MergeStrategy; readonly by: string },
): Promise<string | undefined> {
  const who = whomToThank(app, pull);
  if (who === undefined || !isSafeOid(landing.mergeOid)) return undefined;
  if (landingThanked(app.db, { pullId: pull.id, authorId: landing.by, mergeOid: landing.mergeOid })) return undefined;
  const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
  const before = (await firstParent(dir, landing.mergeOid)) ?? pull.baseOid;
  const head = pull.headOid;
  const [carried, slices, resolved] = await Promise.all([
    carriedSummary(dir, before, head),
    landedSlices(dir, landing.mergeOid, pull.number, pull.createdAt),
    resolutions(dir, before, head),
  ]);
  // Another landing of the same pull raced this one while git was read.
  if (landingThanked(app.db, { pullId: pull.id, authorId: landing.by, mergeOid: landing.mergeOid })) return undefined;
  const note = thanksNote({
    name: who.name,
    number: pull.number,
    mergeOid: landing.mergeOid,
    commitUrl: commitUrl(app, repo, landing.mergeOid),
    strategy: landing.strategy,
    baseBranch: pull.baseBranch,
    ...carried,
    slices: slices.map((s) => s.mergeOid),
    resolved,
  });
  const noted = addComment(app.db, { issueId: pull.id, authorId: landing.by, body: note });
  if (!noted.ok) return undefined;
  app.bus.append({
    kind: "pull.commented",
    repoId: repo.id,
    actorId: landing.by,
    payload: { number: pull.number, body: note, commentId: noted.value.id },
  });
  if (who.originUrl !== null) void thankOnOrigin(app, repo, who.originUrl, note);
  return note;
}
