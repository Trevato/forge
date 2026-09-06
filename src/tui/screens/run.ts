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
 */

import { cancelRepoRun, getRepoRun, runLog } from "../../actions/runs.ts";
import { canWrite, type Repo } from "../../core/repos.ts";
import { isTerminal, type Run } from "../../core/runs.ts";
import { subscribeRunLog } from "../../runs/log.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Span } from "../term/screen.ts";
import { BOLD, ITALIC, style, type Color, type Style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
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
  let styled: Span[][] = [];
  let follow = true;
  let failed: string | undefined;
  const scroll = new Scroll();

  // The action decides; this only shapes the help bar. A cancel the action
  // refuses is a toast, never a silent keypress.
  const mayCancel = (): boolean =>
    run !== undefined && !isTerminal(run.state) && canWrite(f.db, repo, f.user);

  const restyle = (): void => {
    const c = ctx.theme.c;
    styled = lines.map((line) => [{ text: line, style: lineStyle(line, c) }]);
    if (truncated)
      styled.unshift([
        {
          text: "… earlier lines are not shown; the log is large",
          style: style(c.faint, c.bg, ITALIC),
        },
      ]);
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
          restyle();
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
      restyle();
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
      if (styled.length === 0) {
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
      // Following means "the last line is the bottom row", and the bottom
      // row is only known here, where the height is.
      if (follow) scroll.to(styled.length - body!.h, styled.length);
      drawLines(s, body!, c, scroll, styled);
      hitScroll(ctx, body!, scroll, styled.length);
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
      if (scroll.key(e, styled.length)) {
        // Scrolling away from the end is a choice to read; new lines stop
        // moving the view until `G` asks for the end again.
        follow = scroll.top + scroll.height >= styled.length;
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
