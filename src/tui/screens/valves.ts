/**
 * The week's valves in the terminal, a forge admin's who is a person: one row
 * per repository with its valve and what the next tick will do, as /flow
 * draws it from the same `readPipes`. `h`/`l` close or open a valve by ten,
 * `x` shuts it, `o` opens it, `t` takes the suggestion beside it. A turn goes
 * through `actions/valves.ts`, so it is kept, announced as `valve.turned` and
 * reaches every open page and screen; the screen refreshes on that event.
 * An overdue off-box backup (#10924, `flow/alarm_backup.ts`) is the first
 * line, as /flow draws it, and `b` retries it through `actions/backup_retry.ts`,
 * the same action as the page's button.
 */

import { retryBackup } from "../../actions/backup_retry.ts";
import { alarmBackup } from "../../flow/alarm_backup.ts";
import { acceptSuggestion, turnValveFor } from "../../actions/valves.ts";
import { readPipes, type Pipes, type ValveRow } from "../../flow/pipes.ts";
import { levelWords } from "../../flow/valve.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Session } from "../session.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import { fill, len, split } from "../ui/layout.ts";
import type { PaletteEntry } from "./entries.ts";
import { ListState, drawList, live, runAsync, type ListRow } from "./common.ts";
import { mayCapacity } from "./capacity.ts";

const STEP = 10;

function rowOf(v: ValveRow): ListRow {
  const turned = v.turned === undefined ? "" : ` · ${v.turned.by} turned it ${String(v.turned.from)} → ${String(v.turned.to)}`;
  const suggestion = v.suggestion === undefined ? "" : ` · t takes ${String(v.suggestion)}%`;
  return {
    title: `${v.slug}  ${String(v.level)}%`,
    meta: `$${v.usd.toFixed(2)} · ${String(v.runs)} runs · ${String(v.shipped)} shipped`,
    note: `${levelWords(v.level)} ${String(v.next.queued)} queued: ${String(v.next.goes)} start, ${String(v.next.yields)} yield, ${String(v.next.held)} held${turned}${suggestion}`,
  };
}

export function valvesScreen(f: Session, ctx: Ctx): Screen {
  const state = new ListState();
  let pipes: Pipes | undefined;
  const reload = (): void => {
    pipes = mayCapacity(f) && f.user !== undefined ? readPipes(f.db, f.user.id) : undefined;
    ctx.invalidate();
  };
  let retrying = false;
  /** The overdue off-box backup's sentence, read fresh from the outcome files; empty when none is overdue. */
  const overdue = (): string => {
    const a = alarmBackup(f.app.config.dataDir, new Date());
    return a.fired ? `${a.says} b retries it now.` : "";
  };
  const valves = (): readonly ValveRow[] => pipes?.valves ?? [];
  const here = (): ValveRow | undefined => valves()[state.index];
  const turn = (to: (v: ValveRow) => number): void => {
    const v = here();
    if (v === undefined) return;
    const r = turnValveFor(f.app, f.user, v.slug, to(v));
    ctx.toast(r.ok ? r.value.says : "that is not a valve", r.ok ? undefined : "attn");
    reload();
  };
  const screen: Screen = {
    title: "Valves",
    keys: [
      binding(["j", "k"], "move cursor"),
      binding(["h", "l"], "close / open by ten"),
      binding(["x"], "shut"),
      binding(["o"], "open"),
      binding(["t"], "take the suggestion"),
      binding(["b"], "retry an overdue off-box backup"),
    ],
    load(signal) {
      live(f, signal, { kinds: ["valve.turned"] }, reload);
      reload();
      return Promise.resolve();
    },
    render(area, s) {
      const c = ctx.theme.c;
      const late = overdue();
      const [warn, head, list] = split(area, "v", [len(late === "" ? 0 : 1), len(1), fill(1)]);
      if (late !== "") s.text(warn!.x, warn!.y, truncate(late, warn!.w), style(c.fg, c.bg), warn!.x + warn!.w);
      const spent = pipes === undefined ? "" : `$${pipes.usd.toFixed(2)} spent in 7 days, ${String(pipes.shipped)} shipped; `;
      s.text(head!.x, head!.y, truncate(`${spent}the crew does what the valves say, from the next tick`, head!.w), style(c.mutedFg, c.bg), head!.x + head!.w);
      drawList(s, list!, c, state, valves().map(rowOf));
    },
    key(e) {
      if (e.key === "h") turn((v) => Math.max(0, v.level - STEP));
      else if (e.key === "l") turn((v) => Math.min(100, v.level + STEP));
      else if (e.key === "x") turn(() => 0);
      else if (e.key === "o") turn(() => 100);
      else if (e.key === "b") {
        if (retrying || overdue() === "") return true;
        retrying = true;
        ctx.toast("Taking a snapshot…");
        runAsync(ctx, async () => {
          try {
            const r = await retryBackup(f.app, f.user);
            ctx.toast(r.says, r.cleared ? undefined : "attn");
          } finally {
            retrying = false;
            ctx.invalidate();
          }
        });
      } else if (e.key === "t") {
        const v = here();
        if (v === undefined) return true;
        if (v.suggestion === undefined) ctx.toast("no suggestion here", "attn");
        else {
          const r = acceptSuggestion(f.app, f.user, v.slug);
          ctx.toast(r.ok ? r.value.says : "no suggestion here", r.ok ? undefined : "attn");
          reload();
        }
        return true;
      } else return state.key(e, valves().length);
      return true;
    },
  };
  return screen;
}

/** The week's valves, as /flow turns them: a forge admin's who is a person. */
export const entry: PaletteEntry = {
  id: "valves",
  title: "Valves",
  hint: "the week's budget as a valve per repository; turn one and the crew obeys",
  after: ["flow"],
  offered: mayCapacity,
  run: (session, ctx) => ctx.push(valvesScreen(session, ctx)),
};
