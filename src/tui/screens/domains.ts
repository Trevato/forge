/**
 * Failure domains in the terminal, a forge admin's: each failure domain and its
 * last drill — `listResilience`, the action Settings → Backups → Failure domains reads.
 * Who may read is the action's call, not this screen's: anyone else gets an
 * empty screen that says nothing exists.
 */

import { snapshotsOf } from "../../snapshot/service.ts";
import { listResilience, type ResilienceRow } from "../../actions/resilience.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { fill, len, split } from "../ui/layout.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import type { Session } from "../session.ts";
import { ListState, confirmScreen, drawList, type ListRow } from "./common.ts";
import type { PaletteEntry } from "./entries.ts";

function drillLine(d: ResilienceRow): string {
  if (d.drill.name === null) return `Not drilled: ${d.drill.why}`;
  const last = d.drill.last;
  if (last === null) return `${d.drill.name}: never run`;
  return `${d.drill.name}: ${last.at.slice(0, 16).replace("T", " ")} UTC · ${last.green ? "green" : "red"} — ${last.why} · back in ${last.backSeconds}s (budget ${d.backMinutes} min)`;
}

export function domainsScreen(f: Session, ctx: Ctx): Screen {
  const state = new ListState();
  let domains: ResilienceRow[] = [];
  let loaded = false;
  let admin = false;
  let drilling = false;
  let verdict = "";

  const rows = (): ListRow[] =>
    domains.map((d) => ({
      title: d.name,
      secondary: d.drill.name === null ? "not drilled" : d.drill.last === null ? "never run" : d.drill.last.green ? "green" : "red",
      meta: `${d.breaks} · ${drillLine(d)}`,
    }));

  const refresh = (): void => {
    const listed = listResilience(f.app, f.user);
    domains = listed.ok ? listed.value : [];
    admin = listed.ok;
    loaded = true;
    state.clamp(domains.length);
    ctx.invalidate();
  };

  /** Restore the newest snapshot as a drill, worded as MCP `restore_drill` and the Backups button. */
  const drill = async (): Promise<void> => {
    if (drilling) return;
    // The write asks again who is pressing, as the Backups POST and MCP do on every call.
    if (!listResilience(f.app, f.user).ok || f.user?.kind === "agent") {
      admin = false;
      verdict = "Only a forge admin can run a restore drill.";
      ctx.toast(verdict, "danger");
      ctx.invalidate();
      return;
    }
    drilling = true;
    ctx.invalidate();
    let says: string;
    let red = true;
    try {
      const svc = snapshotsOf(f.app);
      if (svc === undefined || svc.store === undefined) says = "This forge has no snapshots to drill.";
      else {
        const d = await svc.drill();
        red = d.verdict !== "green";
        says = red ? `The drill failed at ${d.failedStep}.` : "The drill restored green.";
      }
    } catch (error) {
      says = `The drill could not run: ${String(error)}`;
    }
    drilling = false;
    verdict = says;
    ctx.toast(says, red ? "danger" : undefined);
    refresh();
  };

  const ask = (): void => {
    if (!admin || drilling) return;
    ctx.push(
      confirmScreen(ctx, screen, {
        title: "Restore drill",
        body: ["Restore the newest snapshot as a drill?"],
        actions: [{ label: "Run drill" }, { label: "Cancel" }],
        selected: 1,
        onChoose: (choice) => {
          if (choice === 0 && !drilling) void drill();
        },
      }),
    );
  };

  const screen: Screen = {
    title: "Failure domains",
    get keys() {
      return [binding(["j", "k"], "move cursor"), ...(admin && !drilling ? [binding(["d"], "restore drill")] : [])];
    },
    load() {
      refresh();
      return Promise.resolve();
    },
    render(area, s) {
      const c = ctx.theme.c;
      const [head, list] = split(area, "v", [len(1), fill(1)]);
      const note = !loaded
        ? "Loading…"
        : domains.length === 0
          ? "Nothing here."
          : drilling
            ? "Restore drill running…"
            : verdict !== ""
              ? verdict
              : `${domains.length} failure domains, and each one's last drill`;
      s.text(head!.x, head!.y, truncate(note, head!.w), style(c.mutedFg, c.bg), head!.x + head!.w);
      drawList(s, list!, c, state, rows());
    },
    key(e) {
      if (e.key === "d") {
        ask();
        return true;
      }
      return state.key(e, domains.length);
    },
  };
  return screen;
}

/** Each failure domain and its last drill, as Settings → Backups → Failure domains says it (#1945). */
export const entry: PaletteEntry = {
  id: "domains",
  title: "Failure domains",
  hint: "failure domains and their last drill",
  offered: (session) => session.user?.isAdmin === true && session.user.kind !== "agent",
  run: (session, ctx) => ctx.push(domainsScreen(session, ctx)),
};
