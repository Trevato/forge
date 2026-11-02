/**
 * What needs the owner, in the terminal, a forge admin's: the forge's needs,
 * where snapshots go and the newest one, and every failure domain with what
 * the owner does — `ownerView`, the action behind Settings → Backups → Failure domains
 * and Backups. Anyone else gets an empty screen that says nothing exists.
 */

import { ownerView, type OwnerView } from "../../actions/resilience.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { fill, len, split } from "../ui/layout.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import type { Session } from "../session.ts";
import { ListState, drawList, type ListRow } from "./common.ts";
import type { PaletteEntry } from "./entries.ts";

export function ownerRows(v: OwnerView): ListRow[] {
  const needs: ListRow[] =
    v.needs.length === 0
      ? [{ title: "Needs", secondary: "all fine", meta: "Nothing asks for the owner now." }]
      : v.needs.map((n) => ({ title: "Needs", secondary: "act", meta: n }));
  const s = v.snapshots;
  const snaps: ListRow = {
    title: "Snapshots",
    secondary: s.where === null ? "none" : s.last === null ? "none yet" : "kept",
    meta:
      s.where === null
        ? "This forge was given nowhere to put a snapshot."
        : `To ${s.where}${s.mirror === null ? ", mirrored nowhere" : `, mirrored to ${s.mirror}`} · ${
            s.last === null
              ? "no snapshot read back"
              : `last ${s.last.at.slice(0, 16).replace("T", " ")} UTC, ${s.last.bytes} bytes`
          }`,
  };
  const domains: ListRow[] = v.domains.map((d) => ({
    title: d.name,
    secondary: `back in ~${d.backMinutes} min`,
    meta: `${d.breaks} · Owner: ${d.owner}`,
  }));
  return [...needs, snaps, ...domains];
}

export function ownerScreen(f: Session, ctx: Ctx): Screen {
  const state = new ListState();
  let view: OwnerView | undefined;
  let loaded = false;

  const screen: Screen = {
    title: "What needs the owner",
    keys: [binding(["j", "k"], "move cursor")],
    async load() {
      const got = await ownerView(f.app, f.user);
      view = got.ok ? got.value : undefined;
      loaded = true;
      state.clamp(view === undefined ? 0 : ownerRows(view).length);
      ctx.invalidate();
    },
    render(area, s) {
      const c = ctx.theme.c;
      const [head, list] = split(area, "v", [len(1), fill(1)]);
      const note = !loaded ? "Loading…" : view === undefined ? "Nothing here." : "The forge's needs, its snapshots, and each failure domain";
      s.text(head!.x, head!.y, truncate(note, head!.w), style(c.mutedFg, c.bg), head!.x + head!.w);
      drawList(s, list!, c, state, view === undefined ? [] : ownerRows(view));
    },
    key(e) {
      return state.key(e, view === undefined ? 0 : ownerRows(view).length);
    },
  };
  return screen;
}

/** What needs the owner: needs, snapshot store, every failure domain (#1236). */
export const entry: PaletteEntry = {
  id: "owner",
  title: "Owner's needs",
  hint: "what needs the owner, snapshots, failure domains",
  offered: (session) => session.user?.isAdmin === true && session.user.kind !== "agent",
  run: (session, ctx) => ctx.push(ownerScreen(session, ctx)),
};
