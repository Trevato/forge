/**
 * An app's private destinations in the terminal, a site admin's: the list the
 * settings page shows, with `g` to grant the one under the cursor and `x` to
 * revoke it. The actions decide who may; anyone else is offered nothing.
 */

import {
  egressView,
  grantAppEgress,
  revokeAppEgress,
  type EgressRow,
} from "../../actions/egress_grants.ts";
import { egressSnapshot } from "../../apps/egress.ts";
import { bytes } from "../../system/format.ts";
import type { Repo } from "../../core/repos.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import { fill, len, split } from "../ui/layout.ts";
import type { Session } from "../session.ts";
import { ListState, drawList, type ListRow } from "./common.ts";

export function egressScreen(f: Session, ctx: Ctx, repo: Repo): Screen {
  const state = new ListState();
  let rows: EgressRow[] = [];
  // Whether the action says this viewer may change grants; it decides, not the screen.
  let canChange = false;
  const reload = async (): Promise<void> => {
    const view = await egressView(f.app, f.user, repo);
    canChange = view.ok && view.value.canChange;
    // Deliberately stricter than the web page, which shows a repository admin the
    // list read-only: the terminal's list is a site admin's, as #3618 asks.
    rows = view.ok && view.value.canChange ? view.value.rows : [];
    state.clamp(rows.length);
    ctx.invalidate();
  };
  void reload();
  const lines = (): ListRow[] =>
    rows.map((r) => ({
      title: r.destination,
      meta: r.granted
        ? `granted by ${r.grantedBy} ${(r.grantedAt ?? "").slice(0, 16).replace("T", " ")} UTC`
        : "asked for, not granted",
    }));
  const change = async (
    done: Promise<{ ok: boolean }> | { ok: boolean },
    said: string,
  ): Promise<void> => {
    const result = await done;
    await reload();
    if (result.ok) ctx.toast(said, "success");
    else ctx.toast("that could not be changed", "danger");
  };

  const screen: Screen = {
    title: "Private egress",
    get keys() {
      return [
        ...(canChange ? [binding(["g"], "grant"), binding(["x"], "revoke")] : []),
        binding(["j", "k"], "move cursor"),
      ];
    },
    render(area, s) {
      const c = ctx.theme.c;
      const [head, list] = split(area, "v", [len(1), fill(1)]);
      const note =
        rows.length === 0
          ? `forge.json of ${repo.ownerName}/${repo.name} asks for no private destination.`
          : `${rows.length} for ${repo.ownerName}/${repo.name}`;
      s.text(head!.x, head!.y, truncate(note, head!.w), style(c.mutedFg, c.bg), head!.x + head!.w);
      drawList(s, list!, c, state, lines());
    },
    key(e) {
      const row = canChange ? rows[state.index] : undefined;
      if (e.key === "g" && row !== undefined) {
        void change(grantAppEgress(f.app, f.user, repo, row.destination), `${row.destination} is granted.`);
        return true;
      }
      if (e.key === "x" && row !== undefined) {
        void change(revokeAppEgress(f.app, f.user, repo, row.destination), `${row.destination} is revoked.`);
        return true;
      }
      return state.key(e, rows.length);
    },
  };
  return screen;
}

/**
 * The egress connections open right now, per app and destination: the
 * Capacity page's card, for a site admin. Read again on every draw, so it
 * moves as connections do; anyone else is offered nothing.
 */
export function connectionsScreen(f: Session, ctx: Ctx): Screen {
  const state = new ListState();
  const lines = (): ListRow[] =>
    f.user?.isAdmin !== true
      ? []
      : egressSnapshot().map((r) => ({
          title: r.label === "" ? "(unlabelled)" : r.label,
          meta: `${r.destination} · ${r.open} open · ${bytes(r.bytesIn)} in · ${bytes(r.bytesOut)} out`,
        }));
  return {
    title: "Egress connections",
    keys: [binding(["j", "k"], "move cursor")],
    render(area, s) {
      const c = ctx.theme.c;
      const rows = lines();
      state.clamp(rows.length);
      const [head, list] = split(area, "v", [len(1), fill(1)]);
      const note =
        rows.length === 0
          ? "No app holds an egress connection open."
          : `${rows.length} destination${rows.length === 1 ? "" : "s"} in use`;
      s.text(head!.x, head!.y, truncate(note, head!.w), style(c.mutedFg, c.bg), head!.x + head!.w);
      drawList(s, list!, c, state, rows);
    },
    key(e) {
      return state.key(e, lines().length);
    },
  };
}
