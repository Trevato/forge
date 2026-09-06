/**
 * Runs, as rows: the list a repository keeps, and the vocabulary every other
 * screen borrows to show one — a pull's checks, an issue's crew activity, an
 * environment's last deploy. One place decides what "failed" looks like so
 * it looks the same everywhere.
 *
 * A run row says four things in order: its state (a dot in the tone and the
 * word), what it was (`deploy production`, `agent robo`), why (the reason),
 * and the one-line summary the worker wrote. Nothing is a colour alone: a
 * queued run reads "queued" beside its hollow dot, and a failed one carries
 * the summary that says what failed.
 */

import { listRepoRuns } from "../../actions/runs.ts";
import { getIssuesByIds, type Issue } from "../../core/issues.ts";
import type { Repo } from "../../core/repos.ts";
import type { Run, RunState } from "../../core/runs.ts";
import { getUsersByIds } from "../../core/users.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Rect, Screen as Surface } from "../term/screen.ts";
import type { Tokens } from "../ui/theme.ts";
import { icon, type IconSet } from "../ui/icons.ts";
import { emptyState, type Tone } from "../ui/widgets.ts";
import type { Session } from "../session.ts";
import {
  ListState,
  drawList,
  errorText,
  hitList,
  live,
  metaOf,
  relTime,
  type ListRow,
} from "./common.ts";
import { runScreen } from "./run.ts";

/** The tone a run's state wears — the same reading on every surface. */
export function runTone(state: RunState): Tone | undefined {
  switch (state) {
    case "ok":
      return "success";
    case "failed":
      return "danger";
    case "running":
      return "attn";
    case "cancelled":
      return "secondary";
    case "queued":
      return undefined;
  }
}

/** Whether the dot is hollow: nothing has happened yet, or nothing will. */
export const runHollow = (state: RunState): boolean =>
  state === "queued" || state === "cancelled";

/** The event kinds a run passes through; what a live run list listens for. */
export const RUN_EVENTS: readonly string[] = [
  "run.queued",
  "run.started",
  "run.finished",
];

/** `deploy production`, `deploy pull #4`, `agent robo`. */
export function runTitle(
  run: Run,
  names: ReadonlyMap<string, { username: string }>,
  set: IconSet = "plain",
): string {
  if (run.kind === "deploy") return `deploy ${envLabel(run.env)}`;
  const who =
    run.actorId === null
      ? "an agent"
      : (names.get(run.actorId)?.username ?? "an agent");
  return set === "nerd" ? `${icon("bot", set)} ${who}` : `agent ${who}`;
}

/** `production`, or `pull #4` — the environment as a person says it. */
export function envLabel(env: string): string {
  return env.startsWith("pull-") ? `pull #${env.slice(5)}` : env || "—";
}

/** The dollars a run spent, or nothing when it spent none. */
export function costText(costUsd: number): string {
  return costUsd > 0 ? `$${costUsd.toFixed(2)}` : "";
}

/** The moment a run is best dated by: when it finished, started, or was made. */
export function runWhen(run: Run): string {
  return run.finishedAt ?? run.startedAt ?? run.createdAt;
}

/**
 * One row per run. The summary sits where a row's secondary text goes, so
 * a failed run's reason is on the row itself and not a keypress away.
 *
 * `issues` names the conversation each run is about — `#4 Say hello` after
 * the title — for a list that spans a repository; a list inside one issue
 * leaves it out, since every row would repeat the page it is on.
 */
export function runRows(
  runs: readonly Run[],
  names: ReadonlyMap<string, { username: string }>,
  set: IconSet = "plain",
  issues?: ReadonlyMap<string, Issue>,
): ListRow[] {
  return runs.map((run) => {
    const tone = runTone(run.state);
    const about =
      issues === undefined || run.issueId === null
        ? undefined
        : issues.get(run.issueId);
    return {
      title: `${run.state.padEnd(9)} ${runTitle(run, names, set)}${about === undefined ? "" : ` · #${about.number} ${about.title}`}`,
      ...(tone === undefined ? {} : { tone }),
      ...(runHollow(run.state) ? { hollow: true } : {}),
      secondary: run.summary === "" ? run.reason : run.summary,
      meta: metaOf(
        run.commitOid === "" ? "" : run.commitOid.slice(0, 7),
        costText(run.costUsd),
        relTime(runWhen(run)),
      ),
    };
  });
}

/** The actors behind a set of runs, in one grouped read. */
export function runActors(
  f: Session,
  runs: readonly Run[],
): Map<string, { username: string }> {
  return getUsersByIds(
    f.db,
    runs.flatMap((run) => (run.actorId === null ? [] : [run.actorId])),
  );
}

/**
 * A list of runs a screen embeds — a pull's crew tab, an issue's crew card.
 * It owns its cursor and its rows; the host decides where it goes and when
 * it has focus.
 */
export class RunList {
  readonly state = new ListState();
  runs: Run[] = [];
  private names = new Map<string, { username: string }>();
  private issues: Map<string, Issue> | undefined;

  /**
   * `nameIssues` reads the conversation behind every run — one grouped
   * query per list — for a list that spans a repository.
   */
  constructor(
    private readonly f: Session,
    private readonly o: { nameIssues?: boolean } = {},
  ) {}

  set(runs: Run[]): void {
    this.runs = runs;
    this.names = runActors(this.f, runs);
    this.issues =
      this.o.nameIssues === true
        ? getIssuesByIds(
            this.f.db,
            runs.flatMap((run) => (run.issueId === null ? [] : [run.issueId])),
          )
        : undefined;
    this.state.clamp(runs.length);
  }

  get selected(): Run | undefined {
    return this.runs[this.state.index];
  }

  render(
    s: Surface,
    r: Rect,
    c: Tokens,
    ctx: Ctx,
    focused: boolean,
    open: (run: Run) => void,
  ): void {
    drawList(
      s,
      r,
      c,
      this.state,
      runRows(this.runs, this.names, ctx.icons, this.issues),
      focused,
    );
    hitList(ctx, r, this.state, this.runs.length, {
      open: (index) => {
        const run = this.runs[index];
        if (run !== undefined) open(run);
      },
    });
  }
}

/** Every run of one repository, newest first, live. */
export function runsScreen(f: Session, ctx: Ctx, repo: Repo): Screen {
  const list = new RunList(f, { nameIssues: true });
  let failed: string | undefined;

  const reload = (): void => {
    const read = listRepoRuns(f.app, f.user, repo, { limit: 100 });
    if (!read.ok) {
      failed = errorText(read.error);
      ctx.invalidate();
      return;
    }
    failed = undefined;
    list.set(read.value);
    ctx.invalidate();
  };

  const open = (run: Run | undefined): void => {
    if (run !== undefined) ctx.push(runScreen(f, ctx, repo, run.id));
  };

  const screen: Screen = {
    title: `${repo.ownerName}/${repo.name} · runs`,
    keys: [
      binding(["j", "k"], "move"),
      binding(["enter"], "open the log"),
      binding(["r"], "refresh"),
    ],
    load(signal) {
      live(f, signal, { repoId: repo.id, kinds: RUN_EVENTS }, reload);
      reload();
      return Promise.resolve();
    },
    render(area, s) {
      const c = ctx.theme.c;
      if (failed !== undefined) {
        emptyState(s, area, c, { title: failed });
        return;
      }
      if (list.runs.length === 0) {
        emptyState(s, area, c, {
          title: "No runs yet",
          body: "A deploy or an agent working here will appear as a run.",
        });
        return;
      }
      list.render(s, area, c, ctx, true, open);
    },
    key(e) {
      if (list.state.key(e, list.runs.length)) return true;
      if (e.key === "enter") {
        open(list.selected);
        return true;
      }
      if (e.key === "r") {
        reload();
        return true;
      }
      return false;
    },
  };
  return screen;
}
