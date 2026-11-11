/**
 * Pulls drifting from main, in the terminal: the section /boards shows, from
 * the same reads (`readDrifts`, `driftingPulls`), and the same one action, the
 * route's: `b` (or enter) asks the pull's agent to bring it up to date, for a
 * writer of its repository. Gated as /boards is: a site admin who is a person.
 *
 *   b, enter  bring the pull up to date     r  read again
 */

import { bringUpToDate } from "../../crew/autonomy.ts";
import { driftingPulls, readDrifts, type DriftingPull } from "../../flow/alarm_drift.ts";
import { getPull } from "../../core/pulls.ts";
import { mayView } from "../../core/sealed.ts";
import { canWrite, getRepo } from "../../core/repos.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Session } from "../session.ts";
import { ListState, drawList, metaOf, runAsync, type ListRow } from "./common.ts";
import type { PaletteEntry } from "./entries.ts";
import { emptyState } from "../ui/widgets.ts";

export const mayDrift = (f: Session): boolean => f.user?.isAdmin === true && f.user.kind !== "agent";

export function driftRows(pulls: readonly DriftingPull[]): ListRow[] {
  return pulls.map((p) => ({ title: `${p.repo} #${p.number}`, meta: metaOf(`${p.landings} landings`, `${p.hours} h behind`) }));
}

/** Ask the pull's agent, as the route does; the words the toast says. */
export function askUpdate(f: Session, p: { readonly repo: string; readonly number: number }): { ok: boolean; says: string } {
  const [owner = "", name = ""] = p.repo.split("/");
  const repo = getRepo(f.db, owner, name);
  const pull = repo ? getPull(f.db, repo.id, p.number) : undefined;
  if (!repo || !pull || !mayView(f.db, repo, pull, f.user)) return { ok: false, says: "That pull is gone." };
  if (!canWrite(f.db, repo, f.user)) return { ok: false, says: "Only someone who can write here brings a pull up to date." };
  const who = pull.state === "open" && pull.mergedAt === null ? bringUpToDate(f.app, repo, pull, []) : undefined;
  return who === undefined
    ? { ok: false, says: "The crew could not take it now (closed, no agent, or it has already tried its limit); say what to do on the pull." }
    : { ok: true, says: `${who} is bringing #${pull.number} up to date with ${pull.baseBranch}.` };
}

export function driftScreen(f: Session, ctx: Ctx): Screen {
  const state = new ListState();
  let pulls: readonly DriftingPull[] = [];
  let loaded = false;
  const read = async (): Promise<void> => {
    pulls = driftingPulls(await readDrifts(f.app), Date.now());
    loaded = true;
    state.clamp(pulls.length);
    ctx.invalidate();
  };
  const ask = (): void => {
    const p = pulls[state.index];
    if (p === undefined) return;
    const r = askUpdate(f, p);
    ctx.toast(r.says, r.ok ? "success" : "danger");
  };
  return {
    title: "Drifting from main",
    keys: [binding(["j", "k"], "move"), binding(["b", "enter"], "bring up to date"), binding(["r"], "read again"), binding(["esc", "q"], "close")],
    load: read,
    render(area, s) {
      if (loaded && pulls.length === 0) {
        emptyState(s, area, ctx.theme.c, { title: "Nothing drifts", body: "No open pull is more than 25 landings or 6 h behind main." });
        return;
      }
      drawList(s, area, ctx.theme.c, state, driftRows(pulls));
    },
    key(e) {
      if (e.key === "esc" || e.key === "q") ctx.pop();
      else if (e.key === "b" || e.key === "enter") ask();
      else if (e.key === "r") runAsync(ctx, read);
      else state.key(e, pulls.length);
      return true;
    },
  };
}

export const entry: PaletteEntry = {
  id: "drift",
  title: "Drifting pulls",
  hint: "open pulls far behind main, and the one action that brings each up to date",
  after: ["boards"],
  offered: mayDrift,
  run: (session, ctx) => ctx.push(driftScreen(session, ctx)),
};
