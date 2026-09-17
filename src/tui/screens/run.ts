/**
 * One run: what it is, how it ended (or that it has not), and its log,
 * tailed live for as long as the screen is on the stack.
 *
 * The order of the two reads on load is the whole correctness story. The
 * subscription is taken *first* and the file read *second*; both are
 * synchronous, so no line can land between them — every line is either in
 * the file we read or delivered to the listener we registered, never both
 * and never neither. The listener is released by the screen's own abort
 * signal, so popping the screen is what stops the tail.
 *
 * The log follows its end the way `tail -f` does until the reader scrolls
 * up to look at something, and `G` puts it back on the end.
 *
 * Lines wrap to the width rather than clip at it: a log is read for the
 * words at the end of a line — the path, the exit code, the URL — and a
 * terminal that cut them off would be showing the least useful half. The
 * wrapped rows are built once per width and extended a line at a time as
 * the tail arrives, so a resize is the only thing that rewraps.
 */

import { cancelRepoRun, getRepoRun, runLog } from "../../actions/runs.ts";
import { canWrite, type Repo } from "../../core/repos.ts";
import { isTerminal, type Run } from "../../core/runs.ts";
import { subscribeRunLog } from "../../runs/log.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Span } from "../term/screen.ts";
import { BOLD, ITALIC, style, type Color, type Style } from "../term/style.ts";
import { expandTabs, truncate, wrap } from "../term/width.ts";
import { fill, len, split } from "../ui/layout.ts";
import type { Tokens } from "../ui/theme.ts";
import { dot, spinner, type Tone } from "../ui/widgets.ts";
import type { Session } from "../session.ts";
import {
  Scroll,
  ago,
  confirmScreen,
  drawLines,
  errorText,
  hitScroll,
  live,
  metaOf,
  runAsync,
} from "./common.ts";
import {
  costText,
  envLabel,
  runActors,
  runHollow,
  runTitle,
  runTone,
} from "./runs.ts";

/** Head rows: the state line, the summary, and the times. */
const HEAD = 4;

/** The log laid out for one width and one theme. */
interface View {
  readonly width: number;
  readonly c: Tokens;
  readonly rows: Span[][];
  /** The line each row came from; -1 for the "earlier lines" notice. */
  readonly from: number[];
}

export function runScreen(
  f: Session,
  ctx: Ctx,
  repo: Repo,
  runId: string,
): Screen {
  let run: Run | undefined;
  let names = new Map<string, { username: string }>();
  let lines: string[] = [];
  let truncated = false;
  let view: View | undefined;
  let follow = true;
  let failed: string | undefined;
  const scroll = new Scroll();

  // The action decides; this only shapes the help bar. A cancel the action
  // refuses is a toast, never a silent keypress.
  const mayCancel = (): boolean =>
    run !== undefined && !isTerminal(run.state) && canWrite(f.db, repo, f.user);

  const addLine = (v: View, line: string, index: number): void => {
    const st = lineStyle(line, v.c);
    for (const piece of wrap(expandTabs(line), v.width)) {
      v.rows.push([{ text: piece, style: st }]);
      v.from.push(index);
    }
  };

  /**
   * The rows for this width. A new width rewraps everything and keeps the
   * reader's place by *line*, not by row: the line that was at the top stays
   * at the top, whatever number of rows it now takes.
   */
  const viewFor = (width: number): View => {
    const c = ctx.theme.c;
    if (view !== undefined && view.width === width && view.c === c) return view;
    const next: View = { width, c, rows: [], from: [] };
    if (truncated) {
      next.rows.push([
        {
          text: "… earlier lines are not shown; the log is large",
          style: style(c.faint, c.bg, ITALIC),
        },
      ]);
      next.from.push(-1);
    }
    lines.forEach((line, i) => addLine(next, line, i));
    if (view !== undefined && !follow) {
      const wasAt = view.from[scroll.top] ?? -1;
      scroll.top = Math.max(0, next.from.indexOf(wasAt));
    }
    view = next;
    return next;
  };

  /** Re-read the row: the state, the summary and the cost move as it runs. */
  const refreshRun = (): void => {
    const read = getRepoRun(f.app, f.user, repo, runId);
    if (!read.ok) {
      failed = errorText(read.error);
      ctx.invalidate();
      return;
    }
    run = read.value;
    names = runActors(f, [run]);
    ctx.invalidate();
  };

  const cancel = (): void => {
    if (run === undefined) return;
    ctx.push(
      confirmScreen(ctx, screen, {
        title: "Cancel this run",
        body: [
          run.kind === "agent"
            ? "The agent is stopped where it is; what it pushed stays."
            : "The deploy is abandoned; whatever was serving keeps serving.",
        ],
        actions: [
          { label: "Keep going", variant: "ghost" },
          { label: "Cancel the run", variant: "danger" },
        ],
        onChoose: (choice) => {
          if (choice !== 1) return;
          const done = cancelRepoRun(f.app, f.user, repo, runId);
          if (!done.ok) ctx.toast(errorText(done.error), "danger");
          else {
            run = done.value;
            ctx.toast("run cancelled", "success");
            ctx.invalidate();
          }
        },
      }),
    );
  };

  const screen: Screen = {
    title: "Run",
    get keys() {
      return [
        binding(["j", "k"], "scroll"),
        binding(["G"], "follow the end"),
        binding(["x"], "cancel", { disabled: !mayCancel() }),
      ];
    },
    load(signal) {
      // Subscribe, then read — see the file comment.
      subscribeRunLog(
        runId,
        (line) => {
          if (signal.aborted) return;
          lines.push(line);
          if (view !== undefined) addLine(view, line, lines.length - 1);
          ctx.invalidate();
        },
        signal,
      );
      const read = runLog(f.app, f.user, repo, runId);
      if (!read.ok) {
        failed = errorText(read.error);
        ctx.invalidate();
        return Promise.resolve();
      }
      run = read.value.run;
      names = runActors(f, [run]);
      lines = read.value.lines;
      truncated = read.value.truncated;
      view = undefined;
      live(
        f,
        signal,
        { repoId: repo.id, kinds: ["run.started", "run.finished"] },
        refreshRun,
      );
      ctx.invalidate();
      return Promise.resolve();
    },
    render(area, s) {
      const c = ctx.theme.c;
      if (failed !== undefined) {
        s.text(area.x, area.y, failed, style(c.danger, c.bg), area.x + area.w);
        return;
      }
      if (run === undefined) return;
      const [head, body] = split(area, "v", [len(HEAD), fill(1)]);
      const right = head!.x + head!.w;
      const tone = runTone(run.state);
      let x = head!.x;
      if (run.state === "running") x = spinner(s, x, head!.y, c, ctx.tick);
      else
        x = dot(s, x, head!.y, c, {
          ...(tone === undefined ? {} : { tone }),
          ...(runHollow(run.state) ? { hollow: true } : {}),
        });
      x = s.text(
        x + 1,
        head!.y,
        run.state,
        style(tone === undefined ? c.mutedFg : toneOf(c, tone), c.bg, BOLD),
        right,
      );
      s.text(
        x + 2,
        head!.y,
        truncate(
          metaOf(
            runTitle(run, names, ctx.icons),
            run.reason === "" ? "" : run.reason,
            run.commitOid === "" ? "" : run.commitOid.slice(0, 7),
            run.branch === "" ? "" : run.branch,
            costText(run.costUsd),
          ),
          Math.max(0, right - x - 2),
        ),
        style(c.fg, c.bg),
        right,
      );
      s.text(
        head!.x,
        head!.y + 1,
        truncate(
          run.summary !== ""
            ? run.summary
            : run.state === "queued"
              ? "waiting for a worker"
              : run.state === "running"
                ? "no summary yet — the log below is live"
                : "no summary",
          head!.w,
        ),
        style(
          run.state === "failed" ? c.danger : c.mutedFg,
          c.bg,
          run.summary === "" ? ITALIC : 0,
        ),
        right,
      );
      s.text(
        head!.x,
        head!.y + 2,
        truncate(
          metaOf(
            run.kind === "deploy" ? envLabel(run.env) : "",
            `queued ${ago(run.createdAt)}`,
            run.startedAt === null ? "" : `started ${ago(run.startedAt)}`,
            run.finishedAt === null ? "" : `finished ${ago(run.finishedAt)}`,
          ),
          head!.w,
        ),
        style(c.faint, c.bg),
        right,
      );
      // One column for the scrollbar, one so a full row never touches it.
      const { rows } = viewFor(Math.max(1, body!.w - 2));
      if (rows.length === 0) {
        s.text(
          body!.x,
          body!.y,
          run.state === "queued"
            ? "Nothing logged yet."
            : "This run wrote no log.",
          style(c.faint, c.bg, ITALIC),
          body!.x + body!.w,
        );
        return;
      }
      // Following means "the last row is the bottom row", and the bottom
      // row is only known here, where the height is.
      if (follow) scroll.to(rows.length - body!.h, rows.length);
      drawLines(s, body!, c, scroll, rows);
      hitScroll(ctx, body!, scroll, rows.length);
    },
    key(e) {
      if (e.key === "x" && mayCancel()) {
        cancel();
        return true;
      }
      if (e.key === "G" || e.key === "end") {
        follow = true;
        return true;
      }
      const total = view?.rows.length ?? 0;
      if (scroll.key(e, total)) {
        // Scrolling away from the end is a choice to read; new lines stop
        // moving the view until `G` asks for the end again.
        follow = scroll.top + scroll.height >= total;
        return true;
      }
      if (e.key === "r") {
        runAsync(ctx, async () => refreshRun());
        return true;
      }
      return false;
    },
  };
  return screen;
}

/** The words a worker writes at the edges of a run stand out; the rest is log. */
function lineStyle(line: string, c: Tokens): Style {
  if (/^failed[: ]/.test(line)) return style(c.danger, c.bg);
  if (/^done[: ]/.test(line)) return style(c.success, c.bg);
  return style(c.fg, c.bg);
}

function toneOf(c: Tokens, tone: Tone): Color {
  return tone === "success"
    ? c.success
    : tone === "danger"
      ? c.danger
      : tone === "attn"
        ? c.attn
        : c.mutedFg;
}
