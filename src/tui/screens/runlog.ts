/**
 * A run's log: its state line, then the last 200 lines, scrolled to the end.
 * Read through `runLog` — the call MCP `run_log` and the run page make — so a
 * hidden log or an unreadable repository says "not found" and draws nothing.
 * It reads once, appends new lines from the log's own listener, and refreshes
 * the state line on this run's events; a viewer who scrolled up keeps their
 * place, one at the end follows the new lines.
 */

import { runLog, type RunLogView } from "../../actions/runs.ts";
import type { Repo } from "../../core/repos.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Session } from "../session.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import { fill, len, split } from "../ui/layout.ts";
import { emptyState } from "../ui/widgets.ts";
import { subscribeRunLog } from "../../runs/log.ts";
import { Scroll, live, openOnWeb } from "./common.ts";
import { costText, envLabel, runTone } from "./runwords.ts";

const LOG_LINES = 200;

const isLive = (state: string): boolean => state === "queued" || state === "running";

export function runLogScreen(
  f: Session,
  ctx: Ctx,
  repo: Repo,
  runId: string,
): Screen {
  const scroll = new Scroll();
  let view: RunLogView | undefined;
  let lines: string[] = [];
  let loaded = false;
  let follow = true;

  const read = (): void => {
    const got = runLog(f.app, f.user, repo, runId, LOG_LINES);
    // A hidden log is "not found", as the REST route says it.
    view = got.ok && !got.value.logHidden ? got.value : undefined;
    lines = // The tail window can hold a few more than asked for.
    lines = view === undefined ? [] : view.lines.slice(-LOG_LINES);
    loaded = true;
    if (follow) scroll.top = Number.MAX_SAFE_INTEGER;
    ctx.invalidate();
  };

  const web = (): void =>
    openOnWeb(f, ctx, `/${repo.ownerName}/${repo.name}/runs/${runId}`, "the run's log");

  const self: Screen = {
    title: "Run log",
    get keys() {
      return [
        binding(["j", "k"], "scroll"),
        binding(["pgup", "pgdn"], "page"),
        binding(["g", "G"], "top, end"),
        binding(["o"], "open on the web"),
        binding(["r"], "refresh"),
      ];
    },
    load(signal) {
      read();
      // New lines arrive from the log's own listener, never from a reread.
      subscribeRunLog(
        runId,
        (line) => {
          if (view === undefined) return;
          lines.push(line);
          if (lines.length > LOG_LINES) lines.splice(0, lines.length - LOG_LINES);
          if (follow) scroll.top = Number.MAX_SAFE_INTEGER;
          ctx.invalidate();
        },
        signal,
      );
      // The run starting or ending, or the gate moving, re-reads the state
      // line; a finished run has nothing left to follow.
      live(
        f,
        signal,
        {
          repoId: repo.id,
          kinds: ["run.queued", "run.started", "run.finished"],
          where: (event) => event.payload.runId === runId,
        },
        () => {
          // Nothing loaded (hidden, not found) or finished: nothing to follow.
          if (view === undefined || !isLive(view.run.state)) return;
          read();
        },
      );
      return Promise.resolve();
    },
    render(area, s) {
      const c = ctx.theme.c;
      if (view === undefined) {
        emptyState(s, area, c, {
          title: loaded ? "Not found" : "Reading…",
          body: loaded ? "There is no such run here." : "Reading the log",
        });
        return;
      }
      const [head, body] = split(area, "v", [len(1), fill(1)]);
      const run = view.run;
      const tone = runTone(run.state);
      const state = [
        run.state,
        run.kind === "deploy" ? `deploy ${envLabel(run.env)}` : run.kind,
        run.summary,
        costText(run.costUsd),
        isLive(run.state) ? "live" : "",
      ]
        .filter((p) => p !== "")
        .join(" · ");
      s.text(
        head!.x,
        head!.y,
        truncate(state, head!.w),
        style(tone === undefined ? c.mutedFg : c.fg, c.bg),
        head!.x + head!.w,
      );
      if (lines.length === 0) {
        emptyState(s, body!, c, {
          title: "No log yet",
          body: isLive(run.state)
            ? "Waiting for the first line."
            : "This run wrote nothing.",
        });
        return;
      }
      scroll.height = Math.max(1, body!.h);
      const last = Math.max(0, lines.length - body!.h);
      scroll.top = Math.min(scroll.top, last);
      follow = scroll.top >= last;
      for (let i = 0; i < body!.h; i++) {
        const line = lines[scroll.top + i];
        if (line === undefined) break;
        s.text(
          body!.x,
          body!.y + i,
          truncate(line.replace(/[\u0000-\u001f\u007f]/g, " "), body!.w),
          style(c.fg, c.bg),
          body!.x + body!.w,
        );
      }
    },
    key(e) {
      if (e.key === "o" && !e.ctrl && !e.alt) {
        web();
        return true;
      }
      if (e.key === "r" && !e.ctrl && !e.alt) {
        read();
        return true;
      }
      if (view === undefined) return false;
      const last = Math.max(0, lines.length - scroll.height);
      scroll.top = Math.min(scroll.top, last);
      const took = scroll.key(e, lines.length + scroll.height);
      scroll.top = Math.min(scroll.top, last);
      follow = scroll.top >= last;
      if (took) ctx.invalidate();
      return took;
    },
  };
  return self;
}
