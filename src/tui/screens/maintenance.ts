/**
 * Maintenance, a forge admin's, in the terminal (#9453): the /maintenance
 * page's facts and actions through the same service (`maintenance/service.ts`).
 * `p` asks for a reason shown to visitors, then confirms, then prepares;
 * `c` checks again and retakes the backup; `e` ends maintenance after a
 * confirm. Anyone else is offered nothing and, were the screen reached, is
 * refused by the service. Enter, Esc or q closes it.
 */

import { ABOUT_TO_STOP_ROWS, prepare, resumeNow, status } from "../../maintenance/service.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Session } from "../session.ts";
import { wrap } from "../term/width.ts";
import { dialog } from "../ui/widgets.ts";
import { confirmScreen, later, promptScreen, runAsync } from "./common.ts";
import type { PaletteEntry } from "./entries.ts";

const WIDTH = 72;
const INNER = WIDTH - 6;

export function maintenanceLines(f: Session): string[] {
  const s = status(f.app);
  const facts =
    s.phase === "idle"
      ? ABOUT_TO_STOP_ROWS.flatMap((r) => wrap(`${r.what}: ${r.stops}`, INNER))
      : [
          ...wrap(`Since ${s.since ?? ""}${s.reason ? `: ${s.reason}` : ""}`, INNER),
          ...wrap(`Backup: ${s.backup?.says ?? ""}`, INNER),
          `Still working: ${s.working}`,
        ];
  return [...wrap(s.says, INNER), "", ...facts];
}

export function maintenanceScreen(f: Session, ctx: Ctx): Screen {
  const mayAct = (): boolean => f.user?.isAdmin === true && f.user.kind !== "agent";
  let busy = false;
  let note = "";
  const say = (text: string): void => {
    note = text;
    ctx.invalidate();
  };

  const run = (what: () => Promise<string> | string): void => {
    busy = true;
    say("Working…");
    runAsync(ctx, async () => {
      try {
        say(await what());
      } finally {
        busy = false;
        ctx.invalidate();
      }
    });
  };

  const doPrepare = (reason: string): void =>
    run(async () => {
      const r = await prepare(f.app, f.user, reason);
      return r.ok ? r.value.says : r.error.says;
    });

  const askPrepare = (): Screen =>
    promptScreen(ctx, screen, {
      title: "Prepare for maintenance",
      label: "Shown to visitors (optional, at most 200 characters)",
      hint: "Enter goes on to the confirm.",
      onSubmit: (reason) => {
        if (reason.length > 200) return "At most 200 characters.";
        return later(ctx, () =>
          confirmScreen(ctx, screen, {
            title: "Prepare for maintenance?",
            body: ["The crew and releases stop now; the forge,", "its apps and previews stop at power-off."],
            actions: [{ label: "Cancel", variant: "ghost" }, { label: "Prepare", variant: "danger" }],
            onChoose: (i) => {
              if (i === 1) doPrepare(reason);
            },
          }),
        );
      },
    });

  const askEnd = (): Screen =>
    confirmScreen(ctx, screen, {
      title: "End maintenance now?",
      body: ["Releases are let go and the crew starts again."],
      actions: [{ label: "Cancel", variant: "ghost" }, { label: "End maintenance" }],
      onChoose: (i) => {
        if (i !== 1) return;
        const r = resumeNow(f.app, f.user);
        say(r.ok ? r.value.says : r.error.says);
      },
    });

  const screen: Screen = {
    title: "Maintenance",
    get keys() {
      const idle = status(f.app).phase === "idle";
      return [
        ...(!mayAct() || busy
          ? []
          : idle
            ? [binding(["p"], "prepare for maintenance")]
            : [binding(["c"], "check again, retake the backup"), binding(["e"], "end maintenance")]),
        binding(["enter", "esc", "q"], "close"),
      ];
    },
    render(area, s) {
      const buttons = dialog(s, area, ctx.theme.c, {
        title: "Maintenance",
        body: [...(note === "" ? [] : [...wrap(note, INNER), ""]), ...maintenanceLines(f)],
        actions: [{ label: "Close" }],
        selected: 0,
        width: WIDTH,
      });
      buttons.forEach((rect) => ctx.hit(rect, () => ctx.pop()));
    },
    key(e) {
      if (e.ctrl || e.alt) return true;
      const idle = status(f.app).phase === "idle";
      if (e.key === "enter" || e.key === "esc" || e.key === "q") ctx.pop();
      else if (!mayAct() || busy) return true;
      else if (e.key === "p" && idle) ctx.push(askPrepare());
      else if (e.key === "c" && !idle) doPrepare("");
      else if (e.key === "e" && !idle) ctx.push(askEnd());
      return true;
    },
  };
  return screen;
}

/** Prepare the forge for a power-off, check the drain, or end it: a site admin's, as /maintenance is. */
export const entry: PaletteEntry = {
  id: "maintenance",
  title: "Maintenance",
  hint: "prepare the forge for a power-off, check the drain, or end maintenance",
  after: ["resilience", "capacity", "flow", "sentinel"],
  offered: (session) => session.user?.isAdmin === true && session.user.kind !== "agent",
  run: (session, ctx) => ctx.push(maintenanceScreen(session, ctx)),
};
