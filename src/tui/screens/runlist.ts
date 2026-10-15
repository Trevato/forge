/**
 * Runs, as rows: the vocabulary a screen borrows to show one — a pull's
 * checks, an issue's crew activity. One place decides what "failed" looks
 * like so it looks the same everywhere. A run's live log is a web page
 * (`/:owner/:name/runs/:id`); `openRunLog` hands its address over.
 *
 * A run row says four things in order: its state (a dot in the tone and the
 * word), what it was (`deploy production`, `agent robo`), why (the reason),
 * and the one-line summary the worker wrote. Nothing is a colour alone: a
 * queued run reads "queued" beside its hollow dot, and a failed one carries
 * the summary that says what failed.
 */

import { placementWords } from "../../checks/placement.ts";
import { getIssuesByIds, type Issue } from "../../core/issues.ts";
import type { Repo } from "../../core/repos.ts";
import type { Run, RunState } from "../../core/runs.ts";
import { getUsersByIds } from "../../core/users.ts";
import type { Ctx } from "../app/app.ts";
import type { Rect, Screen as Surface } from "../term/screen.ts";
import type { Tokens } from "../ui/theme.ts";
import { icon, type IconSet } from "../ui/icons.ts";
import type { Tone } from "../ui/widgets.ts";
import type { Session } from "../session.ts";
import {
  ListState,
  drawList,
  hitList,
  metaOf,
  relTime,
  type ListRow,
  openOnWeb,
} from "./common.ts";

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
        placementWords(run),
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

/**
 * `enter` on a run: its log, cancel and steer live on the web page, so the
 * terminal hands over the address. With no public URL configured the path
 * is still the answer, said as one.
 */
export function openRunLog(
  f: Session,
  ctx: Ctx,
  repo: Repo,
  run: Run,
): void {
  openOnWeb(
    f,
    ctx,
    `/${repo.ownerName}/${repo.name}/runs/${run.id}`,
    "the run's log",
  );
}
