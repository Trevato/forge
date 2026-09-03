/**
 * Mirroring, with something to look at while it happens.
 *
 * Pressing `m` used to mean "wait, with no screen and no idea how long" —
 * a clone plus every label, issue, pull and comment, inside one keypress.
 * The work is a job now (`origins/jobs.ts`), so this is the card over it: a
 * checklist of the stages, the job's own detail beside the one it is on, a
 * spinner, and the elapsed seconds.
 *
 * Three rules make it feel like a background task rather than a modal:
 *
 * - **Esc hides, it never cancels.** The job runs detached; the watcher below
 *   outlives the card and toasts when it lands.
 * - **One card per job.** A second `m` on a running mirror joins it — the job
 *   layer dedupes the *work*, and `open` dedupes the *card*, so a double
 *   press can never stack two of them.
 * - **Done replaces the screen underneath.** After a mirror the live browse
 *   is a stale copy of something we now hold, so the caller swaps it for the
 *   same screen over the local source and the where-strip flips to workbench.
 */

import { startMirrorJob } from "../../actions/origins.ts";
import type { Repo } from "../../core/repos.ts";
import {
  subscribe,
  type MirrorJob,
  type MirrorStage,
} from "../../origins/jobs.ts";
import type { RepoSource } from "../../view/source.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding, type Binding } from "../app/keys.ts";
import type { KeyEvent } from "../term/input.ts";
import { G, type Rect } from "../term/screen.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import { card, spinner } from "../ui/widgets.ts";
import type { Session } from "../session.ts";
import { errorText, openLink } from "./common.ts";
import { liveOrigin, originUrl } from "./where.ts";

/** The working stages, in order. `done` and `failed` are the outcome line. */
const STAGES: readonly MirrorStage[] = [
  "creating",
  "fetching",
  "labels",
  "issues",
  "pulls",
  "comments",
];

/** Jobs that already have a card on some stack — one card, however many `m`s. */
const shown = new Set<string>();

export interface MirrorCardOptions {
  /** Drawn behind the card, so the mirror reads as an overlay on your place. */
  readonly parent: Screen;
  readonly originId: string;
  readonly fullName: string;
  /**
   * Swap this screen for the local one, once there is a local one. Called by
   * the *card* only — a screen may only replace itself while it is still the
   * screen under the card, and after `esc` it may well not be.
   */
  readonly onDone?: (repo: Repo) => void;
  /**
   * Refresh whatever data the caller is showing. Safe from anywhere, so this
   * is the one the watcher calls whether the card is up or long dismissed.
   */
  readonly onLanded?: (repo: Repo) => void;
}

/**
 * Start (or join) the mirror of `fullName` and put the card up. The only
 * entry point: the picker and a live repo screen both press the same key and
 * mean the same thing.
 */
export function startMirror(f: Session, ctx: Ctx, o: MirrorCardOptions): void {
  const started = startMirrorJob(f.app, f.user, o.originId, o.fullName);
  if (!started.ok) {
    ctx.toast(errorText(started.error), "danger");
    return;
  }
  showMirrorJob(f, ctx, started.value, o);
}

/**
 * The same card, over a job somebody else started.
 *
 * `forkOrigin(…, { mirror: "job" })` makes the fork *and* starts the copy in
 * one call, and hands the job back — so the fork flow has a job before it has
 * a card, which is the reverse of `startMirror`'s order. Both end up here, so
 * there is one card, one watcher and one dedupe rule however the job began.
 */
export function showMirrorJob(
  f: Session,
  ctx: Ctx,
  job: MirrorJob,
  o: MirrorCardOptions,
): void {
  // The watcher is deliberately not the card's: hiding the card must not stop
  // the news of the outcome arriving.
  watch(ctx, job, o.onLanded);
  if (shown.has(job.id)) return;
  ctx.push(mirrorScreen(f, ctx, job, o));
}

/**
 * Follow a job to its end, whatever is on screen. Registered once per card
 * press; a job already being watched is left alone.
 */
const watched = new Set<string>();

function watch(
  ctx: Ctx,
  job: MirrorJob,
  onLanded: ((repo: Repo) => void) | undefined,
): void {
  if (watched.has(job.id)) return;
  watched.add(job.id);
  const stop = subscribe(job.id, (current) => {
    if (current.stage === "done") {
      stop();
      watched.delete(current.id);
      ctx.toast(current.detail === "" ? "mirrored" : current.detail, "success");
      if (current.repo !== undefined) onLanded?.(current.repo);
    } else if (current.stage === "failed") {
      stop();
      watched.delete(current.id);
      ctx.toast(current.error ?? "the mirror failed", "danger");
    }
  });
}

/**
 * The two keys a read-only repository screen has instead of the write ones.
 * Every screen that renders a `RepoSource` offers the same pair, so `m` and
 * `O` mean one thing each across the whole terminal UI.
 */
export function liveBindings(src: RepoSource): Binding[] {
  const out: Binding[] = [];
  // Terse on purpose: at 80 columns the help bar has room for perhaps six
  // bindings, and the primary action on a live browse must be one of them.
  // The banner above says the long version.
  if (src.capabilities.mirror) out.push(binding(["m"], "mirror"));
  if (originUrl(src) !== "") out.push(binding(["O"], "open on origin"));
  return out;
}

/** The handler behind `liveBindings`. False when the key was not one of them. */
export function liveKey(
  f: Session,
  ctx: Ctx,
  e: KeyEvent,
  src: RepoSource,
  o: { parent: Screen; onDone?: (repo: Repo) => void },
): boolean {
  if (e.key === "m" && src.capabilities.mirror) {
    const live = liveOrigin(src);
    if (live === undefined) return false;
    startMirror(f, ctx, {
      parent: o.parent,
      originId: live.origin.id,
      fullName: live.fullName,
      ...(o.onDone === undefined ? {} : { onDone: o.onDone }),
    });
    return true;
  }
  if (e.key === "O") {
    const url = originUrl(src);
    if (url === "") return false;
    openLink(ctx, url);
    return true;
  }
  return false;
}

/** The card itself: modal while it is up, and up only as long as you want it. */
function mirrorScreen(
  f: Session,
  ctx: Ctx,
  started: MirrorJob,
  o: MirrorCardOptions,
): Screen {
  let job = started;
  shown.add(job.id);

  return {
    title: `Mirroring ${o.fullName}`,
    get keys() {
      return [
        binding(["esc"], "hide — it keeps running"),
        ...(job.stage === "failed" ? [binding(["r"], "retry")] : []),
      ];
    },
    load(signal) {
      const off = subscribe(job.id, (current) => {
        job = current;
        ctx.invalidate();
        if (current.stage !== "done") return;
        // The mirror is the truth for this remote now. Take the card down
        // first, so the caller's `replace` lands on its own screen.
        shown.delete(current.id);
        ctx.pop();
        if (current.repo !== undefined) o.onDone?.(current.repo);
      });
      // Nothing here is "loading" as far as the loop is concerned, so the
      // spinner and the clock need a tick of their own.
      const timer = setInterval(() => ctx.invalidate(), 120);
      signal.addEventListener("abort", () => {
        off();
        clearInterval(timer);
        shown.delete(job.id);
      });
      return Promise.resolve();
    },
    render(area, s) {
      o.parent.render(area, s);
      const c = ctx.theme.c;
      const w = Math.min(60, Math.max(24, area.w - 6));
      // Six stages, the outcome line, and the two border rows — no padding
      // rows, so the card is the size of what is in it.
      const h = Math.min(area.h, STAGES.length + 3);
      const r: Rect = {
        x: area.x + ((area.w - w) >> 1),
        y: area.y + ((area.h - h) >> 1),
        w,
        h,
      };
      const inner = card(s, r, c, {
        title: `Mirroring ${o.fullName}`,
        footer: `${elapsed(job)} · esc hides this`,
        focused: true,
        ...(job.stage === "failed" ? { tone: "danger" as const } : {}),
      });
      const right = inner.x + inner.w;
      const at = STAGES.indexOf(job.stage);
      const finished = job.stage === "done";
      STAGES.forEach((stage, i) => {
        const y = inner.y + i;
        if (i >= inner.h) return;
        const past = finished || (at >= 0 && i < at);
        const now = at === i;
        let x = inner.x;
        if (now && job.stage !== "failed") x = spinner(s, x, y, c, ctx.tick);
        else
          x = s.text(
            x,
            y,
            past ? G.check : G.ring,
            style(past ? c.success : c.faint, c.card),
            right,
          );
        x = s.text(
          x + 1,
          y,
          truncate(stage, Math.max(0, right - x - 1)),
          style(now ? c.fg : past ? c.mutedFg : c.faint, c.card),
          right,
        );
        // The job's own words for what it is doing: "42 issues", not a bar
        // that pretends to know how many there will be.
        if (now && job.detail !== "")
          s.text(
            inner.x + 14,
            y,
            truncate(job.detail, Math.max(0, right - inner.x - 14)),
            style(c.mutedFg, c.card),
            right,
          );
      });
      const y = inner.y + STAGES.length;
      if (y >= inner.y + inner.h) return;
      if (job.stage === "failed")
        s.text(
          inner.x,
          y,
          truncate(
            `${G.cross} ${job.error ?? "the mirror failed"} — r retries`,
            inner.w,
          ),
          style(c.danger, c.card),
          right,
        );
      else if (job.stage === "done")
        s.text(
          inner.x,
          y,
          truncate(`${G.check} ${job.detail}`, inner.w),
          style(c.success, c.card),
          right,
        );
    },
    key(e) {
      if (e.key === "esc" || e.key === "q") {
        ctx.pop();
        ctx.toast("mirroring in the background", "default");
        return true;
      }
      if (e.key === "r" && job.stage === "failed") {
        ctx.pop();
        startMirror(f, ctx, o);
        return true;
      }
      return true;
    },
  };
}

/** "4s", "1m 12s" — the one number a person checks a long job against. */
function elapsed(job: MirrorJob): string {
  const from = Date.parse(job.startedAt);
  const to =
    job.finishedAt === undefined ? Date.now() : Date.parse(job.finishedAt);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return "";
  const seconds = Math.max(0, Math.round((to - from) / 1000));
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
