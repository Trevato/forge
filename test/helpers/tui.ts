/**
 * Waiting for the terminal to stop moving.
 *
 * The shape this replaces was a sleep in a loop: twelve milliseconds, check
 * `app.busy`, twelve more, then twelve more "for the invalidations a
 * finished load schedules", then assert. It passes almost always, which is
 * the worst possible failure mode — the times it does not are a loaded
 * machine, a cold page cache, or a `git` that took forty milliseconds
 * instead of four, and the symptom is an assertion against a half-drawn
 * screen with nothing in the output to say so.
 *
 * Two changes make it structural rather than lucky:
 *
 * 1. **Wait for quiescence, not for a duration.** The condition is
 *    `app.settled` — nothing loading, nothing tracked, nothing dirty —
 *    observed unchanged across several turns of the event loop. Work that
 *    schedules more work (a load that finishes, pops a screen, and starts
 *    the parent's reload) resets the count instead of slipping through a
 *    fixed number of ticks.
 * 2. **Time out loudly.** The old loop fell out of its `while` on a deadline
 *    and carried on asserting, so a timeout arrived disguised as whatever
 *    assertion happened to fail next. This throws, naming what was still in
 *    flight and printing the screen.
 *
 * There is no sleep to tune here. If a test needs longer, it is waiting on
 * something real and `timeoutMs` is where to say so.
 */

import type { App } from "../../src/tui/app/app.ts";

/**
 * Consecutive quiet turns before the screen is called settled. Three, not
 * one, because a resolved promise can schedule a microtask that schedules a
 * macrotask — two hops — before anything is marked dirty again.
 */
const QUIET_TURNS = 3;

/** One full turn of the event loop, microtasks drained. */
const turn = async (): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
};

export interface SettleOptions {
  /** Give up (loudly) after this long. @default 20_000 */
  timeoutMs?: number;
}

/**
 * Resolve once the app has been quiet for `QUIET_TURNS` consecutive turns,
 * then paint one frame so the caller reads current cells.
 */
export async function settleApp(
  app: App,
  options: SettleOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const deadline = Date.now() + timeoutMs;
  let quiet = 0;
  let lastFrame = -1;
  while (Date.now() < deadline) {
    await turn();
    const frames = app.frameCount;
    // A frame painted since the last check means something moved, whatever
    // the flags say — so the count restarts.
    if (app.settled && frames === lastFrame) {
      if (++quiet >= QUIET_TURNS) {
        app.frame();
        return;
      }
    } else {
      quiet = 0;
    }
    lastFrame = frames;
  }
  throw new Error(
    `the terminal never settled in ${timeoutMs}ms (busy=${app.busy})\n${app.screen.toText()}`,
  );
}

/**
 * Settle, then wait for `what` to appear — for the screens whose content
 * arrives from a poll rather than from the load that opened them.
 */
export async function settleUntil(
  app: App,
  what: string,
  options: SettleOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await settleApp(app, {
      timeoutMs: Math.max(1_000, deadline - Date.now()),
    });
    if (app.screen.toText().includes(what)) return;
    if (Date.now() > deadline) {
      throw new Error(
        `never saw ${JSON.stringify(what)} on screen:\n${app.screen.toText()}`,
      );
    }
    await turn();
  }
}

/**
 * Settle once the palette's searches have all landed — the 120ms local one
 * and the 400ms live re-run that redraws the same list. Enter pressed before
 * the second can open a row the redraw then moves.
 */
export async function settlePalette(
  app: App,
  options: SettleOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const deadline = Date.now() + timeoutMs;
  while (!app.paletteSettled) {
    if (Date.now() > deadline) {
      throw new Error(
        `the palette's search never landed in ${timeoutMs}ms:\n${app.screen.toText()}`,
      );
    }
    await turn();
  }
  await settleApp(app, { timeoutMs: Math.max(1_000, deadline - Date.now()) });
}
