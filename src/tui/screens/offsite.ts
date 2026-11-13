/**
 * The off-site backup lane, in the terminal (#11805): what /system shows
 * under "Off-site backup", in the same order. First the lane's one sentence,
 * then where it writes, whether it seals what it writes, when it last
 * succeeded, and the last restore drill with where it restored from. The
 * reading is `readOffsiteLane`'s, the page's and the MCP tool's (one small
 * file and one row; no network). The gate is /system's: a forge admin who
 * is a person. Read-only.
 */

import { laneWords, readOffsiteLane, type OffsiteLane } from "../../snapshot/offsite_lane.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Session } from "../session.ts";
import { style } from "../term/style.ts";
import { pad } from "../term/width.ts";
import { Scroll, drawLines, hitScroll } from "./common.ts";
import type { PaletteEntry } from "./entries.ts";

const mayRead = (session: Session): boolean => session.user?.isAdmin === true && session.user.kind !== "agent";

const fact = (label: string, value: string): string => `  ${pad(label, 14)}${value}`;

/** The screen's lines; empty for anyone the gate refuses. */
export function offsiteLines(session: Session, l: OffsiteLane = readOffsiteLane(session.app.config.dataDir, session.app.db)): string[] {
  if (!mayRead(session)) return [];
  const lines = [laneWords(l), ""];
  if (l.where !== null)
    lines.push(
      "Backup lane",
      fact("Writes to", l.where),
      fact("Encrypted", l.sealed ? "yes, under the snapshot passphrase" : "no"),
      fact("Last success", l.lastSuccess ?? "never"),
      ...(l.newest === null ? [] : [fact("Newest", l.newest)]),
      "",
    );
  const d = l.drill;
  lines.push("Restore drill");
  if (d === null) lines.push(fact("Last", "never run"));
  else
    lines.push(
      fact("Last", d.at),
      fact("Verdict", d.verdict === "green" ? "green" : `red${d.reason === null ? "" : `: ${d.reason}`}`),
      fact("From", d.from === null ? "not recorded" : `${d.from}${d.offSite ? " (off-site)" : " (on this machine)"}`),
    );
  return lines;
}

export function offsiteScreen(session: Session, ctx: Ctx): Screen {
  const scroll = new Scroll();
  return {
    title: "Off-site backup",
    keys: [binding(["j", "k"], "scroll"), binding(["esc", "q"], "back")],
    render(area, s) {
      const c = ctx.theme.c;
      const lines = offsiteLines(session);
      drawLines(s, area, c, scroll, lines.map((text) => [{ text, style: style(text.startsWith("  ") ? c.mutedFg : c.fg, c.bg) }]));
      hitScroll(ctx, area, scroll, lines.length);
    },
    key(e) {
      if (scroll.key(e, offsiteLines(session).length)) return true;
      if (e.key === "esc" || e.key === "q") {
        ctx.pop();
        return true;
      }
      return false;
    },
  };
}

export const entry: PaletteEntry = {
  id: "offsite",
  title: "Off-site backup",
  hint: "where the sealed lane writes, when it last succeeded, and the last restore drill",
  after: ["footing"],
  offered: mayRead,
  run: (session, ctx) => ctx.push(offsiteScreen(session, ctx)),
};
