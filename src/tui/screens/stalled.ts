/**
 * Stalled flow steps, the home's cards for a person without a browser
 * (#1807): the pulls whose check was never asked for, or is red, past their
 * stage's allowance — `flow/stalled.ts`'s list, for the repositories this
 * person can write to. Enter (or r) does the one thing that unblocks the
 * step under the cursor; the list is live, and a step that moves on leaves it.
 */

import { CHECK_ASKED } from "../../actions/pull_ask_words.ts";
import { readStalled, type StalledStep } from "../../flow/stalled.ts";
import { unblock } from "../../flow/unblock.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Session } from "../session.ts";
import { ListState, drawList, hitList, live, metaOf, relTime, runAsync, type ListRow } from "./common.ts";
import { emptyState } from "../ui/widgets.ts";

const VERB: Record<StalledStep["action"], string> = { run: "run check", rerun: "re-run" };

/** One line per step: the pull, where it is stuck, and what Enter does. */
export function stalledRows(steps: readonly StalledStep[]): ListRow[] {
  return steps.map((s) => ({
    title: `${s.ownerName}/${s.repoName} #${s.pull} ${s.title}`,
    meta: metaOf(s.stage, `stuck ${relTime(s.since)}`, `enter: ${VERB[s.action]}`),
  }));
}

export function stalledScreen(f: Session, ctx: Ctx): Screen {
  const state = new ListState();
  let steps: StalledStep[] = [];
  const reload = () => {
    steps = f.user === undefined ? [] : readStalled(f.db, f.user, new Date());
    state.clamp(steps.length);
  };
  const act = (index: number) => {
    const step = steps[index];
    const user = f.user;
    if (step === undefined || user === undefined) return;
    runAsync(ctx, async () => {
      const done = await unblock(f.app, user, step);
      ctx.toast(done.ok ? CHECK_ASKED : done.message, done.ok ? "default" : "danger");
      reload();
    });
  };
  return {
    title: "Stalled steps",
    keys: [binding(["enter", "r"], "unblock"), binding(["esc", "q"], "close")],
    load(signal) {
      live(f, signal, {}, reload);
      reload();
      return Promise.resolve();
    },
    render(area, s) {
      if (steps.length === 0) {
        emptyState(s, area, ctx.theme.c, { title: "Nothing is stalled", body: "Every step you can unblock is moving." });
        return;
      }
      drawList(s, area, ctx.theme.c, state, stalledRows(steps));
      hitList(ctx, area, state, steps.length, { open: act });
    },
    key(e) {
      if (e.key === "esc" || e.key === "q") ctx.pop();
      else if (e.key === "enter" || e.key === "r") act(state.index);
      else state.key(e, steps.length);
      return true;
    },
  };
}
