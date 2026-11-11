/**
 * A repository's machines in the terminal (#9471), the door beside
 * Settings → Machines: the machines it declares (`crew/machines.ts`) and its
 * last shell sessions (`machines/shell.ts`) — who opened which, when, and
 * when and why it ended. Writers only, as the page: access is read at every
 * draw, so a writer who loses it sees nothing on the next frame.
 */

import { readMachine } from "../../actions/disk_readings.ts";
import { canWrite, type Repo } from "../../core/repos.ts";
import { repoMachines } from "../../crew/machines_read.ts";
import type { Machine } from "../../crew/machines.ts";
import { ENDED, lastSessions, machineStates, stateLine, type MachineState, type SessionRecord } from "../../machines/shell.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import type { Session } from "../session.ts";
import { fill, len, split } from "../ui/layout.ts";
import { diskLines } from "./disks.ts";
import { ListState, drawList, type ListRow } from "./common.ts";

/** One line per session, as the page's table reads. */
export function sessionRow(s: SessionRecord): ListRow {
  return {
    title: `${s.machine} · ${s.ownerName}`,
    secondary: s.endedAt === undefined ? "running" : ENDED[s.endReason ?? "stopped"],
    meta: `started ${s.startedAt.slice(0, 16).replace("T", " ")}`,
  };
}

/** The machines, one line: name and tools. */
export function machinesLine(list: readonly Machine[]): string {
  return `Machines: ${list.map((m) => (m.tools.length === 0 ? m.name : `${m.name} (${m.tools.join(", ")})`)).join("; ")}`;
}

/** Your live shells here, one line each in the page's words: "standard: attached", or detached with its stop time (UTC). */
export function shellStatesLine(states: ReadonlyMap<string, MachineState>): string | undefined {
  const parts = [...states].map(([name, st]) => `${name}: ${stateLine(st)}`);
  return parts.length === 0 ? undefined : `Your shell — ${parts.join("; ")}`;
}

/** The disk lines of each declared machine, the owner's alone (`mayHandleDisks`): nothing for any other writer. */
export function repoDiskLines(f: Session, list: readonly Machine[]): string[] {
  return list.flatMap((m) => {
    const r = readMachine(f.app, f.user, m.name);
    return r.ok ? diskLines(r.value) : [];
  });
}

export function machinesScreen(f: Session, ctx: Ctx, repo: Repo): Screen {
  const state = new ListState();
  let machines: readonly Machine[] = [];
  // Read once in `load`, not per frame: a reading is a database read per machine.
  let disks: string[] = [];
  const may = (): boolean => f.user !== undefined && canWrite(f.db, repo, f.user);
  const rows = (): SessionRecord[] => (may() ? lastSessions(f.db, repo.id) : []);
  return {
    title: "Machines",
    keys: [binding(["j", "k"], "move cursor"), binding(["esc"], "back")],
    async load() {
      if (may()) {
        machines = (await repoMachines(f.app, repo)).machines;
        disks = repoDiskLines(f, machines);
      }
      ctx.invalidate();
    },
    render(area, s) {
      const c = ctx.theme.c;
      const listed = rows();
      const shown = may() ? disks : [];
      const [head, list] = split(area, "v", [len(4 + shown.length), fill(1)]);
      const lines = !may()
        ? ["A repository's machines and shell sessions are its writers'."]
        : [
            machinesLine(machines),
            listed.length === 0 ? "No shell has been opened here yet." : "Last sessions, newest first.",
            ...(shellStatesLine(machineStates(f.app, repo.id, f.user!.id)) ?? []),
            ...shown,
          ];
      lines.forEach((line, i) =>
        s.text(head!.x, head!.y + i, truncate(line, head!.w), style(c.mutedFg, c.bg), head!.x + head!.w),
      );
      drawList(s, list!, c, state, listed.map(sessionRow));
    },
    key(e) {
      return state.key(e, rows().length);
    },
  };
}
