/**
 * An app's private destinations in the terminal, a site admin's: the list the
 * settings page shows, with `g` to grant the one under the cursor once `y`
 * confirms it (a grant widens the boundary) and `x` to revoke it once `y`
 * confirms that too. The actions decide who may; anyone else is offered nothing.
 */

import {
  egressView,
  grantAppEgress,
  revokeAppEgress,
  type EgressRow,
} from "../../actions/egress_grants.ts";
import { egressHour } from "../../actions/capacity.ts";
import { egressSnapshot } from "../../apps/egress.ts";
import { bytes } from "../../system/format.ts";
import type { Repo } from "../../core/repos.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import { fill, len, split } from "../ui/layout.ts";
import type { Session } from "../session.ts";
import { ListState, confirmScreen, drawList, runAsync, type ListRow } from "./common.ts";

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
  runAsync(ctx, reload);
  const lines = (): ListRow[] =>
    rows.map((r) => ({
      title: r.destination,
      meta: r.granted
        ? `granted by ${r.grantedBy} ${(r.grantedAt ?? "").slice(0, 16).replace("T", " ")} UTC`
        : "asked for, not granted",
    }));
  // Tracked, so the app counts the write and the reload behind it as busy.
  const change = (done: Promise<{ ok: boolean }> | { ok: boolean }, said: string): void =>
    runAsync(ctx, async () => {
      const result = await done;
      await reload();
      if (result.ok) ctx.toast(said, "success");
      else ctx.toast("that could not be changed", "danger");
    });

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
        if (row.granted) return true;
        const { destination } = row;
        ctx.push(
          confirmScreen(ctx, screen, {
            title: `Let ${repo.ownerName}/${repo.name} reach ${destination}?`,
            body: ["The app's outbound traffic to it is allowed until you revoke it with x."],
            actions: [{ label: "Grant" }, { label: "Cancel", variant: "ghost" }],
            yesNo: true,
            width: 78,
            onChoose: (choice) => {
              if (choice !== 0) return;
              change(grantAppEgress(f.app, f.user, repo, destination), `${destination} is granted.`);
            },
          }),
        );
        return true;
      }
      if (e.key === "x" && row !== undefined) {
        const { destination } = row;
        ctx.push(
          confirmScreen(ctx, screen, {
            title: `Stop ${repo.ownerName}/${repo.name} reaching ${destination}?`,
            body: ["The app's outbound traffic to it is refused until g grants it again."],
            actions: [{ label: "Revoke", variant: "danger" }, { label: "Cancel", variant: "ghost" }],
            yesNo: true,
            width: 78,
            onChoose: (choice) => {
              if (choice !== 0) return;
              change(revokeAppEgress(f.app, f.user, repo, destination), `${destination} is revoked.`);
            },
          }),
        );
        return true;
      }
      return state.key(e, rows.length);
    },
  };
  return screen;
}

/**
 * The egress connections open right now, per app and destination: the
 * Capacity page's card, for a site admin, under the bytes the npm registry
 * sent over the last hour (#7546) and the repository it sent most to (#8382),
 * both from `egressHour`, as the page and MCP read them. Read again on every draw, so it moves as
 * connections do; anyone else is offered nothing.
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
      const [npm, head, list] = split(area, "v", [len(1), len(1), fill(1)]);
      if (f.user?.isAdmin === true) {
        const hour = egressHour(f.app.db);
        const top = hour.npmTopRepoLastHour;
        const most = top === null ? "." : `, most to ${top.repo} (${bytes(top.bytes)}).`;
        const sent = `The npm registry sent ${bytes(hour.npmBytesLastHour)} over the last hour${most}`;
        s.text(npm!.x, npm!.y, truncate(sent, npm!.w), style(c.mutedFg, c.bg), npm!.x + npm!.w);
      }
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
