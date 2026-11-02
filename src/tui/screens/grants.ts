/**
 * Which Claude subscriptions each crew member of a repository may use, in the
 * terminal, as the repository's Crew settings have them: one row for everyone
 * and one per crew member. `h`/`l` choose a subscription, `space` toggles it
 * and the row is saved whole through `setGrants`. The gate is the page's: a
 * repository admin who is a forge admin and a person. Only the rows offered
 * can be written. A subscription shows its name and kind, never its token.
 */

import { listCrewRoles } from "../../core/agents.ts";
import { canAdmin, type Repo } from "../../core/repos.ts";
import { EVERYONE, listGrants, listSubscriptions, setGrants, type Subscription } from "../../core/subscriptions.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Command } from "../app/palette.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import type { Session } from "../session.ts";
import { fill, len, split } from "../ui/layout.ts";
import { ListState, drawList, type ListRow } from "./common.ts";

const WIDER = "the owner's grant, or the forge's own token";

interface Who {
  readonly id: string;
  readonly label: string;
}

export function grantsScreen(f: Session, ctx: Ctx, repo: Repo): Screen {
  const state = new ListState();
  let at = 0;
  let note = "";
  const admitted = (): boolean =>
    f.user?.isAdmin === true && f.user.kind === "user" && canAdmin(f.db, repo, f.user);

  let pool: Subscription[] = [];
  let who: Who[] = [];
  let listed: ListRow[] = [];
  const load = (): void => {
    pool = admitted() ? listSubscriptions(f.db) : [];
    who = admitted()
      ? [{ id: EVERYONE, label: "Everyone on the crew" }, ...listCrewRoles(f.db, repo.id).map((c) => ({ id: c.agent.user.id, label: c.agent.user.username }))]
      : [];
    const granted = new Map<string, Set<string>>();
    if (admitted())
      for (const g of listGrants(f.db, repo.id)) granted.set(g.agentId, (granted.get(g.agentId) ?? new Set()).add(g.subscriptionId));
    listed = who.map((w, row) => {
      const mine = granted.get(w.id);
      const cells = pool.map((s, i) => {
        const cursor = row === state.index && i === at ? ">" : " ";
        return `${cursor}[${mine?.has(s.id) ? "x" : " "}] ${s.name} (${s.kind})`;
      });
      // One line per subscription under the row, so the cursor cell is never cut off however many there are.
      return {
        title: w.label,
        meta: mine === undefined || mine.size === 0 ? `none of its own: the wider grant applies: ${WIDER}` : "two ticked take turns",
        below: cells,
      };
    });
  };
  load();

  const screen: Screen = {
    title: "Crew grants",
    keys: admitted()
      ? [binding(["j", "k"], "move cursor"), binding(["h", "l"], "choose subscription"), binding(["space"], "toggle"), binding(["esc"], "back")]
      : [],
    render(area, s) {
      const c = ctx.theme.c;
      const [head, body] = split(area, "v", [len(1), fill(1)]);
      const text = !admitted()
        ? "Nothing exists here."
        : pool.length === 0
          ? "Runs here work on the forge's own token. Add one on the Crew subscriptions screen first."
          : note !== ""
            ? note
            : "h and l choose a subscription, space ticks it. Nothing ticked means the wider grant applies.";
      s.text(head!.x, head!.y, truncate(text, head!.w), style(c.mutedFg, c.bg), head!.x + head!.w);
      if (pool.length > 0) drawList(s, body!, c, state, listed);
    },
    key(e) {
      note = "";
      if (!admitted() || pool.length === 0) return false;
      if (state.key(e, who.length)) {
        load();
        return true;
      }
      if (e.ctrl || e.alt) return false;
      if (e.key === "h" || e.key === "left") at = Math.max(0, at - 1);
      else if (e.key === "l" || e.key === "right") at = Math.min(pool.length - 1, at + 1);
      else if (e.key === " " || e.key === "space") {
        // Read at use, so a crew changed under the session is not written to.
        const fresh = [{ id: EVERYONE }, ...listCrewRoles(f.db, repo.id).map((c) => ({ id: c.agent.user.id }))];
        const row = who[state.index];
        const sub = pool[at];
        if (row === undefined || sub === undefined || !fresh.some((w) => w.id === row.id)) {
          note = "That row is no longer on the crew.";
        } else {
          const have = new Set(listGrants(f.db, repo.id).filter((g) => g.agentId === row.id).map((g) => g.subscriptionId));
          if (!have.delete(sub.id)) have.add(sub.id);
          setGrants(f.db, repo.id, row.id, [...have]);
          note = `${row.label}: ${sub.name} ${have.has(sub.id) ? "on" : "off"}.`;
        }
      } else return false;
      load();
      ctx.invalidate();
      return true;
    },
  };
  return screen;
}

/** Settings › Crew's subscriptions, from a repository's `:` palette: a repository admin who is a forge admin. */
export function grantsCommands(f: Session, ctx: Ctx, repo: Repo | undefined): Command[] {
  if (repo === undefined || f.user?.isAdmin !== true || f.user.kind !== "user") return [];
  if (!canAdmin(f.db, repo, f.user)) return [];
  return [
    {
      id: "grants",
      title: "Crew grants",
      hint: "which subscriptions each crew member may use here",
      run: () => ctx.push(grantsScreen(f, ctx, repo)),
    },
  ];
}
