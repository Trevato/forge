/**
 * A default-branch check that fails at most two tests re-runs those tests
 * once, alone, before main counts as red (#6643). Passing alone is a flake:
 * the check is green, the flake is recorded, and a test that flakes twice in
 * a week gets one issue for its file. A test that fails alone too, or a red
 * that is not a pair of named tests (a build error, a timeout), stays red.
 *
 * Plain lines in, commands and rows out. The names come from the repository's
 * own output, so each is checked before it reaches a shell, and quoted there.
 */

import type { Database } from "bun:sqlite";
import { createIssue, setIssueLabels } from "../core/issues.ts";
import type { Repo } from "../core/repos.ts";
import type { EventBus } from "../core/events.ts";
import { id } from "../kernel/id.ts";
import type { CheckDetail } from "../core/runs.ts";
import { importsOf } from "./tiers.ts";
import { isSummaryLine } from "./bun-test.ts";

/** The most failures that are re-run; more is a broken main, not a flake. */
export const MAX_RERUN = 2;

/** A test that flakes this often in {@link WINDOW_MS} is filed. */
export const FILE_AT = 2;
export const WINDOW_MS = 7 * 24 * 3_600_000;

const HEADER = /^(\S+\.test\.[cm]?[jt]sx?):$/;
const FAIL = /^\(fail\) (.+?)(?: \[[0-9.]+m?s\])?(?: \[shard [0-9]+\])?$/;
const PATH = /^[\w@./+-]{1,200}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const CONTROL_G = new RegExp(CONTROL.source, "g");
const NAME_MAX = 300;

export interface Flaky {
  readonly file: string;
  readonly name: string;
  /** How long the failed attempt took, when the log said (#7560: the budget watcher's p95). */
  readonly ms?: number;
}

const FAIL_TIME = /^\(fail\) .+? \[([0-9.]+)(m?s)\]/;
/** The milliseconds a `(fail) name [1.2ms]` line says, or undefined. */
export function failMs(line: string): number | undefined {
  const m = FAIL_TIME.exec(line);
  if (m === null) return undefined;
  const n = Number(m[1]) * (m[2] === "s" ? 1000 : 1);
  return Number.isFinite(n) ? Math.round(n) : undefined;
}
const withMs = (t: Flaky, ms: number | undefined): Flaky => (ms === undefined ? t : { ...t, ms });

/**
 * The tests a failed check can re-run alone: at most {@link MAX_RERUN}
 * failures, every one named with the file whose report printed it. Anything
 * else (a hook, an unnamed failure, more failures) is undefined — red.
 */
export function rerunnable(
  lines: readonly string[],
  detail: CheckDetail | undefined,
): Flaky[] | undefined {
  if (detail === undefined || detail.failed < 1 || detail.failed > MAX_RERUN) return undefined;
  if (detail.names.length !== detail.failed) return undefined;
  const found = new Map<string, string>();
  const took = new Map<string, number>();
  let file: string | undefined;
  for (const line of lines) {
    const header = HEADER.exec(line);
    if (header) {
      file = header[1];
      continue;
    }
    const name = FAIL.exec(line)?.[1];
    if (name !== undefined && detail.names.includes(name) && !found.has(name) && file !== undefined) {
      found.set(name, file);
      const ms = failMs(line);
      if (ms !== undefined) took.set(name, ms);
    }
  }
  const out: Flaky[] = [];
  for (const name of detail.names) {
    const at = found.get(name);
    if (
      at === undefined ||
      !PATH.test(at) ||
      name.length > NAME_MAX ||
      CONTROL.test(name) ||
      name.includes("(unnamed)") ||
      name.includes("(timeout)")
    )
      return undefined;
    out.push(withMs({ file: at, name: name }, took.get(name)));
  }
  return out;
}

/** Files that shape every test run: a pull changing one owns any red. */
const SHAPING = /(^|\/)(package\.json|bun\.lock|bun\.lockb|bunfig\.toml|tsconfig[^/]*\.json|forge\.json|\.env[^/]*)$/;
const EXTENSIONS = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", "/index.ts", "/index.tsx", "/index.js"];
const IMPORT_FILES_MAX = 2000;

/**
 * Whether a failed test's file is the pull's to answer for: it, or any
 * repository file it imports (followed to the end), is among the changed
 * paths, or a file that shapes every run changed. Conservative: an import that
 * resolves to no readable file, or a closure too large to walk, counts as
 * touched, so only a provably unrelated red is re-run.
 */
export function touchedByPull(
  file: string,
  changed: readonly string[],
  read: (path: string) => string | undefined,
): boolean {
  const diff = new Set(changed);
  if (changed.some((c) => SHAPING.test(c))) return true;
  const seen = new Set<string>();
  const queue = [file];
  while (queue.length > 0) {
    const at = queue.pop()!;
    if (seen.has(at)) continue;
    if (seen.size >= IMPORT_FILES_MAX) return true;
    seen.add(at);
    if (diff.has(at)) return true;
    const source = read(at);
    if (source === undefined) return true;
    for (const spec of importsOf(source, at)) {
      const candidates = EXTENSIONS.map((e) => spec + e);
      if (candidates.some((c) => diff.has(c))) return true;
      const real = candidates.find((c) => read(c) !== undefined);
      if (real === undefined) return true;
      queue.push(real);
    }
  }
  return false;
}

/**
 * Whether the pull answers for a red: any failed test touched, or no list of
 * changed paths at all (the diff failed), and nothing is re-run.
 */
export function pullOwnsRed(
  tests: readonly Flaky[],
  changed: readonly string[] | undefined,
  read: (path: string) => string | undefined,
): boolean {
  return changed === undefined || tests.some((t) => touchedByPull(t.file, changed, read));
}

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const quote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * `bun test` of the one test, anchored so a sibling that contains its name is
 * not run: bun joins a describe's names with a space.
 */
export function rerunCommand(test: Flaky): string {
  const pattern = `^${escapeRegex(test.name.split(" > ").join(" "))}$`;
  return `bun test ${quote(test.file)} -t ${quote(pattern)}`;
}

/**
 * Whether the re-run's own output says exactly one test ran and none failed:
 * a pattern that matched nothing exits 0.
 */
export function passedAlone(lines: readonly string[]): boolean {
  let pass = 0;
  let fail = 0;
  for (const line of lines) {
    const p = /^\s*(\d+) pass$/.exec(line);
    if (p) pass += Number(p[1]);
    const f = /^\s*(\d+) fail$/.exec(line);
    if (f) fail += Number(f[1]);
  }
  return pass === 1 && fail === 0;
}

/** The marker a shard runner prints when a crash outside any test was green on its one re-run (#7781). */
export const CRASH_FLAKE = "test-shards: crash flake";

/** The test name a crash outside any test is recorded under: stable per message, so a repeat counts. */
export const CRASH_NAME = "(crash outside any test)";

/**
 * The marker line for a shard whose quoted crash (`  │ ` lines) went green
 * on its re-run: the first error line, cleaned and cut, so one cause counts
 * as one flake.
 */
export function crashFlakeLine(where: string, quoted: string): string {
  const cause =
    quoted
      .split("\n")
      .map((l) => l.replace(/^ {2}│ /, "").trim())
      .find((l) => /^\w*Error\b|^error\b/.test(l)) ?? "unhandled error";
  const clean = cause.replace(CONTROL_G, " ").replace(/[0-9]+/g, "#").slice(0, 120);
  return `${CRASH_FLAKE} ${where}: ${clean}`;
}

/** Crashes a check's log says were green on a re-run, as flakes with no file (so no issue is filed). */
export function crashFlakes(lines: readonly string[]): Flaky[] {
  const seen = new Set<string>();
  const out: Flaky[] = [];
  for (const line of lines) {
    const at = line.indexOf(`${CRASH_FLAKE} `);
    if (at < 0) continue;
    const m = /^[0-9]+\/[0-9]+: (.{1,120})$/.exec(line.slice(at + CRASH_FLAKE.length + 1).trim());
    if (m === null || CONTROL.test(m[1]!)) continue;
    const name = `${CRASH_NAME} ${m[1]}`;
    if (!seen.has(name)) out.push({ file: "", name });
    seen.add(name);
  }
  return out;
}

/**
 * Record the crash flakes a check's log names, but only for a check that
 * passed: a red check records nothing. Returns how many were recorded.
 */
export function recordCrashFlakes(
  db: Database,
  bus: EventBus,
  repo: Pick<Repo, "id" | "ownerId">,
  lines: readonly string[],
  ref: { runId: string; commit: string; pull?: boolean },
  ok: boolean,
): number {
  if (!ok) return 0;
  const crashes = crashFlakes(lines);
  if (crashes.length > 0) recordFlakes(db, bus, repo, crashes, ref);
  return crashes.length;
}

export const flakeTitle = (name: string): string => `Flaky test: ${name.slice(0, 200)}`;

/**
 * Record each flake; a test that has now flaked {@link FILE_AT} times in the
 * week gets an issue for its file unless one by its name is open. Returns the
 * issue numbers opened.
 */
export function recordFlakes(
  db: Database,
  bus: EventBus,
  repo: Pick<Repo, "id" | "ownerId">,
  tests: readonly Flaky[],
  ref: { runId: string; commit: string; pull?: boolean },
  now = Date.now(),
): number[] {
  const where = ref.pull === true ? "a pull's check" : "main's check";
  const opened: number[] = [];
  for (const t of tests) {
    db.query(
      "INSERT INTO check_flake (id, repo_id, run_id, commit_oid, test, file, at, ms) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
    ).run(id(), repo.id, ref.runId, ref.commit, t.name, t.file, new Date(now).toISOString(), t.ms ?? null);
    const since = new Date(now - WINDOW_MS).toISOString();
    const count = db
      .query<{ n: number }, [string, string, string]>(
        "SELECT COUNT(*) AS n FROM check_flake WHERE repo_id = ?1 AND test = ?2 AND at >= ?3",
      )
      .get(repo.id, t.name, since)!.n;
    // No issue without a file: the "Files:" line is what routes it to a builder.
    if (count < FILE_AT || t.file === "") continue;
    const filed = fileIssueOnce(db, bus, repo, {
      title: flakeTitle(t.name),
      body:
        `_Filed by the check runner from a check log, not written by a person._\n\n` +
        `\`${t.name}\` in \`${t.file}\` failed in ${where} and passed when run alone, ${count} times in 7 days ` +
        `(latest: check run ${ref.runId}, ${ref.commit.slice(0, 7)}). The check stayed green each time. ` +
        `Find what it depends on: time, load, order, or shared state.\n\nFiles: ${t.file}`,
    });
    if (filed.opened) opened.push(filed.number);
  }
  return opened;
}

/**
 * One open issue per title: the open one when there is one (`opened` false),
 * else a new one, announced on the bus. Number 0 when it could not be made.
 */
export function fileIssueOnce(
  db: Database,
  bus: EventBus,
  repo: Pick<Repo, "id" | "ownerId">,
  issue: { title: string; body: string; labelId?: string },
): { number: number; opened: boolean } {
  const open = db
    .query<{ number: number }, [string, string]>(
      "SELECT number FROM issue WHERE repo_id = ?1 AND title = ?2 AND state = 'open' LIMIT 1",
    )
    .get(repo.id, issue.title);
  if (open !== null) return { number: open.number, opened: false };
  const made = createIssue(db, { repoId: repo.id, authorId: repo.ownerId, title: issue.title, body: issue.body });
  if (!made.ok) return { number: 0, opened: false };
  if (issue.labelId !== undefined) setIssueLabels(db, made.value.id, [issue.labelId]);
  bus.append({
    kind: "issue.opened",
    repoId: repo.id,
    actorId: repo.ownerId,
    payload: { number: made.value.number },
  });
  return { number: made.value.number, opened: true };
}

/**
 * Every failing test of a `bun test` log with the file whose report printed
 * it, once each, in order. Bun's closing summary repeats the failures after
 * the last file; from its first line until the next header a `(fail)` line
 * has no file, and is dropped rather than given to the last one printed.
 */
export function failedTests(lines: readonly string[]): Flaky[] {
  const out: Flaky[] = [];
  const seen = new Set<string>();
  let file: string | undefined;
  for (const line of lines) {
    const header = HEADER.exec(line);
    if (header) {
      file = header[1]!.replace(/^\.\//, "");
      continue;
    }
    if (isSummaryLine(line)) {
      file = undefined;
      continue;
    }
    const name = FAIL.exec(line)?.[1];
    if (name === undefined || file === undefined || !PATH.test(file)) continue;
    if (name.length > NAME_MAX || CONTROL.test(name) || seen.has(`${file}\0${name}`)) continue;
    seen.add(`${file}\0${name}`);
    out.push(withMs({ file, name }, failMs(line)));
  }
  return out;
}

/** What a red queue verdict says of its tests: each failing one with its file, and the files it learned. */
export interface QueueRed {
  readonly tests?: { readonly failing: readonly { readonly name: string; readonly file?: string }[] };
  readonly learn: readonly string[];
}

/**
 * Record the tests a shorter queue prefix failed that a longer green prefix
 * held. A failing test carries the file the gate saw it run in; without one,
 * the file is known only when the verdicts learned exactly one, and with
 * none the flake is kept without a file and no issue is filed for it.
 */
export function recordQueueFlakes(
  db: Database,
  bus: EventBus,
  repo: Pick<Repo, "id" | "ownerId">,
  reds: readonly QueueRed[],
  tip: string,
  now = Date.now(),
): number[] {
  const failing = reds.flatMap((r) => r.tests?.failing ?? []);
  if (failing.length === 0) return [];
  const files = [...new Set(reds.flatMap((r) => r.learn))];
  const only = files.length === 1 && PATH.test(files[0]!) ? files[0]! : "";
  const seen = new Set<string>();
  const tests = failing
    .filter((t) => t.name.length <= NAME_MAX && !CONTROL.test(t.name))
    .map((t) => ({ file: t.file !== undefined && PATH.test(t.file) ? t.file : only, name: t.name }))
    .filter((t) => !seen.has(`${t.file}\0${t.name}`) && seen.add(`${t.file}\0${t.name}`));
  return recordFlakes(db, bus, repo, tests, { runId: `gate-${tip.slice(0, 12)}`, commit: tip }, now);
}

export interface FlakeRow {
  readonly repo: string;
  readonly test: string;
  readonly file: string;
  readonly count: number;
  readonly lastCommit: string;
  readonly last: string;
}

/** A test that flakes this often in the week needs a person, not a note. */
export const NEEDS_AT = 3;

/** The tests that flaked {@link NEEDS_AT} times or more, one need each for the attention list. */
export function flakeNeeds(rows: readonly FlakeRow[]): string[] {
  return rows
    .filter((r) => r.count >= NEEDS_AT)
    .map((r) => `flaky: ${r.test} failed and passed alone ${r.count} times this week (${r.repo})`);
}

/** The flake list as one line for the board and the terminal; null when the week had none. */
export function flakeLine(rows: readonly FlakeRow[], shown = 3): string | null {
  if (rows.length === 0) return null;
  const top = rows.slice(0, shown).map((r) => `${r.test} ×${r.count} (${r.repo})`);
  const more = rows.length - top.length;
  return `${top.join("; ")}${more > 0 ? ` and ${more} more` : ""}`;
}

/** The week's flake list, most frequent first: one query, read by the vitals. */
export function flakeList(db: Database, now: number, limit = 20): FlakeRow[] {
  return db
    .query<FlakeRow, [string, number]>(
      `SELECT u.username || '/' || r.name AS repo, f.test AS test, f.file AS file,
              COUNT(*) AS count, MAX(f.at) AS last,
              (SELECT commit_oid FROM check_flake g
                WHERE g.repo_id = f.repo_id AND g.test = f.test ORDER BY g.at DESC LIMIT 1) AS lastCommit
         FROM check_flake f
         JOIN repo r ON r.id = f.repo_id
         JOIN user u ON u.id = r.owner_id
        WHERE f.at >= ?1
        GROUP BY f.repo_id, f.test
        ORDER BY count DESC, last DESC
        LIMIT ?2`,
    )
    .all(new Date(now - WINDOW_MS).toISOString(), limit);
}
