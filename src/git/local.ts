/**
 * Git against a working tree on *this* machine.
 *
 * `git/env.ts` is the server's git: a scrubbed environment, no `HOME`, no
 * global config, because a forge process must never inherit an operator's
 * settings. Here the opposite is true. This is the user's own laptop, their
 * own checkout, their own identity — `user.email`, `credential.helper`,
 * `~/.ssh/config`, `commit.gpgsign` all have to apply, or the commits this
 * makes are not the commits they would have made. So the environment is
 * inherited and only three variables are pinned: no interactive prompt (a
 * TUI cannot answer one), no optional index locks (status is polled), and a
 * C locale so the output we parse is the output git documents.
 *
 * Everything below returns a `Result`: a dirty tree, a conflicted rebase and
 * a rejected push are expected outcomes, not defects.
 */

import { err, ok, type Result } from "../kernel/result.ts";
import { parseUnifiedDiff, type Diff, type Hunk } from "./diff.ts";
import type { GitFailure } from "./env.ts";
import { isSafeRef } from "./guard.ts";
import { noteGit } from "../perf/git.ts";
import { gitRecord } from "../perf/live.ts";

export type { GitFailure };
export type LocalResult<T> = Result<T, GitFailure>;

/** The user's environment, with the three variables a TUI must control. */
export function localGitEnv(
  extra?: Record<string, string>,
): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (value !== undefined) base[key] = value;
  return {
    ...base,
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    LC_ALL: "C",
    ...extra,
  };
}

export interface RunOpts {
  readonly cwd: string;
  /** Kill after this long. Network operations pass their own, far larger. */
  readonly timeoutMs?: number;
  readonly stdin?: string | Uint8Array;
  readonly env?: Record<string, string>;
  /** Called with each stderr line — git's progress channel. */
  readonly onProgress?: (line: string) => void;
}

const LOCAL_MS = 30_000;
const NETWORK_MS = 600_000;
const NUL = "\0";

/**
 * One spawn helper for the whole file. stderr is consumed line by line so a
 * long fetch can report progress instead of appearing to hang, and the same
 * text is kept for the failure message.
 */
export async function runLocal(
  args: readonly string[],
  opts: RunOpts,
): Promise<LocalResult<string>> {
  const start = performance.now();
  const proc = Bun.spawn(["git", ...args], {
    cwd: opts.cwd,
    env: localGitEnv(opts.env),
    stdin: opts.stdin === undefined ? "ignore" : new Blob([opts.stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(
    () => proc.kill("SIGKILL"),
    opts.timeoutMs ?? LOCAL_MS,
  );
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      drain(proc.stderr, opts.onProgress),
      proc.exited,
    ]);
    if (code !== 0) return err({ code, stderr: stderr.trim(), args });
    return ok(stdout);
  } finally {
    clearTimeout(timer);
    noteGit(gitRecord, args, start);
  }
}

/**
 * git writes progress with `\r`, not `\n`, so a plain line reader shows
 * nothing until the operation ends. Splitting on both is what makes the
 * status line move.
 */
async function drain(
  stream: ReadableStream<Uint8Array>,
  onLine?: (line: string) => void,
): Promise<string> {
  const decoder = new TextDecoder();
  let all = "";
  let pending = "";
  for await (const chunk of stream) {
    const text = decoder.decode(chunk, { stream: true });
    all += text;
    if (onLine === undefined) continue;
    pending += text;
    const parts = pending.split(/\r\n|\r|\n/);
    pending = parts.pop() ?? "";
    for (const part of parts) if (part.trim() !== "") onLine(part.trim());
  }
  if (onLine !== undefined && pending.trim() !== "") onLine(pending.trim());
  return all;
}

/** `git rev-parse --show-toplevel`: the work-tree root, or an Err. */
export async function repoRoot(dir: string): Promise<LocalResult<string>> {
  const out = await runLocal(["rev-parse", "--show-toplevel"], { cwd: dir });
  return out.ok ? ok(out.value.trim()) : out;
}

export async function isRepo(dir: string): Promise<boolean> {
  return (await repoRoot(dir)).ok;
}

/** When the last fetch landed, from `.git/FETCH_HEAD`'s mtime, else null. */
export async function lastFetch(dir: string): Promise<Date | null> {
  const file = Bun.file(`${dir}/.git/FETCH_HEAD`);
  if (!(await file.exists())) return null;
  return new Date(file.lastModified);
}

// ── status ───────────────────────────────────────────────────────────────

export interface FileEntry {
  readonly path: string;
  /** Where a rename came from, else null. */
  readonly origPath: string | null;
  /** Index-side status letter, `.` when unchanged. */
  readonly index: string;
  /** Work-tree-side status letter, `.` when unchanged. */
  readonly work: string;
  readonly untracked: boolean;
  readonly conflicted: boolean;
}

export interface LocalStatus {
  /** The branch name, or null on a detached HEAD. */
  readonly head: string | null;
  readonly detached: boolean;
  readonly oid: string | null;
  readonly upstream: string | null;
  readonly ahead: number;
  readonly behind: number;
  /** The four sections the work screen draws. A path may be in two. */
  readonly staged: FileEntry[];
  readonly unstaged: FileEntry[];
  readonly untracked: FileEntry[];
  readonly conflicted: FileEntry[];
}

export function isClean(s: LocalStatus): boolean {
  return (
    s.staged.length === 0 &&
    s.unstaged.length === 0 &&
    s.untracked.length === 0 &&
    s.conflicted.length === 0
  );
}

/**
 * `--porcelain=v2 -b -z`. v2 because v1 cannot express a rename's source
 * unambiguously; `-z` because every other separator is a path a user can
 * create. The `# branch.ab` header carries ahead/behind, so the common case
 * costs one spawn rather than two.
 */
export async function status(dir: string): Promise<LocalResult<LocalStatus>> {
  const out = await runLocal(
    ["status", "--porcelain=v2", "--branch", "--untracked-files=all", "-z"],
    { cwd: dir },
  );
  if (!out.ok) return out;
  return ok(parseStatus(out.value));
}

export function parseStatus(raw: string): LocalStatus {
  const fields = raw.split(NUL);
  let head: string | null = null;
  let detached = false;
  let oid: string | null = null;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  const staged: FileEntry[] = [];
  const unstaged: FileEntry[] = [];
  const untracked: FileEntry[] = [];
  const conflicted: FileEntry[] = [];

  for (let i = 0; i < fields.length; i++) {
    const line = fields[i]!;
    if (line === "") continue;
    const kind = line[0];

    if (kind === "#") {
      const [, key, ...rest] = line.split(" ");
      const value = rest.join(" ");
      if (key === "branch.oid") oid = value === "(initial)" ? null : value;
      else if (key === "branch.head") {
        detached = value === "(detached)";
        head = detached ? null : value;
      } else if (key === "branch.upstream") upstream = value;
      else if (key === "branch.ab") {
        const m = /^\+(\d+) -(\d+)$/.exec(value);
        if (m) {
          ahead = Number(m[1]);
          behind = Number(m[2]);
        }
      }
      continue;
    }

    if (kind === "?") {
      untracked.push(entry(line.slice(2), null, ".", "?", true, false));
      continue;
    }
    if (kind === "!") continue; // ignored: never shown

    if (kind === "u") {
      // u XY sub m1 m2 m3 mW h1 h2 h3 path
      const parts = fixed(line, 10);
      const xy = parts[1] ?? "UU";
      conflicted.push(
        entry(parts[10] ?? "", null, xy[0] ?? "U", xy[1] ?? "U", false, true),
      );
      continue;
    }

    if (kind !== "1" && kind !== "2") continue;
    // 1 XY sub mH mI mW hH hI path
    // 2 XY sub mH mI mW hH hI Xscore path  <NUL> origPath
    const parts = fixed(line, kind === "1" ? 8 : 9);
    const xy = parts[1] ?? "..";
    const path = parts[kind === "1" ? 8 : 9] ?? "";
    let origPath: string | null = null;
    if (kind === "2") {
      origPath = fields[i + 1] ?? null;
      i++;
    }
    const x = xy[0] ?? ".";
    const y = xy[1] ?? ".";
    const file = entry(path, origPath, x, y, false, false);
    if (x !== ".") staged.push(file);
    if (y !== ".") unstaged.push(file);
  }

  return {
    head,
    detached,
    oid,
    upstream,
    ahead,
    behind,
    staged,
    unstaged,
    untracked,
    conflicted,
  };
}

/** Split on spaces for exactly `n` leading fields; the rest is one path. */
function fixed(line: string, n: number): string[] {
  const out: string[] = [];
  let at = 0;
  for (let i = 0; i < n; i++) {
    const space = line.indexOf(" ", at);
    if (space < 0) {
      out.push(line.slice(at));
      return out;
    }
    out.push(line.slice(at, space));
    at = space + 1;
  }
  out.push(line.slice(at));
  return out;
}

function entry(
  path: string,
  origPath: string | null,
  index: string,
  work: string,
  untracked: boolean,
  conflicted: boolean,
): FileEntry {
  return { path, origPath, index, work, untracked, conflicted };
}

/** The two-letter summary a file row shows: "M.", ".M", "??", "UU". */
export function statusLetters(f: FileEntry): string {
  return f.untracked ? "??" : `${f.index}${f.work}`;
}

// ── diffs ────────────────────────────────────────────────────────────────

/**
 * The diff flags a *client* needs, which are not the server's. On someone's
 * own machine `diff.external`, `diff.noprefix` and a pager are all live, and
 * every one of them breaks a patch we are about to hand back to `git apply`:
 * an external differ produces text we did not ask for, and `noprefix` drops
 * the `a/`,`b/` that apply expects. So both are overridden explicitly rather
 * than hoped about.
 */
const DIFF_FLAGS = [
  "--no-color",
  "--no-ext-diff",
  "--src-prefix=a/",
  "--dst-prefix=b/",
  "--histogram",
  "--find-renames=50%",
] as const;

export interface DiffOpts {
  /** The index against HEAD, rather than the work tree against the index. */
  readonly staged?: boolean;
  readonly path?: string;
  /** An untracked file has no index side; diff it against /dev/null. */
  readonly untracked?: boolean;
  /**
   * An unmerged path, diffed against HEAD rather than against the index.
   *
   * A plain `git diff` on a conflicted file emits a combined diff
   * (`diff --cc`), whose two-column line prefixes are not the unified format
   * anything downstream reads — so the preview came up empty on exactly the
   * file the reader most needed to see. Against HEAD it is an ordinary
   * unified diff of the work tree, conflict markers and all, which is the
   * thing a person is about to go and edit.
   */
  readonly conflicted?: boolean;
  /** Context lines. Never 0 — a zero-context patch needs --unidiff-zero. */
  readonly context?: number;
}

/**
 * A `Diff` for the work screen. The untracked case is `--no-index`, whose
 * exit code is data (1 = the files differ), not a failure.
 */
export async function diff(
  dir: string,
  opts: DiffOpts = {},
): Promise<LocalResult<Diff>> {
  const context = `-U${Math.max(1, opts.context ?? 3)}`;
  if (opts.untracked === true && opts.path !== undefined) {
    const args = [
      "diff",
      ...DIFF_FLAGS,
      context,
      "--no-index",
      "--",
      "/dev/null",
      opts.path,
    ];
    const start = performance.now();
    const proc = Bun.spawn(["git", ...args], {
      cwd: dir,
      env: localGitEnv(),
      stdout: "pipe",
      stderr: "pipe",
    });
    let text: string, stderr: string, code: number;
    try {
      [text, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
    } finally {
      noteGit(gitRecord, args, start);
    }
    if (code > 1) return err({ code, stderr: stderr.trim(), args });
    return ok(parseUnifiedDiff(text));
  }
  const args = [
    "diff",
    ...DIFF_FLAGS,
    context,
    ...(opts.staged === true ? ["--cached"] : []),
    ...(opts.conflicted === true ? ["HEAD"] : []),
    "--",
    ...(opts.path === undefined ? [] : [opts.path]),
  ];
  const out = await runLocal(args, { cwd: dir, timeoutMs: 60_000 });
  return out.ok ? ok(parseUnifiedDiff(out.value)) : out;
}

/** A commit against its first parent — the log screen's detail pane. */
export async function commitDiff(
  dir: string,
  oid: string,
): Promise<LocalResult<Diff>> {
  if (!isSafeRef(oid)) return unsafe("show", oid);
  const out = await runLocal(
    ["show", "-p", "--first-parent", "-m", ...DIFF_FLAGS, "--format=", oid],
    { cwd: dir, timeoutMs: 60_000 },
  );
  return out.ok ? ok(parseUnifiedDiff(out.value)) : out;
}

// ── staging ──────────────────────────────────────────────────────────────

export async function stagePath(
  dir: string,
  path: string,
): Promise<LocalResult<void>> {
  return done(await runLocal(["add", "--", path], { cwd: dir }));
}

export async function stageAll(dir: string): Promise<LocalResult<void>> {
  return done(await runLocal(["add", "--all", "--", "."], { cwd: dir }));
}

export async function unstagePath(
  dir: string,
  path: string,
): Promise<LocalResult<void>> {
  // `restore --staged` says what it does, unlike `reset`. On a repo with no
  // commits there is no HEAD to restore from, so fall back to dropping the
  // index entry — which is what unstaging a first-ever file means.
  const out = await runLocal(["restore", "--staged", "--", path], { cwd: dir });
  if (out.ok) return ok();
  return done(
    await runLocal(["rm", "--cached", "-r", "--", path], { cwd: dir }),
  );
}

export async function unstageAll(dir: string): Promise<LocalResult<void>> {
  const out = await runLocal(["restore", "--staged", "--", "."], { cwd: dir });
  if (out.ok) return ok();
  return done(
    await runLocal(["rm", "--cached", "-r", "--", "."], { cwd: dir }),
  );
}

/**
 * Throw work away. An untracked path is deleted; a tracked one is restored
 * from HEAD in both the index and the work tree, so "discard" means the same
 * thing whether the change was staged or not. Callers confirm first — this
 * does not ask.
 */
export async function discardPath(
  dir: string,
  path: string,
  opts: { untracked?: boolean; unstagedOnly?: boolean } = {},
): Promise<LocalResult<void>> {
  if (opts.untracked === true)
    return done(await runLocal(["clean", "-fd", "--", path], { cwd: dir }));
  // The unstaged half only: the working file goes back to the index, and
  // whatever is staged stays staged.
  if (opts.unstagedOnly === true)
    return done(
      await runLocal(["restore", "--worktree", "--", path], { cwd: dir }),
    );
  const out = await runLocal(
    ["restore", "--staged", "--worktree", "--source=HEAD", "--", path],
    { cwd: dir },
  );
  if (out.ok) return ok();
  return done(await runLocal(["checkout", "--", path], { cwd: dir }));
}

// ── hunks ────────────────────────────────────────────────────────────────

/**
 * A one-hunk patch, rebuilt from the parsed model. This is the whole trick
 * behind hunk staging: git's own `apply` does the work, so the only thing we
 * must get right is the text — the `a/`,`b/` header, the `@@` counts exactly
 * as git reported them, and the `+`/`-`/space marker the parser stripped.
 */
export function hunkPatch(path: string, hunk: Hunk, origPath?: string): string {
  const from = origPath ?? path;
  // The original `diff --git` preamble is replaced rather than reused: for an
  // added or deleted file it carries `new file mode` and a `/dev/null` side,
  // which confuse apply once the patch is only one hunk of the whole.
  const head = `diff --git a/${from} b/${path}\n--- a/${from}\n+++ b/${path}\n`;
  // Counts are recomputed, never trusted. They are correct as git printed
  // them for a whole hunk — but the rule that a hunk header must describe the
  // body *below it* is the rule that makes line-level staging possible later,
  // and it costs two reduces to hold now.
  const oldLines = hunk.lines.filter((l) => l.kind !== "add").length;
  const newLines = hunk.lines.filter((l) => l.kind !== "del").length;
  const counts =
    `@@ -${hunk.oldStart},${oldLines} +${hunk.newStart},${newLines} @@` +
    (hunk.section === "" ? "" : ` ${hunk.section}`);
  const body = hunk.lines
    .map((line) => {
      const marker =
        line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ";
      return (
        marker +
        line.content +
        (line.noNewline ? "\n\\ No newline at end of file" : "")
      );
    })
    .join("\n");
  return `${head}${counts}\n${body}\n`;
}

async function apply(
  dir: string,
  patch: string,
  flags: readonly string[],
): Promise<LocalResult<void>> {
  return done(
    await runLocal(["apply", "--whitespace=nowarn", ...flags, "-"], {
      cwd: dir,
      stdin: patch,
    }),
  );
}

/** Stage one hunk of the *unstaged* diff. */
export async function stageHunk(
  dir: string,
  path: string,
  hunk: Hunk,
  origPath?: string,
): Promise<LocalResult<void>> {
  return apply(dir, hunkPatch(path, hunk, origPath), ["--cached"]);
}

/** Unstage one hunk of the *staged* diff: the same patch, reversed. */
export async function unstageHunk(
  dir: string,
  path: string,
  hunk: Hunk,
  origPath?: string,
): Promise<LocalResult<void>> {
  return apply(dir, hunkPatch(path, hunk, origPath), ["--cached", "-R"]);
}

/** Throw one hunk of the work tree away. Confirmed by the caller. */
export async function discardHunk(
  dir: string,
  path: string,
  hunk: Hunk,
  origPath?: string,
): Promise<LocalResult<void>> {
  return apply(dir, hunkPatch(path, hunk, origPath), ["-R"]);
}

// ── commits ──────────────────────────────────────────────────────────────

export async function commit(
  dir: string,
  message: string,
  opts: { amend?: boolean; allowEmpty?: boolean } = {},
): Promise<LocalResult<string>> {
  // The message goes in on stdin: a subject with a quote, a backtick or a
  // leading dash is a message, never an argument.
  const out = await runLocal(
    [
      "commit",
      ...(opts.amend === true ? ["--amend"] : []),
      ...(opts.allowEmpty === true ? ["--allow-empty"] : []),
      "--cleanup=strip",
      "--file=-",
    ],
    { cwd: dir, stdin: message },
  );
  if (!out.ok) return out;
  const head = await runLocal(["rev-parse", "HEAD"], { cwd: dir });
  return head.ok ? ok(head.value.trim()) : head;
}

/** The message of HEAD — what an amend seeds the editor with. */
export async function headMessage(dir: string): Promise<LocalResult<string>> {
  const out = await runLocal(["log", "-1", "--format=%B"], { cwd: dir });
  return out.ok ? ok(out.value.replace(/\n+$/, "")) : out;
}

// ── log ──────────────────────────────────────────────────────────────────

export interface LocalCommit {
  readonly oid: string;
  readonly short: string;
  readonly author: string;
  readonly email: string;
  readonly date: string;
  readonly subject: string;
  readonly parents: string[];
  /** The lane art for this row, computed here — see `graphLanes`. */
  readonly graph: string;
  /** Decorations: "HEAD -> main, origin/main". */
  readonly refs: string;
}

export interface LogOpts {
  readonly ref?: string;
  readonly limit?: number;
  readonly path?: string;
}

const FS = "\x1f"; // unit separator: cannot appear in a commit header field

/**
 * `--parents`, not `--graph`.
 *
 * `--graph` interleaves ASCII art with the format output: it cannot be
 * framed, cannot be re-laid-out for a narrow pane, and cannot be coloured per
 * lane. lazygit and tig both ask for the parents and assign lanes themselves,
 * and so do we — `graphLanes` below is forty lines and renders correctly at
 * any width, in the theme's own colours.
 */
export async function log(
  dir: string,
  opts: LogOpts = {},
): Promise<LocalResult<LocalCommit[]>> {
  const ref = opts.ref;
  if (ref !== undefined && !isSafeRef(ref)) return unsafe("log", ref);
  const out = await runLocal(
    [
      "log",
      "--parents",
      "--topo-order",
      `--max-count=${clamp(opts.limit ?? 200, 1, 5000)}`,
      `--format=${FS}%H${FS}%h${FS}%P${FS}%an${FS}%ae${FS}%aI${FS}%D${FS}%s`,
      ...(ref === undefined ? [] : [ref]),
      "--",
      ...(opts.path === undefined ? [] : [opts.path]),
    ],
    { cwd: dir, timeoutMs: 60_000 },
  );
  return out.ok ? ok(graphLanes(parseLog(out.value))) : out;
}

/**
 * One line per commit. A line whose field count is wrong is dropped rather
 * than half-parsed: git writes warnings to stdout in some configurations,
 * and a warning that becomes a commit row is a bug you chase for an hour.
 */
export function parseLog(raw: string): LocalCommit[] {
  const commits: LocalCommit[] = [];
  for (const line of raw.split("\n")) {
    const at = line.indexOf(FS);
    if (at < 0) continue;
    const f = line.slice(at + 1).split(FS);
    if (f.length < 8) continue;
    commits.push({
      graph: "",
      oid: f[0] ?? "",
      short: f[1] ?? "",
      parents: (f[2] ?? "").split(" ").filter((p) => p !== ""),
      author: f[3] ?? "",
      email: f[4] ?? "",
      date: f[5] ?? "",
      refs: f[6] ?? "",
      subject: f[7] ?? "",
    });
  }
  return commits;
}

/**
 * Assign each commit a column and draw it.
 *
 * A lane is "a commit we are still waiting to see". Walking the log in order:
 * the current commit takes the first lane expecting it (or a new one), its
 * first parent inherits that lane, and any further parents open lanes of
 * their own. The row is then one cell per lane: `●` for this commit, `│` for a
 * lane passing through, a corner where a lane begins or ends at this row,
 * and a space for an empty one. The corners point at the commit — `╮` and
 * `╯` for a lane to its right, `╭` and `╰` for one to its left — so a merge
 * and a branch point can be told apart at a glance.
 *
 * This is the honest 80% of a graph: it shows how many independent lines of
 * history are in flight and which one you are on, without the diagonal
 * connector rows that make a log unscrollable in a 30-column pane.
 */
export function graphLanes(commits: readonly LocalCommit[]): LocalCommit[] {
  const lanes: (string | null)[] = [];
  return commits.map((commit) => {
    let mine = lanes.indexOf(commit.oid);
    if (mine === -1) {
      mine = lanes.indexOf(null);
      if (mine === -1) mine = lanes.push(null) - 1;
      lanes[mine] = commit.oid;
    }
    // Every other lane waiting for this same commit ends here. Without this
    // they wait forever, and a repo where two branches share a parent grows
    // a phantom line of history down the rest of the log.
    const joining = new Set<number>();
    lanes.forEach((lane, i) => {
      if (i !== mine && lane === commit.oid) {
        joining.add(i);
        lanes[i] = null;
      }
    });

    const [first, ...others] = commit.parents;
    lanes[mine] = first ?? null;
    const opening = new Set<number>();
    for (const parent of others) {
      if (lanes.includes(parent)) continue;
      const free = lanes.indexOf(null);
      if (free === -1) opening.add(lanes.push(parent) - 1);
      else {
        lanes[free] = parent;
        opening.add(free);
      }
    }

    const row = lanes
      .map((lane, i) => {
        if (i === mine) return "●";
        if (joining.has(i)) return i < mine ? "╰" : "╯";
        if (opening.has(i)) return i < mine ? "╭" : "╮";
        return lane === null ? " " : "│";
      })
      .join("");
    // Trim trailing empties so a briefly-wide graph does not indent the
    // whole log for the rest of the screen.
    return { ...commit, graph: row.replace(/ +$/, "") };
  });
}

export async function reflog(
  dir: string,
  limit = 100,
): Promise<LocalResult<LocalCommit[]>> {
  const out = await runLocal(
    [
      "reflog",
      `--max-count=${clamp(limit, 1, 1000)}`,
      `--format=${FS}%H${FS}%h${FS}%P${FS}%an${FS}%ae${FS}%aI${FS}%gd${FS}%gs`,
    ],
    { cwd: dir },
  );
  return out.ok ? ok(parseLog(out.value)) : out;
}

// ── branches ─────────────────────────────────────────────────────────────

export interface LocalBranch {
  readonly name: string;
  readonly upstream: string | null;
  readonly ahead: number;
  readonly behind: number;
  /** The upstream ref is gone — the branch was merged and pruned. */
  readonly gone: boolean;
  readonly oid: string;
  readonly date: string;
  readonly subject: string;
  readonly current: boolean;
}

/**
 * Both track fields, because neither alone tells the five upstream states
 * apart: `%(upstream:track)` is empty when a branch is in sync, and
 * `%(upstream:trackshort)` is empty when its upstream is gone. Together with
 * an empty `%(upstream:short)` — the unpushed-branch signal — one process
 * answers everything the branch list shows.
 */
export async function branches(
  dir: string,
): Promise<LocalResult<LocalBranch[]>> {
  const out = await runLocal(
    [
      "for-each-ref",
      "--sort=-committerdate",
      `--format=%(refname:short)${FS}%(upstream:short)${FS}%(upstream:track)` +
        `${FS}%(upstream:trackshort)${FS}%(objectname)` +
        `${FS}%(committerdate:iso-strict)${FS}%(HEAD)${FS}%(subject)`,
      "refs/heads",
    ],
    { cwd: dir },
  );
  if (!out.ok) return out;
  const list: LocalBranch[] = [];
  for (const line of out.value.split("\n")) {
    if (line.trim() === "") continue;
    const f = line.split(FS);
    // A short row is a warning git put on stdout, not a branch.
    if (f.length < 8) continue;
    const track = f[2] ?? "";
    const trackShort = f[3] ?? "";
    const upstream = f[1] ?? "";
    list.push({
      name: f[0] ?? "",
      upstream: upstream === "" ? null : upstream,
      ahead: Number(/ahead (\d+)/.exec(track)?.[1] ?? 0),
      behind: Number(/behind (\d+)/.exec(track)?.[1] ?? 0),
      gone: upstream !== "" && trackShort === "",
      oid: f[4] ?? "",
      date: f[5] ?? "",
      current: (f[6] ?? "") === "*",
      subject: f[7] ?? "",
    });
  }
  return ok(list);
}

export async function checkout(
  dir: string,
  ref: string,
): Promise<LocalResult<void>> {
  if (!isSafeRef(ref)) return unsafe("checkout", ref);
  return done(await runLocal(["checkout", ref, "--"], { cwd: dir }));
}

export async function createBranch(
  dir: string,
  name: string,
  from?: string,
): Promise<LocalResult<void>> {
  if (!isSafeRef(name)) return unsafe("branch", name);
  if (from !== undefined && !isSafeRef(from)) return unsafe("branch", from);
  return done(
    await runLocal(
      ["checkout", "-b", name, ...(from === undefined ? [] : [from]), "--"],
      { cwd: dir },
    ),
  );
}

export async function deleteBranch(
  dir: string,
  name: string,
  force = false,
): Promise<LocalResult<void>> {
  if (!isSafeRef(name)) return unsafe("branch", name);
  return done(
    await runLocal(["branch", force ? "-D" : "-d", name], { cwd: dir }),
  );
}

export async function renameBranch(
  dir: string,
  from: string,
  to: string,
): Promise<LocalResult<void>> {
  if (!isSafeRef(from) || !isSafeRef(to)) return unsafe("branch", to);
  return done(await runLocal(["branch", "-m", from, to], { cwd: dir }));
}

export async function mergeBranch(
  dir: string,
  ref: string,
  opts: { ffOnly?: boolean } = {},
): Promise<LocalResult<void>> {
  if (!isSafeRef(ref)) return unsafe("merge", ref);
  return done(
    await runLocal(
      ["merge", ...(opts.ffOnly === true ? ["--ff-only"] : ["--no-edit"]), ref],
      { cwd: dir, timeoutMs: 120_000 },
    ),
  );
}

/**
 * Is `ancestor` reachable from `descendant`? The safe fast-forward check.
 *
 * git exits 0 for yes, 1 for no and 128 for a bad revision. All three become
 * `false` here, which is the right direction to fail in: a broken repo must
 * not be treated as safe to move.
 */
export async function isAncestor(
  dir: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  if (!isSafeRef(ancestor) || !isSafeRef(descendant)) return false;
  const out = await runLocal(
    ["merge-base", "--is-ancestor", ancestor, descendant],
    { cwd: dir },
  );
  return out.ok;
}

/** Is `oid` a commit object in the repository? One `git cat-file -e`. */
export async function hasCommit(dir: string, oid: string): Promise<boolean> {
  if (!isSafeRef(oid)) return false;
  const out = await runLocal(["cat-file", "-e", `${oid}^{commit}`], {
    cwd: dir,
  });
  return out.ok;
}

/** `rev-list --left-right --count a...b` — what each side has alone. */
export async function aheadBehind(
  dir: string,
  local: string,
  remote: string,
): Promise<LocalResult<{ ahead: number; behind: number }>> {
  if (!isSafeRef(local) || !isSafeRef(remote)) return unsafe("rev-list", local);
  const out = await runLocal(
    ["rev-list", "--left-right", "--count", `${local}...${remote}`],
    { cwd: dir },
  );
  if (!out.ok) return out;
  const [a, b] = out.value.trim().split(/\s+/);
  return ok({ ahead: Number(a ?? 0) || 0, behind: Number(b ?? 0) || 0 });
}

// ── stash ────────────────────────────────────────────────────────────────

export interface Stash {
  readonly index: number;
  readonly ref: string;
  readonly subject: string;
  readonly date: string;
}

export async function stashList(dir: string): Promise<LocalResult<Stash[]>> {
  const out = await runLocal(
    ["stash", "list", `--format=%gd${FS}%gs${FS}%cI`],
    {
      cwd: dir,
    },
  );
  if (!out.ok) return out;
  const list: Stash[] = [];
  for (const line of out.value.split("\n")) {
    if (line.trim() === "") continue;
    const f = line.split(FS);
    list.push({
      index: list.length,
      ref: f[0] ?? "",
      subject: f[1] ?? "",
      date: f[2] ?? "",
    });
  }
  return ok(list);
}

export async function stashPush(
  dir: string,
  message?: string,
  opts: { includeUntracked?: boolean; keepIndex?: boolean } = {},
): Promise<LocalResult<void>> {
  return done(
    await runLocal(
      [
        "stash",
        "push",
        ...(opts.includeUntracked === true ? ["--include-untracked"] : []),
        ...(opts.keepIndex === true ? ["--keep-index"] : []),
        ...(message === undefined || message === ""
          ? []
          : ["--message", message]),
      ],
      { cwd: dir },
    ),
  );
}

/** Stash entries are addressed by index; a ref is never taken from a user. */
function stashRef(index: number): string {
  return `stash@{${Math.max(0, Math.floor(index))}}`;
}

export async function stashPop(
  dir: string,
  index = 0,
): Promise<LocalResult<void>> {
  return done(await runLocal(["stash", "pop", stashRef(index)], { cwd: dir }));
}

export async function stashApply(
  dir: string,
  index = 0,
): Promise<LocalResult<void>> {
  return done(
    await runLocal(["stash", "apply", stashRef(index)], { cwd: dir }),
  );
}

export async function stashDrop(
  dir: string,
  index = 0,
): Promise<LocalResult<void>> {
  return done(await runLocal(["stash", "drop", stashRef(index)], { cwd: dir }));
}

export async function stashDiff(
  dir: string,
  index = 0,
): Promise<LocalResult<Diff>> {
  const out = await runLocal(
    ["stash", "show", "-p", ...DIFF_FLAGS, stashRef(index)],
    { cwd: dir, timeoutMs: 60_000 },
  );
  return out.ok ? ok(parseUnifiedDiff(out.value)) : out;
}

// ── network ──────────────────────────────────────────────────────────────

export interface NetOpts {
  readonly onProgress?: (line: string) => void;
  readonly remote?: string;
  /** Extra environment — how a token reaches git without entering argv. */
  readonly env?: Record<string, string>;
}

/** The run options every network verb shares: a long timeout and the hooks. */
function net(opts: NetOpts): Omit<RunOpts, "cwd"> {
  return {
    timeoutMs: NETWORK_MS,
    ...(opts.onProgress === undefined ? {} : { onProgress: opts.onProgress }),
    ...(opts.env === undefined ? {} : { env: opts.env }),
  };
}

export async function fetch(
  dir: string,
  opts: NetOpts & { prune?: boolean; all?: boolean } = {},
): Promise<LocalResult<void>> {
  const remote = opts.remote;
  if (remote !== undefined && !isSafeRef(remote))
    return unsafe("fetch", remote);
  return done(
    await runLocal(
      [
        "fetch",
        "--progress",
        // Someone else's submodules are not ours to update, and doing it
        // turns one fetch into an unbounded number.
        "--no-recurse-submodules",
        ...(opts.prune === false ? [] : ["--prune"]),
        ...(opts.all === true
          ? ["--all"]
          : remote === undefined
            ? []
            : [remote]),
      ],
      { cwd: dir, ...net(opts) },
    ),
  );
}

/** Only ever `--ff-only`: a pull that can merge is a pull that can conflict. */
export async function pull(
  dir: string,
  opts: NetOpts = {},
): Promise<LocalResult<void>> {
  return done(
    await runLocal(["pull", "--ff-only", "--progress"], {
      cwd: dir,
      ...net(opts),
    }),
  );
}

export interface PushOpts extends NetOpts {
  /** Set the upstream when the branch has none. */
  readonly setUpstream?: boolean;
  /** Opt-in only, and never plain `--force`. */
  readonly forceWithLease?: boolean;
  readonly branch?: string;
}

export async function push(
  dir: string,
  opts: PushOpts = {},
): Promise<LocalResult<void>> {
  const remote = opts.remote ?? "origin";
  if (!isSafeRef(remote)) return unsafe("push", remote);
  const branch = opts.branch;
  if (branch !== undefined && !isSafeRef(branch)) return unsafe("push", branch);
  return done(
    await runLocal(
      [
        "push",
        "--progress",
        ...(opts.forceWithLease === true ? ["--force-with-lease"] : []),
        ...(opts.setUpstream === true ? ["--set-upstream"] : []),
        remote,
        ...(branch === undefined
          ? []
          : [`refs/heads/${branch}:refs/heads/${branch}`]),
      ],
      { cwd: dir, ...net(opts) },
    ),
  );
}

export async function clone(
  url: string,
  dir: string,
  opts: NetOpts & { parent: string },
): Promise<LocalResult<void>> {
  // `--` before the URL: a remote beginning with a dash is a flag otherwise.
  return done(
    await runLocal(["clone", "--progress", "--", url, dir], {
      cwd: opts.parent,
      ...net(opts),
    }),
  );
}

export async function setRemote(
  dir: string,
  name: string,
  url: string,
): Promise<LocalResult<void>> {
  if (!isSafeRef(name)) return unsafe("remote", name);
  const existing = await runLocal(["remote", "get-url", name], { cwd: dir });
  const verb = existing.ok ? "set-url" : "add";
  return done(await runLocal(["remote", verb, name, url], { cwd: dir }));
}

export async function remoteUrl(
  dir: string,
  name = "origin",
): Promise<string | null> {
  if (!isSafeRef(name)) return null;
  const out = await runLocal(["remote", "get-url", name], { cwd: dir });
  return out.ok ? out.value.trim() : null;
}

// ── sequencer ────────────────────────────────────────────────────────────

export type Sequence = "rebase" | "merge" | "cherry-pick" | "revert" | "none";

/**
 * Which multi-step operation the repo is in the middle of. The work screen
 * reads it to decide whether continue/abort are live bindings, which is the
 * difference between a conflict you can finish and one you are stuck in.
 */
export async function sequence(dir: string): Promise<Sequence> {
  const gitDir = await runLocal(["rev-parse", "--absolute-git-dir"], {
    cwd: dir,
  });
  if (!gitDir.ok) return "none";
  const root = gitDir.value.trim();
  const has = (p: string): Promise<boolean> =>
    Bun.file(`${root}/${p}`).exists();
  if (await has("rebase-merge/head-name")) return "rebase";
  if (await has("rebase-apply/next")) return "rebase";
  if (await has("MERGE_HEAD")) return "merge";
  if (await has("CHERRY_PICK_HEAD")) return "cherry-pick";
  if (await has("REVERT_HEAD")) return "revert";
  return "none";
}

export async function rebase(
  dir: string,
  onto: string,
): Promise<LocalResult<void>> {
  if (!isSafeRef(onto)) return unsafe("rebase", onto);
  return done(
    await runLocal(["rebase", onto], { cwd: dir, timeoutMs: 120_000 }),
  );
}

export async function rebaseContinue(dir: string): Promise<LocalResult<void>> {
  // No editor: a TUI cannot host one, and the message is already written.
  return done(
    await runLocal(["rebase", "--continue"], {
      cwd: dir,
      timeoutMs: 120_000,
      env: { GIT_EDITOR: "true" },
    }),
  );
}

export async function rebaseAbort(dir: string): Promise<LocalResult<void>> {
  return done(await runLocal(["rebase", "--abort"], { cwd: dir }));
}

export async function cherryPick(
  dir: string,
  oid: string,
): Promise<LocalResult<void>> {
  if (!isSafeRef(oid)) return unsafe("cherry-pick", oid);
  return done(await runLocal(["cherry-pick", oid], { cwd: dir }));
}

export async function revert(
  dir: string,
  oid: string,
): Promise<LocalResult<void>> {
  if (!isSafeRef(oid)) return unsafe("revert", oid);
  return done(
    await runLocal(["revert", "--no-edit", oid], {
      cwd: dir,
      env: { GIT_EDITOR: "true" },
    }),
  );
}

/** The paths git considers unmerged right now. */
export async function conflicts(dir: string): Promise<LocalResult<string[]>> {
  const out = await runLocal(["diff", "--name-only", "--diff-filter=U", "-z"], {
    cwd: dir,
  });
  if (!out.ok) return out;
  return ok(out.value.split(NUL).filter((p) => p !== ""));
}

// ── helpers ──────────────────────────────────────────────────────────────

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(Math.floor(n), hi));
}

function done(result: LocalResult<string>): LocalResult<void> {
  return result.ok ? ok() : result;
}

/**
 * A rejected argument is reported in the same shape as a git failure, so no
 * caller needs a second error channel for "we would not even run that".
 */
function unsafe<T>(what: string, value: string): LocalResult<T> {
  return err({
    code: -1,
    stderr: `refusing an unsafe argument: ${value}`,
    args: [what],
  });
}
