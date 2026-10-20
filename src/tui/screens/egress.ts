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
  const reload = async (): Promise<void> => {
    const view = await egressView(f.app, f.user, repo);
    rows = view.ok ? view.value.rows : [];
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
    keys: [binding(["g"], "grant"), binding(["x"], "revoke"), binding(["j", "k"], "move cursor")],
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
      const row = rows[state.index];
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
