/**
 * The hot-file WIP limit (#5934, #5924 step 3): a build is not started
 * while a file it expects to touch is already touched by `HOT_PULLS` or
 * more open pulls. One more pull on that file is one more rebase for each
 * of the others when any of them lands; the build waits until the pile
 * drains under the limit.
 *
 * - An issue's expected files are the repository paths its title and body
 *   name (`expectedFiles`): `src/http/mcp.ts`, `docs/MCP.md`. When the body
 *   has a line that starts with `Files:`, only the paths on that line count;
 *   a path named elsewhere as context does not hold the build.
 * - The files an open pull touches are read from git once per head
 *   (`learnPullFiles`, asked by the picker before it sorts), and kept in
 *   memory: a cache git rebuilds, never state of its own.
 * - The holds the picker last said, per repository (`standingHot`), are what
 *   the feed shows while they stand.
 */

import type { App } from "../app.ts";
import { getIssuesByIds, type Issue } from "../core/issues.ts";
import { joinMany, pullDir } from "../core/pulls.ts";
import type { Repo } from "../core/repos.ts";
import { runGitCapture } from "../git/env.ts";
import { HOT_PULLS } from "../flow/hot_trend.ts";
import { sampleHeat } from "./hot_history.ts";

export { HOT_PULLS };

/**
 * A pull whose diff touches more than this many files counts toward no file's
 * heat (#6235): such a diff carries the base's history (a conflicted pull
 * never rebased), not its own work, and would make every file hot.
 */
export const WIDE_PULL = 60;

/** The most paths read from one issue: a list longer than this is a manifest, not a plan. */
const MAX_EXPECTED = 40;

/** A path with at least one directory and a file extension: `src/http/mcp.ts`. */
const PATH = /(?<![\w./:-])((?:[\w-][\w.-]*\/)+[\w-][\w.-]*\.[A-Za-z0-9]+)(?![\w/])/g;
/** A bare file name in backticks: `README.md`, `forge.json`. */
const QUOTED = /`([\w-][\w.-]*\.[A-Za-z0-9]+)`/g;

/** The repository paths an issue names, in the order it names them, each once. */
export function expectedFiles(issue: Pick<Issue, "title" | "body">): string[] {
  const listed = issue.body.match(/^Files:(.*)$/m);
  return pathsIn(listed ? listed[1]! : `${issue.title}\n${issue.body}`);
}

/** The most paths one issue may relieve. */
const MAX_RELIEVED = 3;

/**
 * The paths an issue relieves (#7422): named on a line starting `Relieves:`
 * and also on its `Files:` line, at most three. The change exists to shrink
 * what other pulls must touch there, so the file being hot does not hold it.
 */
export function relievedFiles(issue: Pick<Issue, "body">): string[] {
  const files = issue.body.match(/^Files:(.*)$/m);
  const line = issue.body.match(/^Relieves:(.*)$/m);
  if (!files || !line) return [];
  const listed = new Set(pathsIn(files[1]!));
  return pathsIn(line[1]!).filter((p) => listed.has(p)).slice(0, MAX_RELIEVED);
}

function pathsIn(text: string): string[] {
  const found = new Set<string>();
  for (const pattern of [PATH, QUOTED])
    for (const match of text.matchAll(pattern)) {
      const path = match[1]!.replace(/\.+$/, "");
      if (path.split("/").some((part) => part === "." || part === "..")) continue;
      found.add(path);
      if (found.size >= MAX_EXPECTED) return [...found];
    }
  return [...found];
}

export interface HotFile {
  readonly path: string;
  /** Open pulls that touch it. */
  readonly pulls: number;
}

/** Per repository, per open pull: the head and base it was read at, and the files. */
const touched = new Map<string, Map<string, { at: string; number: number; files: readonly string[] }>>();

const OID = /^[0-9a-f]{40,64}$/;

/**
 * Read the files each open pull of `repo` touches, for any pull whose head
 * moved since it was last read, and forget the pulls no longer open. A pull
 * git cannot answer for touches nothing until it can. Each pass samples the
 * counts at `now` (`hot_history.ts`).
 */
export async function learnPullFiles(app: App, repo: Repo, now: number = Date.now()): Promise<void> {
  const ids = app.db
    .query<{ id: string }, [string]>(
      `SELECT p.issue_id AS id FROM pull p JOIN issue i ON i.id = p.issue_id
        WHERE i.repo_id = ?1 AND i.state = 'open' AND p.merged_at IS NULL`,
    )
    .all(repo.id)
    .map((r) => r.id);
  const pulls = joinMany(app.db, [...getIssuesByIds(app.db, ids).values()]);
  const before = touched.get(repo.id) ?? new Map();
  const after = new Map<string, { at: string; number: number; files: readonly string[] }>();
  for (const pull of pulls) {
    if (!OID.test(pull.headOid)) continue;
    const dir = await pullDir(app.db, app.reposRoot, repo, pull);
    // From the base branch's tip now, not the base the pull was opened on:
    // after a rebase that old base is behind, and `old...head` counts every
    // file main changed since as the pull's own, so every file looked hot.
    const tip = await runGitCapture(["rev-parse", "--verify", `refs/heads/${pull.baseBranch}`], { cwd: dir });
    const base = tip.code === 0 ? tip.stdout.trim() : pull.baseOid;
    if (!OID.test(base)) continue;
    const at = `${base}...${pull.headOid}`;
    const known = before.get(pull.id);
    if (known !== undefined && known.at === at) {
      after.set(pull.id, known);
      continue;
    }
    const out = await runGitCapture(["diff", "--name-only", "-z", at], { cwd: dir });
    if (out.code !== 0) continue;
    after.set(pull.id, { at, number: pull.number, files: out.stdout.split("\0").filter((f) => f !== "") });
  }
  touched.set(repo.id, after);
  sampleHeat(repo.id, pullCounts(repo.id), now);
}

/** Every file of `repoId` with how many open pulls touch it, narrow pulls only. */
export function pullCounts(
  repoId: string,
  admit: (pullNumber: number) => boolean = () => true,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const { files, number } of touched.get(repoId)?.values() ?? []) {
    if (files.length > WIDE_PULL || !admit(number)) continue;
    for (const file of files) counts.set(file, (counts.get(file) ?? 0) + 1);
  }
  return counts;
}

/** The most pulls a hold names. */
export const PULLS_NAMED = 8;

/** The numbers of the open pulls that touch `path`, oldest first, at most `PULLS_NAMED`. Memory only. */
export function pullsTouching(
  repoId: string,
  path: string,
  admit: (pullNumber: number) => boolean = () => true,
): number[] {
  const out: number[] = [];
  for (const { files, number } of touched.get(repoId)?.values() ?? [])
    if (files.length <= WIDE_PULL && admit(number) && files.includes(path)) out.push(number);
  return out.sort((a, b) => a - b).slice(0, PULLS_NAMED);
}

/** Every file of `repo` that `HOT_PULLS` or more open pulls touch, with how many. */
export function hotFiles(
  repoId: string,
  admit?: (pullNumber: number) => boolean,
): Map<string, number> {
  const counts = pullCounts(repoId, admit);
  for (const [file, n] of counts) if (n < HOT_PULLS) counts.delete(file);
  return counts;
}

/** The flow panel lists a file this many open pulls touch, held or not. */
export const WARM_PULLS = 3;

/** Every repository with pulls learned, and each file `WARM_PULLS` or more of its open pulls touch. Memory only: never git. */
export function warmFiles(): { repoId: string; path: string; pulls: number }[] {
  const out: { repoId: string; path: string; pulls: number }[] = [];
  for (const [repoId, pulls] of touched) {
    const counts = new Map<string, number>();
    for (const { files } of pulls.values()) {
      if (files.length > WIDE_PULL) continue;
      for (const file of files) counts.set(file, (counts.get(file) ?? 0) + 1);
    }
    for (const [path, n] of counts) if (n >= WARM_PULLS) out.push({ repoId, path, pulls: n });
  }
  return out;
}

/** Put what git said about `repoId`'s open pulls into the cache, as `learnPullFiles` would; for tests. */
export function rememberPullFiles(repoId: string, pulls: readonly { number: number; files: readonly string[] }[]): void {
  touched.set(repoId, new Map(pulls.map((p) => [`pull-${p.number}`, { at: `seeded-${p.number}`, ...p }])));
}

/** An open pull too wide to count toward heat, with the files its diff touches. */
export interface WidePull {
  readonly number: number;
  readonly files: number;
}

/** The open pulls of `repoId` wider than `WIDE_PULL`, widest first. */
export function widePulls(repoId: string): WidePull[] {
  return [...(touched.get(repoId)?.values() ?? [])]
    .filter((p) => p.files.length > WIDE_PULL)
    .map((p) => ({ number: p.number, files: p.files.length }))
    .sort((a, b) => b.files - a.files || a.number - b.number);
}

/** `too wide to count: #4840 (1,081 files), #5460 (898 files)`, or "" when none. */
export function wideSays(wide: readonly WidePull[]): string {
  if (wide.length === 0) return "";
  const list = wide.map((w) => `#${w.number} (${w.files.toLocaleString("en-US")} files)`).join(", ");
  return `too wide to count: ${list}`;
}

/** The hot files `issue` expects to touch, hottest first. */
export function hotOverlap(
  issue: Pick<Issue, "title" | "body">,
  hot: ReadonlyMap<string, number>,
): HotFile[] {
  if (hot.size === 0) return [];
  const relieved = new Set(relievedFiles(issue));
  return expectedFiles(issue)
    .filter((path) => !relieved.has(path))
    .flatMap((path) => {
      const pulls = hot.get(path);
      return pulls === undefined ? [] : [{ path, pulls }];
    })
    .sort((a, b) => b.pulls - a.pulls || a.path.localeCompare(b.path));
}

/** A held build as the feed says it. */
export interface HotHold {
  readonly number: number;
  readonly title: string;
  readonly files: readonly HotFile[];
  /** The admin's hold (`file_holds.ts`) that keeps this build, with the setter's name. */
  readonly pin?: { readonly path: string; readonly byName: string };
  /** The path another issue (`#by`) is already relieving, which keeps this one waiting. */
  readonly relieving?: { readonly path: string; readonly by: number };
}

/** The pulls too wide to count as the picker last saw them, per repository, held builds or not. */
const standingWideBy = new Map<string, { at: string; wide: readonly WidePull[] }>();

/** The pulls too wide to count in `repoId` as the picker last saw them, if any. */
export function standingWide(repoId: string): { at: string; wide: readonly WidePull[] } | undefined {
  return standingWideBy.get(repoId);
}

/** What the picker last held on hot files, per repository, and when. */
const standing = new Map<string, { at: string; holds: readonly HotHold[]; wide: readonly WidePull[] }>();

/** Remember the builds the picker holds on hot files in `repoId` now; none clears it. */
export function holdHot(
  repoId: string,
  issues: readonly Issue[],
  at = new Date(),
  pins: ReadonlyMap<number, { path: string; byName: string }> = new Map(),
  relieving: ReadonlyMap<number, { path: string; by: number }> = new Map(),
): void {
  const wide = widePulls(repoId);
  if (wide.length === 0) standingWideBy.delete(repoId);
  else standingWideBy.set(repoId, { at: at.toISOString(), wide });
  if (issues.length === 0) {
    standing.delete(repoId);
    return;
  }
  const hot = hotFiles(repoId);
  standing.set(repoId, {
    at: at.toISOString(),
    holds: issues.map((i) => {
      const pin = pins.get(i.number);
      const rel = relieving.get(i.number);
      return {
        number: i.number,
        title: i.title,
        files: hotOverlap(i, hot),
        ...(pin === undefined ? {} : { pin }),
        ...(rel === undefined ? {} : { relieving: rel }),
      };
    }),
    wide,
  });
}

/** The builds held on hot files in `repoId` as the picker last said, if any. */
export function standingHot(
  repoId: string,
): { at: string; holds: readonly HotHold[]; wide: readonly WidePull[] } | undefined {
  return standing.get(repoId);
}

/** The hot files as the tick line says them: `src/http/mcp.ts=61 docs/MCP.md=54`, hottest first. */
export function hotWords(hot: ReadonlyMap<string, number>): string {
  return [...hot]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([path, n]) => `${path}=${n}`)
    .join(" ");
}

/** One sentence for a held build: `#12 waits: src/http/mcp.ts is in 6 open pulls (hot at 5).` */
export function hotSays(hold: HotHold): string {
  if (hold.pin !== undefined) return `#${hold.number} waits: ${hold.pin.byName} holds new work on ${hold.pin.path}.`;
  if (hold.relieving !== undefined)
    return `#${hold.number} waits: ${hold.relieving.path} is already being relieved by #${hold.relieving.by}.`;
  const files = hold.files
    .slice(0, 3)
    .map((f) => `${f.path} is in ${f.pulls} open pulls`)
    .join(", ");
  return `#${hold.number} waits: ${files === "" ? "a file it names is hot" : files} (hot at ${HOT_PULLS}).`;
}

/** Every learned open pull with its files, per repository; memory only, never git (#11454). */
export function learnedPulls(): { repoId: string; number: number; files: readonly string[] }[] {
  const out: { repoId: string; number: number; files: readonly string[] }[] = [];
  for (const [repoId, pulls] of touched) for (const p of pulls.values()) out.push({ repoId, number: p.number, files: p.files });
  return out;
}

/** What a thread that does not learn the pulls' files holds of them: each repository's, as plain data (`engine/observed.ts`). */
export const observedTouched = (): Map<string, unknown> => new Map([...touched].map(([repoId, pulls]) => [repoId, [...pulls]]));
export function adoptTouched(repoId: string, value: unknown): void {
  if (value === undefined) touched.delete(repoId);
  else touched.set(repoId, new Map(value as [string, { at: string; number: number; files: readonly string[] }][]));
}
export const observedStandingWide = (): Map<string, unknown> => new Map(standingWideBy);
export function adoptStandingWide(repoId: string, value: unknown): void {
  if (value === undefined) standingWideBy.delete(repoId);
  else standingWideBy.set(repoId, value as { at: string; wide: readonly WidePull[] });
}
export const observedStanding = (): Map<string, unknown> => new Map(standing);
export function adoptStanding(repoId: string, value: unknown): void {
  if (value === undefined) standing.delete(repoId);
  else standing.set(repoId, value as { at: string; holds: readonly HotHold[]; wide: readonly WidePull[] });
}
