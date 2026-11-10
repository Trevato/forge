/**
 * The forges this one sent (#2211) in a card: one row per client with its
 * claim state, the apps-running note and the crew's spend today, in the words /forges uses. Never a
 * claim link; that stays on the page.
 */

import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { ATTENTION_WORDS, CLAIM_WORDS, claimState, creditWords, runningWords, spendWords, type ClientRow } from "../../spawn/clients.ts";
import { useLine } from "../../spawn/usage.ts";
import { timeAgo } from "../../web/ui.ts";
import { card } from "../ui/widgets.ts";
import { drawFacts, runAsync } from "./common.ts";
import type { PaletteEntry } from "./entries.ts";
import { clientRows } from "../../spawn/clients.ts";
import { diskWords } from "../../spawn/disk_mount.ts";
import { changeLink, removeForge, stopForge } from "../../spawn/manage.ts";
import { undoable, type LinkInfo } from "../../spawn/claim.ts";
import { confirmScreen, pickerScreen } from "./common.ts";
import type { Session } from "../session.ts";

/** [name, "Not reporting · for Maria · Claimed · 3 apps running"] per row; an empty line when none. */
export function forgeLines(rows: readonly ClientRow[]): [string, string][] {
  if (rows.length === 0) return [["", "You have not sent a forge yet"]];
  return rows.flatMap((r): [string, string][] => [[
    r.name,
    [r.made ? (r.awake === true ? "awake" : "asleep") : null, r.attention === null ? null : ATTENTION_WORDS[r.attention], r.for === null ? null : `for ${r.for}`, CLAIM_WORDS[claimState(r)], linkWords(r.link), runningWords(r), r.stage?.words ?? null, r.nextStep.words, spendWords(r)?.words ?? null, creditWords(r), useLine(r.size, r.use), r.made ? diskWords(r.disk) : null, r.lastHeartbeatAt === null ? "no heartbeat yet" : `heartbeat ${timeAgo(r.lastHeartbeatAt)}`]
      .filter((m): m is string => m !== null)
      .join(" · "),
  ], ...addressLines(r)]);
}

/** "link open", "link ended (undo with u)": what the sender can do about the link, as /forges shows it. */
function linkWords(link: LinkInfo | null): string | null {
  if (link === null || link.state === "used") return null;
  return link.state === "open" ? "link open" : undoable(link) ? "link ended, undo with u" : "link ended";
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
  // Revoke and Undo are the page's buttons, through the same action (`changeLink`): an admin's, for the rows that allow it.
  const changeOne = (act: "revoke" | "undo"): void => {
    const user = session?.user;
    if (session === undefined || user?.isAdmin !== true) return;
    const items = rows
      .filter((r) => r.link !== null && (act === "revoke" ? r.link.state === "open" : undoable(r.link)))
      .map((r) => ({ id: r.name, label: r.name, hint: act === "revoke" ? "link open" : "link ended" }));
    if (items.length === 0) return ctx.toast(act === "revoke" ? "No open link to end" : "No ended link to bring back");
    ctx.push(
      pickerScreen(ctx, screen, {
        title: act === "revoke" ? "End which link?" : "Bring back which link?",
        items,
        onPick: (ids) => {
          if (ids[0] !== undefined) void changeLink(session.app, user.id, ids[0], act).then((done) => ctx.toast(done.says, done.ok ? "success" : "danger"));
        },
      }),
    );
  };
  const screen: Screen = {
    title: "Forges you sent",
    keys: [binding(["s"], "stop one (sleep now)"), binding(["x"], "remove one"), binding(["l"], "end a link"), binding(["u"], "undo an ended link"), binding(["esc"], "close")],
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
      else if (e.key === "l") changeOne("revoke");
      else if (e.key === "u") changeOne("undo");
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
