/**
 * The forges this one sent (#2211) in a card: one row per client with its
 * claim state, the apps-running note and the crew's spend today, in the words /forges uses. Never a
 * claim link; that stays on the page.
 */

import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { ATTENTION_WORDS, CLAIM_WORDS, claimState, runningWords, spendWords, type ClientRow } from "../../spawn/clients.ts";
import { useLine } from "../../spawn/usage.ts";
import { timeAgo } from "../../web/ui.ts";
import { card } from "../ui/widgets.ts";
import { drawFacts, runAsync } from "./common.ts";
import type { PaletteEntry } from "./entries.ts";
import { clientRows } from "../../spawn/clients.ts";
import { removeForge, stopForge } from "../../spawn/manage.ts";
import { confirmScreen, pickerScreen } from "./common.ts";
import type { Session } from "../session.ts";

/** [name, "Not reporting · for Maria · Claimed · 3 apps running"] per row; an empty line when none. */
export function forgeLines(rows: readonly ClientRow[]): [string, string][] {
  if (rows.length === 0) return [["", "You have not sent a forge yet"]];
  return rows.flatMap((r): [string, string][] => [[
    r.name,
    [r.made ? (r.awake === true ? "awake" : "asleep") : null, r.attention === null ? null : ATTENTION_WORDS[r.attention], r.for === null ? null : `for ${r.for}`, CLAIM_WORDS[claimState(r)], runningWords(r), r.nextStep.words, spendWords(r)?.words ?? null, useLine(r.size, r.use), r.lastHeartbeatAt === null ? "no heartbeat yet" : `heartbeat ${timeAgo(r.lastHeartbeatAt)}`]
      .filter((m): m is string => m !== null)
      .join(" · "),
  ], ...addressLines(r)]);
}

/** Under a forge that is running, not reachable: each public address and what it answered (#7959), as /forges lists them. */
function addressLines(r: ClientRow): [string, string][] {
  if (r.reach === null || r.reach.ok) return [];
  return r.reach.proofs.map((p): [string, string] => ["", `  ${p.ok ? "reachable" : "NOT REACHABLE"} ${p.url.replace(/^https?:\/\//, "")}: ${p.says}`]);
}

/** The lines that fit in `room` rows; when some do not, the last row says how many. */
export function fitLines(lines: [string, string][], room: number): [string, string][] {
  if (lines.length <= room) return lines;
  const kept = lines.slice(0, Math.max(0, room - 1));
  kept.push(["", `+${lines.length - kept.length} more (see /forges)`]);
  return kept;
}

export function forgesScreen(ctx: Ctx, rows: readonly ClientRow[], session?: Session): Screen {
  const lines = forgeLines(rows);
  // Stop and Remove are the page's buttons, through the same actions (`spawn/manage.ts`).
  const choose = (title: string, act: (name: string) => void): void => {
    const items = rows.filter((r) => r.made).map((r) => ({ id: r.name, label: r.name, hint: r.awake === true ? "awake" : "asleep" }));
    if (items.length === 0 || session === undefined) return;
    ctx.push(pickerScreen(ctx, screen, { title, items, onPick: (ids) => { if (ids[0] !== undefined) act(ids[0]); } }));
  };
  const screen: Screen = {
    title: "Forges you sent",
    keys: [binding(["s"], "stop one (sleep now)"), binding(["x"], "remove one"), binding(["esc"], "close")],
    render(area, s) {
      const c = ctx.theme.c;
      const w = Math.min(100, Math.max(30, area.w - 6));
      const h = Math.min(area.h, lines.length + 2);
      const shown = fitLines(lines, h - 2);
      const r = { x: area.x + ((area.w - w) >> 1), y: area.y + ((area.h - h) >> 1), w, h };
      const inner = card(s, r, c, { title: "Forges you sent", focused: true });
      drawFacts(s, { x: inner.x + 1, y: inner.y, w: Math.max(0, inner.w - 1), h: inner.h }, c, shown, c.card);
    },
    key(e) {
      if (e.key === "esc" || e.key === "q") ctx.pop();
      else if (e.key === "s" && session !== undefined)
        choose("Stop which forge?", (name) => void stopForge(session.app, name).then((done) => ctx.toast(done.says, done.ok ? "success" : "danger")));
      else if (e.key === "x" && session !== undefined)
        choose("Remove which forge?", (name) =>
          ctx.push(
            confirmScreen(ctx, screen, {
              title: `Remove ${name}?`,
              body: [`This deletes ${name} and everything in it. It cannot be undone.`],
              actions: [{ label: "Remove it for good", variant: "danger" }, { label: "Keep it" }],
              onChoose: (i) => {
                if (i === 0) void removeForge(session.app, name).then((done) => ctx.toast(done.says, done.ok ? "success" : "danger"));
              },
            }),
          ),
        );
      return true;
    },
  };
  return screen;
}

/** The forges this one sent, as /forges lists them: an admin's only. */
export const entry: PaletteEntry = {
  id: "forges",
  title: "Forges you sent",
  hint: "each forge sent, claimed or not, and its apps",
  offered: (session) => session.user?.isAdmin === true,
  run: (session, ctx) => runAsync(ctx, async () => {
    ctx.push(forgesScreen(ctx, await clientRows(session.app), session));
  }),
};
