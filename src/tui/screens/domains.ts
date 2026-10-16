/**
 * Failure domains in the terminal, a forge admin's: each failure domain and its
 * last drill — `listResilience`, the action Settings → Failure domains reads.
 * Who may read is the action's call, not this screen's: anyone else gets an
 * empty screen that says nothing exists.
 */

import { listResilience, type ResilienceRow } from "../../actions/resilience.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { fill, len, split } from "../ui/layout.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import type { Session } from "../session.ts";
import { ListState, drawList, type ListRow } from "./common.ts";

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

  const rows = (): ListRow[] =>
    domains.map((d) => ({
      title: d.name,
      secondary: d.drill.name === null ? "not drilled" : d.drill.last === null ? "never run" : d.drill.last.green ? "green" : "red",
      meta: `${d.breaks} · ${drillLine(d)}`,
    }));

  const screen: Screen = {
    title: "Failure domains",
    keys: [binding(["j", "k"], "move cursor")],
    load() {
      const listed = listResilience(f.app, f.user);
      domains = listed.ok ? listed.value : [];
      loaded = true;
      state.clamp(domains.length);
      ctx.invalidate();
      return Promise.resolve();
    },
    render(area, s) {
      const c = ctx.theme.c;
      const [head, list] = split(area, "v", [len(1), fill(1)]);
      const note = !loaded
        ? "Loading…"
        : domains.length === 0
          ? "Nothing here."
          : `${domains.length} failure domains, and each one's last drill`;
      s.text(head!.x, head!.y, truncate(note, head!.w), style(c.mutedFg, c.bg), head!.x + head!.w);
      drawList(s, list!, c, state, rows());
    },
    key(e) {
      return state.key(e, domains.length);
    },
  };
  return screen;
}
