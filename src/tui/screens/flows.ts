/**
 * Flows in the terminal (#9434): the page's lines from the same reads —
 * `readFlows` gates forks and the origin with `canRead`/`visibleForks`, and
 * `startRadar` gates the `r` key with the page's admin check — so this door
 * decides nothing of its own. Access is read at every draw.
 */

import { canRead, type Repo } from "../../core/repos.ts";
import { readRadar, type DepLine } from "../../flows/radar.ts";
import { pinsOf } from "../../flows/run.ts";
import { mayStartRadar, startRadar } from "../../flows/start.ts";
import { readFlows, type FlowLine } from "../../flows/view.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Session } from "../session.ts";
import { ListState, drawList, runAsync, type ListRow } from "./common.ts";

const flowRow = (side: string) => (l: FlowLine): ListRow => ({
  title: `${side} ${l.label}`,
  secondary: l.state,
  ...(l.problem ? { tone: "danger" as const } : {}),
  meta: l.at === null ? "never moved" : l.at.slice(0, 16).replace("T", " "),
});

const depRow = (d: DepLine): ListRow => ({
  title: `pkg ${d.name}`,
  secondary: d.error !== "" ? "not read" : d.gap === "none" ? (d.checkedAt === null ? "not read yet" : "current") : `${d.gap} update`,
  ...(d.error !== "" || d.gap === "major" ? { tone: "danger" as const } : {}),
  meta: `${d.pinned === "" ? d.range : `pinned ${d.pinned}`}${d.latest === "" ? "" : ` · newest ${d.latest}`}`,
});

export function flowsScreen(f: Session, ctx: Ctx, repo: Repo): Screen {
  const state = new ListState();
  let deps: DepLine[] = [];
  const visible = (): boolean => canRead(f.db, repo, f.user);
  const rows = (): ListRow[] => {
    if (!visible()) return [];
    const view = readFlows(f.db, repo, f.user);
    return [...view.inbound.map(flowRow("in ")), ...deps.map(depRow), ...view.outbound.map(flowRow("out"))];
  };
  const load = async (): Promise<void> => {
    deps = visible() ? readRadar(f.db, repo.id, await pinsOf(f.app, repo)) : [];
    ctx.invalidate();
  };
  return {
    title: "Flows",
    keys: [binding(["j", "k"], "move cursor"), ...(mayStartRadar(f.app, repo, f.user) ? [binding(["r"], "read upstream now")] : []), binding(["esc"], "back")],
    load,
    render(area, s) {
      drawList(s, area, ctx.theme.c, state, rows());
    },
    key(e) {
      if (e.key === "r") {
        runAsync(ctx, async () => {
          const started = await startRadar(f.app, repo, f.user);
          if (started.ok) ctx.toast(`Read upstream for ${started.read} packages.`);
          else ctx.toast(started.why, "danger");
          await load();
        });
        return true;
      }
      return state.key(e, rows().length);
    },
  };
}
