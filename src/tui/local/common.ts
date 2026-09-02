/**
 * What the local screens share: the session (a library root, optionally a
 * workbench to talk to), the task runner that turns a long git command into
 * a spinner and a status line, and the repo walk that finds your clones.
 *
 * The forge's own screens get this from `screens/common.ts`; this file is
 * the same idea for the half of the client that talks to a work tree instead
 * of to a database. Everything drawing-shaped is imported from there rather
 * than repeated — one list cursor, one filter box, one clock.
 */

import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import type { ForgeApi } from "../../cli/api.ts";
import type { GitFailure, LocalResult } from "../../git/local.ts";
import type { Ctx } from "../app/app.ts";
import { G } from "../term/screen.ts";

export interface Local {
  /** Where clones live. Everything below it is scanned for work trees. */
  readonly root: string;
  /** The workbench, when the user is signed in. Pins need it; nothing else. */
  readonly api: ForgeApi | null;
  /** Put text on the system clipboard through the terminal (OSC 52). */
  copy(text: string): void;
}

export interface LocalRepo {
  /** Path relative to the root: "forge.example.com/alice/forge". */
  readonly label: string;
  readonly dir: string;
  readonly owner: string;
  readonly name: string;
}

/**
 * Every work tree under `root`, at most `depth` levels down. Three levels is
 * `<host>/<owner>/<name>` — the layout `forge sync` writes — and it also
 * finds a repo someone cloned by hand one or two levels in, which is exactly
 * the repo they would be annoyed not to see here.
 */
export async function findRepos(root: string, depth = 3): Promise<LocalRepo[]> {
  const out: LocalRepo[] = [];
  const walk = async (dir: string, left: number): Promise<void> => {
    if (await Bun.file(join(dir, ".git/HEAD")).exists()) {
      const label = relative(root, dir) || dir;
      const parts = label.split("/");
      out.push({
        label,
        dir,
        owner: parts[parts.length - 2] ?? "",
        name: parts[parts.length - 1] ?? label,
      });
      return; // never descend into a repo: submodules are the repo's business
    }
    if (left === 0) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries)
      if (entry.isDirectory() && !entry.name.startsWith("."))
        await walk(join(dir, entry.name), left - 1);
  };
  await walk(root, depth);
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

// ── tasks ────────────────────────────────────────────────────────────────

let inFlight = 0;
let waiters: (() => void)[] = [];

/** True while any local git task is running — the spinner's condition. */
export function localBusy(): boolean {
  return inFlight > 0;
}

/**
 * Resolves once no local task is in flight. The app loop settles on
 * `App.busy`, which only covers a screen's `load`; a key that starts a fetch
 * needs its own seam, and a test that polls a screen's private state is a
 * test that breaks when the screen is rewritten.
 */
export function localIdle(): Promise<void> {
  if (inFlight === 0) return Promise.resolve();
  return new Promise((resolve) => waiters.push(resolve));
}

/**
 * Count a promise as local work. A key that starts a read outside a `Task` —
 * the preview pane following the cursor — still has to be visible to the
 * spinner and to the test harness, and this is the one line that does it.
 */
export async function track<T>(work: Promise<T>): Promise<T> {
  inFlight++;
  try {
    return await work;
  } finally {
    inFlight--;
    settle();
  }
}

function settle(): void {
  if (inFlight > 0) return;
  const pending = waiters;
  waiters = [];
  for (const resolve of pending) resolve();
}

/**
 * One long git operation at a time, per screen. `note` is the progress line
 * the footer shows; a failure becomes a toast carrying git's own first line
 * of stderr, because git's message is nearly always the better one.
 */
export class Task {
  busy = false;
  note = "";

  constructor(private readonly ctx: Ctx) {}

  /** True when a task is running and the screen should refuse new work. */
  get blocked(): boolean {
    return this.busy;
  }

  run<T>(
    label: string,
    work: (progress: (text: string) => void) => Promise<LocalResult<T>>,
    then?: (value: T) => void | Promise<void>,
  ): void {
    if (this.busy) return;
    this.busy = true;
    this.note = label;
    inFlight++;
    this.ctx.invalidate();
    const progress = (text: string): void => {
      this.note = `${label}: ${text}`;
      this.ctx.invalidate();
    };
    void (async () => {
      try {
        const result = await work(progress);
        if (!result.ok) this.ctx.toast(failureText(result.error), "danger");
        else if (then !== undefined) await then(result.value);
      } catch (error) {
        this.ctx.toast(
          error instanceof Error ? error.message : String(error),
          "danger",
        );
      } finally {
        this.busy = false;
        this.note = "";
        inFlight--;
        this.ctx.invalidate();
        settle();
      }
    })();
  }
}

/**
 * A non-git failure in the shape a `Task` reports. The workbench API is the
 * only other thing these screens call, and giving it a second error channel
 * would mean two ways for a screen to say "that did not work".
 */
export function asFailure(message: string, what: string): GitFailure {
  return { code: 1, stderr: message, args: [what] };
}

/** git's own words, first line only — the rest belongs in a log, not a toast. */
export function failureText(failure: GitFailure): string {
  const line = failure.stderr
    .split("\n")
    .map((l) => l.replace(/^(error|fatal|hint):\s*/, "").trim())
    .find((l) => l !== "");
  return line ?? `git ${failure.args[0] ?? ""} failed (${failure.code})`;
}

/**
 * "▲2 ▼1", or "" when the branch is level with its upstream. The glyphs come
 * from the safe set in `term/screen.ts`, so the CLI's report and the TUI say
 * ahead and behind with the same two marks.
 */
export function trackText(ahead: number, behind: number): string {
  const parts: string[] = [];
  if (ahead > 0) parts.push(`${G.up}${ahead}`);
  if (behind > 0) parts.push(`${G.down}${behind}`);
  return parts.join(" ");
}
