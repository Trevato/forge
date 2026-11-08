/**
 * Next up in the terminal (#8694): the owner's one ranked list, the page's
 * door and not a second implementation. A move is `rankIssue`, the action the
 * page and MCP `next_up` reach, so who may move what is decided there: a
 * reader sees the order and no keys to change it, an agent likewise, and a
 * guest sees what `canRead` lets the web show, sealed issues left to the same
 * scope the page uses. `t` puts the issue under the cursor on top, `u` and
 * `d` move it a place, `n` puts it behind the Later gate; each saves at once.
 * Subscribed to the bus while on the stack, so a move made on the web, over
 * MCP or in another terminal reorders the list here, and one made here
 * (`issue.ranked`) reaches the web the same way.
 */

import { rankedWords, rankIssue, stepTo, type Place, placeOf } from "../../actions/next.ts";
import { nextUp, type NextRow } from "../../core/next_up.ts";
import { canRead, canWrite, type Repo } from "../../core/repos.ts";
import { sealedScope } from "../../core/sealed.ts";
import { notStartable } from "../../crew/not_startable.ts";
import { rangeWords, weekView, type WeekView } from "../../flow/week.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { fill, len, split } from "../ui/layout.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import type { Session } from "../session.ts";
import { issueScreen } from "./issue.ts";
import { local } from "./where.ts";
import { ListState, drawList, hitList, live, type ListRow } from "./common.ts";

/** What reorders or reshapes the list: a rank, or an issue opening, closing or changing what it waits for. */
const LIVE_KINDS = ["issue.ranked", "issue.opened", "issue.closed", "issue.reopened", "issue.blocked", "issue.unblocked"];

export function nextScreen(f: Session, ctx: Ctx, repo: Repo): Screen {
  const state = new ListState();
  let rows: readonly NextRow[] = [];
  let away = 0;
  let week: WeekView | undefined;
  let loaded = false;
  // Read at use, not at open: access can change under a session.
  const may = (): boolean =>
    f.user !== undefined && f.user.kind === "user" && canWrite(f.db, repo, f.user);

  const reload = (follow?: number): void => {
    if (!canRead(f.db, repo, f.user)) {
      rows = [];
      away = 0;
      week = undefined;
    } else {
      const scope = sealedScope(f.db, repo, f.user);
      const next = nextUp(f.db, repo, scope, (ready) => notStartable(f.app, repo, ready, scope));
      rows = next.rows;
      away = next.notNowTotal;
      week = weekView(f.db, repo.id, rows, new Date());
    }
    loaded = true;
    if (follow !== undefined) {
      const at = rows.findIndex((r) => r.issue.number === follow);
      if (at >= 0) state.index = at;
    }
    state.clamp(rows.length);
    ctx.invalidate();
  };

  const current = (): NextRow | undefined => rows[state.index];

  const rank = (to: Place | undefined): void => {
    const row = current();
    if (row === undefined || to === undefined || !may()) return;
    const done = rankIssue(f.app, f.user!, repo, row.issue.number, to);
    if (!done.ok) {
      ctx.toast(done.error.message, "danger");
      return;
    }
    reload(row.issue.number);
    ctx.toast(rankedWords(row.issue.number, to), "success");
  };
  const step = (by: -1 | 1): void => {
    const to = stepTo(rows.map((r) => r.issue.number), state.index, by);
    rank(to === undefined ? undefined : placeOf(to));
  };

  const open = (): void => {
    const row = current();
    if (row !== undefined) ctx.push(issueScreen(f, ctx, local(f, repo), row.issue.number));
  };

  // The cut line is a muted line under the last row that fits, as on the page.
  const listRows = (): ListRow[] =>
    rows.map((r, at) => {
      const estimate = week?.priced.find((p) => p.number === r.issue.number)?.estimate;
      const cut = week?.cut;
      const ends = cut !== undefined && cut.unsure === null && cut.fits.length > 0 && at === cut.fits.length - 1;
      return {
        title: `${r.place === null ? "·" : r.place}. #${r.issue.number} ${r.issue.title}`,
        secondary: r.role === "blocker" ? "Blocker" : "Enabler",
        meta: [estimate === undefined ? "" : rangeWords(estimate), r.onIt === null ? "" : `on it: ${r.onIt}`, r.why ?? ""]
          .filter((x) => x !== "")
          .join(" · "),
        ...(ends ? { note: `── this week ends here (${cut.fits.length} fit): below reads as next week ──` } : {}),
      };
    });

  const screen: Screen = {
    title: "Next up",
    get keys() {
      const on = may() && current() !== undefined;
      return [
        binding(["j", "k"], "move cursor"),
        binding(["enter"], "open"),
        binding(["t"], "top", { disabled: !on || state.index === 0 }),
        binding(["u"], "up", { disabled: !on || state.index === 0 }),
        binding(["d"], "down", { disabled: !on || state.index >= rows.length - 1 }),
        binding(["n"], "not now", { disabled: !on }),
      ];
    },
    load(signal) {
      live(f, signal, { repoId: repo.id, kinds: LIVE_KINDS }, () => reload());
      reload();
      return Promise.resolve();
    },
    render(area, s) {
      const c = ctx.theme.c;
      const [head, list] = split(area, "v", [len(1), fill(1)]);
      const note = !loaded
        ? "Loading…"
        : rows.length === 0
          ? "Nothing is ready: everything open waits for something."
          : `${week?.sentence ?? ""}${may() ? "" : " · you can read this order, not change it"}${away > 0 ? ` · ${away} not now` : ""}`;
      s.text(head!.x, head!.y, truncate(note, head!.w), style(c.mutedFg, c.bg), head!.x + head!.w);
      drawList(s, list!, c, state, listRows());
      hitList(ctx, list!, state, rows.length, { open });
    },
    key(e) {
      if (state.key(e, rows.length)) return true;
      if (e.ctrl || e.alt) return false;
      if (e.key === "enter") open();
      else if (e.key === "t") rank({ to: "top" });
      else if (e.key === "u") step(-1);
      else if (e.key === "d") step(1);
      else if (e.key === "n") rank({ to: "not_now" });
      else return false;
      return true;
    },
  };
  return screen;
}
