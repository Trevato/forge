/**
 * The hot-file WIP limit (#5934, #5924 step 3): a build is not started
 * while a file it expects to touch is already touched by `HOT_PULLS` or
 * more open pulls. One more pull on that file is one more rebase for each
 * of the others when any of them lands; the build waits until the pile
 * drains under the limit.
 *
 * - An issue's expected files are the repository paths its title and body
 *   name (`expectedFiles`): `src/http/mcp.ts`, `docs/MCP.md`.
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

/** A file this many open pulls touch is hot: no new build starts on it. */
export const HOT_PULLS = 5;

/** The most paths read from one issue: a list longer than this is a manifest, not a plan. */
const MAX_EXPECTED = 40;

/** A path with at least one directory and a file extension: `src/http/mcp.ts`. */
const PATH = /(?<![\w./:-])((?:[\w-][\w.-]*\/)+[\w-][\w.-]*\.[A-Za-z0-9]+)(?![\w/])/g;
/** A bare file name in backticks: `README.md`, `forge.json`. */
const QUOTED = /`([\w-][\w.-]*\.[A-Za-z0-9]+)`/g;

/** The repository paths an issue names, in the order it names them, each once. */
export function expectedFiles(issue: Pick<Issue, "title" | "body">): string[] {
  const text = `${issue.title}\n${issue.body}`;
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
const touched = new Map<string, Map<string, { at: string; files: readonly string[] }>>();

const OID = /^[0-9a-f]{40,64}$/;

/**
 * Read the files each open pull of `repo` touches, for any pull whose head
 * moved since it was last read, and forget the pulls no longer open. A pull
 * git cannot answer for touches nothing until it can.
 */
export async function learnPullFiles(app: App, repo: Repo): Promise<void> {
  const ids = app.db
    .query<{ id: string }, [string]>(
      `SELECT p.issue_id AS id FROM pull p JOIN issue i ON i.id = p.issue_id
        WHERE i.repo_id = ?1 AND i.state = 'open' AND p.merged_at IS NULL`,
    )
    .all(repo.id)
    .map((r) => r.id);
  const pulls = joinMany(app.db, [...getIssuesByIds(app.db, ids).values()]);
  const before = touched.get(repo.id) ?? new Map();
  const after = new Map<string, { at: string; files: readonly string[] }>();
  for (const pull of pulls) {
    const at = `${pull.baseOid}...${pull.headOid}`;
    const known = before.get(pull.id);
    if (known !== undefined && known.at === at) {
      after.set(pull.id, known);
      continue;
    }
    if (!OID.test(pull.baseOid) || !OID.test(pull.headOid)) continue;
    const dir = await pullDir(app.db, app.reposRoot, repo, pull);
    const out = await runGitCapture(["diff", "--name-only", "-z", at], { cwd: dir });
    if (out.code !== 0) continue;
    after.set(pull.id, { at, files: out.stdout.split("\0").filter((f) => f !== "") });
  }
  touched.set(repo.id, after);
}

/** Every file of `repo` that `HOT_PULLS` or more open pulls touch, with how many. */
export function hotFiles(repoId: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const { files } of touched.get(repoId)?.values() ?? [])
    for (const file of files) counts.set(file, (counts.get(file) ?? 0) + 1);
  for (const [file, n] of counts) if (n < HOT_PULLS) counts.delete(file);
  return counts;
}

/** The hot files `issue` expects to touch, hottest first. */
export function hotOverlap(
  issue: Pick<Issue, "title" | "body">,
  hot: ReadonlyMap<string, number>,
): HotFile[] {
  if (hot.size === 0) return [];
  return expectedFiles(issue)
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
}

/** What the picker last held on hot files, per repository, and when. */
const standing = new Map<string, { at: string; holds: readonly HotHold[] }>();

/** Remember the builds the picker holds on hot files in `repoId` now; none clears it. */
export function holdHot(repoId: string, issues: readonly Issue[], at = new Date()): void {
  if (issues.length === 0) {
    standing.delete(repoId);
    return;
  }
  const hot = hotFiles(repoId);
  standing.set(repoId, {
    at: at.toISOString(),
    holds: issues.map((i) => ({ number: i.number, title: i.title, files: hotOverlap(i, hot) })),
  });
}

/** The builds held on hot files in `repoId` as the picker last said, if any. */
export function standingHot(repoId: string): { at: string; holds: readonly HotHold[] } | undefined {
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
  const files = hold.files
    .slice(0, 3)
    .map((f) => `${f.path} is in ${f.pulls} open pulls`)
    .join(", ");
  return `#${hold.number} waits: ${files === "" ? "a file it names is hot" : files} (hot at ${HOT_PULLS}).`;
}
