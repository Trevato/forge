/**
 * Settings › Captain in the terminal (#11011): the standing rules Talk
 * remembers and the three routines with their schedules, from the same reads
 * and writes as /settings/captain (`talk_memory`, `talk_routines`,
 * `runRoutine`). Owner only: a site admin who is a person.
 *
 *   a add a rule   enter edit   d delete a rule
 *   space turn a routine on or off   p post a routine now   r read again
 */

import { runRoutine } from "../../crew/routines.ts";
import { addMemory, editMemory, MEMORY_TEXT_MAX, MEMORY_WORDS, removeMemory, rulesOf, type Memory } from "../../core/talk_memory.ts";
import { EVERY_MAX, EVERY_MIN, listRoutines, ROUTINE_NAMES, setRoutine, type Routine } from "../../core/talk_routines.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Session } from "../session.ts";
import { ListState, drawList, metaOf, promptScreen, runAsync, type ListRow } from "./common.ts";
import type { PaletteEntry } from "./entries.ts";

export const mayCaptain = (f: Session): boolean => f.user?.isAdmin === true && f.user.kind !== "agent";


/** "60" is every 60 minutes; "at 7" is daily at 07 UTC. */
export function parseSchedule(text: string): { everyMin: number; atHour: number | null } | undefined {
  const t = text.trim().toLowerCase();
  const every = /^(\d+)$/.exec(t);
  if (every) return { everyMin: Number(every[1]), atHour: null };
  const at = /^(?:at|daily)\s+(\d+)$/.exec(t);
  if (at) return { everyMin: EVERY_MIN, atHour: Number(at[1]) };
  return undefined;
}

export const scheduleText = (r: Pick<Routine, "everyMin" | "atHour">): string => (r.atHour === null ? String(r.everyMin) : `at ${r.atHour}`);

type Line = { kind: "rule"; rule: Memory } | { kind: "routine"; routine: Routine };

export function captainRows(lines: readonly Line[]): ListRow[] {
  return lines.map((l) =>
    l.kind === "rule"
      ? { title: l.rule.text, meta: "rule" }
      : { title: ROUTINE_NAMES[l.routine.kind], meta: metaOf(l.routine.enabled ? "on" : "off", l.routine.atHour === null ? `every ${l.routine.everyMin} min` : `daily ${String(l.routine.atHour).padStart(2, "0")}:00 UTC`, l.routine.lastAt === null ? "not yet" : l.routine.lastAt.slice(0, 16).replace("T", " ")) },
  );
}

export function captainScreen(f: Session, ctx: Ctx): Screen {
  const state = new ListState();
  let lines: Line[] = [];
  const read = async (): Promise<void> => {
    lines = [...rulesOf(f.app.db, f.user!.id).map((rule): Line => ({ kind: "rule", rule })), ...listRoutines(f.app.db, f.user!.id).map((routine): Line => ({ kind: "routine", routine }))];
    state.clamp(lines.length);
    ctx.invalidate();
  };
  const refresh = (): void => void read();
  const say = (error: string | undefined): string | undefined => {
    refresh();
    return error;
  };
  const screen: Screen = {
    title: "Captain",
    keys: [binding(["j", "k"], "move"), binding(["a"], "add a rule"), binding(["enter"], "edit"), binding(["d"], "delete"), binding(["space"], "on/off"), binding(["p"], "post now"), binding(["esc", "q"], "close")],
    load: read,
    render(area, s) {
      drawList(s, area, ctx.theme.c, state, captainRows(lines));
    },
    key(e) {
      const at = lines[state.index];
      if (e.key === "esc" || e.key === "q") ctx.pop();
      else if (e.key === "a")
        ctx.push(promptScreen(ctx, screen, { title: "Remember", label: "A rule or decision", hint: `Up to ${MEMORY_TEXT_MAX} characters.`, onSubmit: (v) => say(((r) => (r.ok ? undefined : MEMORY_WORDS[r.error]))(addMemory(f.app.db, f.user!.id, v))) }));
      else if (e.key === "enter" && at?.kind === "rule") {
        const rule = at.rule;
        ctx.push(promptScreen(ctx, screen, { title: "Edit rule", label: "Rule", value: rule.text, onSubmit: (v) => say(((r) => (r.ok ? undefined : MEMORY_WORDS[r.error]))(editMemory(f.app.db, f.user!.id, rule.id, v))) }));
      } else if (e.key === "enter" && at?.kind === "routine") {
        const r = at.routine;
        ctx.push(
          promptScreen(ctx, screen, {
            title: ROUTINE_NAMES[r.kind],
            label: "Minutes, or \"at 7\" for daily at that UTC hour",
            value: scheduleText(r),
            hint: `Every ${EVERY_MIN} to ${EVERY_MAX} minutes.`,
            onSubmit: (v) => {
              const sched = parseSchedule(v);
              if (sched === undefined) return "Type minutes, or at and an hour.";
              const saved = setRoutine(f.app.db, f.user!.id, r.kind, { enabled: r.enabled, ...sched });
              return say(saved.ok ? undefined : { not_a_routine: "That is not a routine.", bad_every: `Every must be ${EVERY_MIN} to ${EVERY_MAX} minutes.`, bad_hour: "The hour is 0 to 23." }[saved.error]);
            },
          }),
        );
      } else if (e.key === "d" && at?.kind === "rule") {
        removeMemory(f.app.db, f.user!.id, at.rule.id);
        ctx.toast("Forgotten.", "success");
        refresh();
      } else if (e.key === " " && at?.kind === "routine") {
        const r = at.routine;
        setRoutine(f.app.db, f.user!.id, r.kind, { enabled: !r.enabled, everyMin: r.everyMin, atHour: r.atHour });
        refresh();
      } else if (e.key === "p" && at?.kind === "routine") {
        const kind = at.routine.kind;
        runAsync(ctx, async () => {
          await runRoutine(f.app, f.user!, kind, new Date());
          ctx.toast(`${ROUTINE_NAMES[kind]} posted to your Captain thread in Talk.`, "success");
          await read();
        });
      } else if (e.key === "r") refresh();
      else state.key(e, lines.length);
      return true;
    },
  };
  return screen;
}

export const entry: PaletteEntry = {
  id: "captain",
  title: "Captain",
  hint: "what Talk remembers, and the check-ins it posts for you",
  after: ["drift"],
  offered: mayCaptain,
  run: (session, ctx) => ctx.push(captainScreen(session, ctx)),
};
