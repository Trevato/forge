/**
 * The week in the terminal (#8704): the retrospective the forge wrote at the
 * last weekly reset, the page's door and not a second implementation. Its
 * proposals are the list; `enter` or `a` takes the one under the cursor
 * through `takeProposal`, the action the page and MCP `week` reach, so who may
 * take one is decided there: a reader or an agent sees the proposals and the
 * key does nothing. Subscribed to the bus while on the stack, so a new
 * retrospective (`week.retro`) or a proposal taken anywhere (`issue.ranked`)
 * updates the screen here.
 */

import { takeProposal } from "../../actions/week.ts";
import { canRead, canWrite, getRepoById, type Repo } from "../../core/repos.ts";
import { polishSpend, polishWords } from "../../crew/small_share.ts";
import { latestRetro, takenOf, type Retro } from "../../flow/retro.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { fill, len, split } from "../ui/layout.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import type { Session } from "../session.ts";
import { ListState, drawList, hitList, live, type ListRow } from "./common.ts";

const LIVE_KINDS = ["week.retro", "issue.ranked", "repo.settings_updated"];

/** The retrospective's screen of facts, one line each. */
export function summaryLines(retro: Retro): string[] {
  const p = retro.projected;
  return [
    `Week ending ${retro.weekEnd.slice(0, 10)}`,
    p === null
      ? `${retro.shipped.length} shipped; no projection was made.`
      : `${retro.shipped.length} shipped against a projection of ${p.shipLow === p.shipHigh ? p.shipHigh : `${p.shipLow} to ${p.shipHigh}`} (${p.confidence} confidence).`,
    retro.accuracy.compared === 0
      ? "No shipped issue had an estimate to compare."
      : `${retro.accuracy.inside} of ${retro.accuracy.compared} shipped issues cost inside their range.`,
    `Cost most, still open: ${retro.costly.length === 0 ? "none" : retro.costly.map((l) => `#${l.number}`).join(", ")}`,
    `Stuck: ${retro.stuck.length === 0 ? "none" : retro.stuck.map((l) => `#${l.number} (${l.why})`).join("; ")}`,
  ];
}

/** The page's and the tool's polish line: polish spent this week against its share. */
export function polishLine(f: Session, repo: Repo): string {
  const now = getRepoById(f.db, repo.id) ?? repo;
  return polishWords(polishSpend(f.db, now.id, now.polishShare, new Date()));
}

export function weekScreen(f: Session, ctx: Ctx, repo: Repo): Screen {
  const state = new ListState();
  let retro: Retro | undefined;
  let taken: ReadonlySet<number> = new Set();
  let loaded = false;
  // Read at use, not at open: access can change under a session.
  const may = (): boolean => f.user !== undefined && f.user.kind === "user" && canWrite(f.db, repo, f.user);

  const reload = (): void => {
    if (!canRead(f.db, repo, f.user)) {
      retro = undefined;
      taken = new Set();
    } else {
      retro = latestRetro(f.db, repo.id);
      taken = retro === undefined ? new Set() : takenOf(f.db, repo.id, retro.weekEnd);
    }
    loaded = true;
    state.clamp(retro?.proposals.length ?? 0);
    ctx.invalidate();
  };

  const take = (): void => {
    if (retro === undefined || !may() || taken.has(state.index)) return;
    const done = takeProposal(f.app, f.user!, repo, retro.weekEnd, state.index);
    if (!done.ok) {
      ctx.toast(done.error.message, "danger");
      return;
    }
    reload();
    ctx.toast(done.value, "success");
  };

  const listRows = (): ListRow[] =>
    (retro?.proposals ?? []).map((p, i) => ({
      title: p.words,
      secondary: taken.has(i) ? "Taken" : "Proposed",
    }));

  const screen: Screen = {
    title: "The week",
    get keys() {
      const on = may() && retro !== undefined && !taken.has(state.index) && retro.proposals.length > 0;
      return [binding(["j", "k"], "move cursor"), binding(["enter", "a"], "take it", { disabled: !on })];
    },
    load(signal) {
      live(f, signal, { repoId: repo.id, kinds: LIVE_KINDS }, () => reload());
      reload();
      return Promise.resolve();
    },
    render(area, s) {
      const c = ctx.theme.c;
      const lines = !loaded
        ? ["Loading…"]
        : [
            ...(retro === undefined
              ? ["The forge writes this when the weekly window closes. None has closed yet."]
              : summaryLines(retro)),
            polishLine(f, repo),
          ];
      const [head, list] = split(area, "v", [len(lines.length + 1), fill(1)]);
      lines.forEach((line, i) =>
        s.text(head!.x, head!.y + i, truncate(line, head!.w), style(c.mutedFg, c.bg), head!.x + head!.w),
      );
      drawList(s, list!, c, state, listRows());
      hitList(ctx, list!, state, retro?.proposals.length ?? 0, { open: take });
    },
    key(e) {
      const n = retro?.proposals.length ?? 0;
      if (state.key(e, n)) return true;
      if (e.ctrl || e.alt) return false;
      if (e.key === "enter" || e.key === "a") take();
      else return false;
      return true;
    },
  };
  return screen;
}
