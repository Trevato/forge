/**
 * Flows in the terminal (#9434): the page's lines from the same reads —
 * `readFlows` gates forks and the origin with `canRead`/`visibleForks`, and
 * `startRadar` gates the `r` key with the page's admin check — so this door
 * decides nothing of its own. Access is read at every draw.
 */

import { takeFromOrigin } from "../../actions/origins.ts";
import { canRead, type Repo } from "../../core/repos.ts";
import { readRadar, type DepLine } from "../../flows/radar.ts";
import { pinsOf } from "../../flows/run.ts";
import { probeLinks } from "../../flows/probe.ts";
import { mayStartRadar, startRadar } from "../../flows/start.ts";
import { readFlows, type FlowLine, type Health } from "../../flows/view.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Session } from "../session.ts";
import { ListState, drawList, live, runAsync, type ListRow } from "./common.ts";

const HEALTH_TONE: Partial<Record<Health, "danger" | "attn">> = { diverged: "danger", unread: "danger", behind: "attn", stale: "attn" };

const flowRow = (side: string) => (l: FlowLine): ListRow => ({
  title: `${side} ${l.label}`,
  secondary: l.state,
  ...(l.problem ? { tone: "danger" as const } : HEALTH_TONE[l.health] ? { tone: HEALTH_TONE[l.health]! } : {}),
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
  /** The actions the page would offer this person: the same reads decide. */
  const actions = () => (visible() ? readFlows(f.db, repo, f.user).inbound.flatMap((l) => (l.action ? [l.action] : [])) : []);
  const load = async (signal?: AbortSignal): Promise<void> => {
    if (signal) live(f, signal, { repoId: repo.id, kinds: ["repo.links_probed", "repo.upstream_checked"] }, () => ctx.invalidate());
    deps = visible() ? readRadar(f.db, repo.id, await pinsOf(f.app, repo)) : [];
    ctx.invalidate();
  };
  return {
    title: "Flows",
    keys: [binding(["j", "k"], "move cursor"), ...(mayStartRadar(f.app, repo, f.user) ? [binding(["r"], "read upstream now"), binding(["c"], "compare heads now")] : []), ...(actions().some((a) => a.post) ? [binding(["p"], "pull in what's new")] : []), ...(actions().some((a) => !a.post) ? [binding(["o"], "offer what's useful")] : []), binding(["esc"], "back")],
    load,
    render(area, s) {
      drawList(s, area, ctx.theme.c, state, rows());
    },
    key(e) {
      if (e.ctrl || e.alt) return state.key(e, rows().length);
      if (e.key === "c" && mayStartRadar(f.app, repo, f.user)) {
        runAsync(ctx, async () => {
          const probed = await probeLinks(f.app, repo, f.user);
          if (probed.ok) ctx.toast(`Compared ${probed.read} links.`);
          else ctx.toast(probed.why, "danger");
          await load();
        });
        return true;
      }
      if (e.key === "p" && actions().some((a) => a.post)) {
        runAsync(ctx, async () => {
          const done = await takeFromOrigin(f.app, f.user, repo);
          if (!done.ok) ctx.toast("that could not be taken", "danger");
          else if (done.value.kind === "conflict") ctx.toast("The mirror holds commits the origin lacks: nothing moved.", "danger");
          else if (done.value.kind === "unread") ctx.toast("The origin could not be read just now.", "danger");
          else ctx.toast("Took what's new from the origin.");
          await load();
        });
        return true;
      }
      if (e.key === "o") {
        const offer = actions().find((a) => !a.post);
        if (!offer) return false;
        ctx.toast(`Open ${offer.href} on the web to offer it.`);
        return true;
      }
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
