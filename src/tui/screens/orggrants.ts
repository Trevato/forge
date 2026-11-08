/**
 * An organization's default Claude subscription grants in the terminal, as the
 * Subscriptions form on the organization page has them: one decision for every
 * repository of the organization that has no grant of its own. First the
 * viewer's organizations they administer; then one row for everyone and one
 * per agent on the forge, each with the accounts granted at the organization.
 * `h`/`l` move between accounts, `space` toggles the one under the cursor and
 * the row is saved whole through `setGrants`, the page's write. The gate is
 * the page's `POST /:owner/-/subscriptions`: an admin of the organization who
 * is also a forge admin; an agent's session is offered nothing. Names and
 * kinds only, never a token. The row write is `saveGrants`' per-row
 * `setGrants` call, made directly because `saveGrants` reads a request form.
 */

import { listAgents } from "../../core/agents.ts";
import { accessAllows, listOrgsForUser, orgAccess } from "../../core/orgs.ts";
import { EVERYONE, listGrants, listSubscriptions, setGrants, type Subscription } from "../../core/subscriptions.ts";
import { getUserById, type User } from "../../core/users.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import type { Session } from "../session.ts";
import { fill, len, split } from "../ui/layout.ts";
import { ListState, drawList, type ListRow } from "./common.ts";
import type { PaletteEntry } from "./entries.ts";

/** The page's sentence after a save. */
export const SAVED = "Saved. Every repository here without a grant of its own follows it.";

/** Read afresh, so an admin demoted while a screen is open is refused at the next toggle. */
const isForgeAdmin = (user: User | undefined): boolean => user?.isAdmin === true && user.kind === "user";

/** The organizations this session may set grants for: none unless a forge admin who is not an agent. */
export function grantableOrgs(f: Session): User[] {
  const user = f.user === undefined ? undefined : getUserById(f.app.db, f.user.id);
  if (user === undefined || !isForgeAdmin(user)) return [];
  return listOrgsForUser(f.app.db, user.id)
    .filter((org) => accessAllows(orgAccess(f.app.db, org.id, user), "admin"))
    .sort((a, b) => a.username.localeCompare(b.username));
}

function grantsScreen(f: Session, ctx: Ctx, org: User): Screen {
  const state = new ListState();
  let note = "";
  let col = 0;
  const db = f.app.db;
  const admitted = () => grantableOrgs(f).some((o) => o.id === org.id);

  let subs: Subscription[] = [];
  let who: { id: string; name: string }[] = [];
  let granted = new Map<string, Set<string>>();
  const load = (): void => {
    subs = listSubscriptions(db);
    who = [{ id: EVERYONE, name: "everyone" }, ...listAgents(db).map((a) => ({ id: a.user.id, name: `@${a.user.username}` }))];
    granted = new Map();
    for (const g of listGrants(db, org.id)) {
      const set = granted.get(g.agentId) ?? new Set<string>();
      set.add(g.subscriptionId);
      granted.set(g.agentId, set);
    }
    state.clamp(who.length);
    col = Math.max(0, Math.min(col, subs.length - 1));
  };
  load();

  const rows = (): ListRow[] =>
    who.map((w, i) => {
      const has = granted.get(w.id) ?? new Set<string>();
      const chips = subs.map((s, j) => `${i === state.index && j === col ? ">" : " "}[${has.has(s.id) ? "x" : " "}] ${s.name}`);
      return { title: w.name, below: [subs.length === 0 ? "No subscription yet." : chips.join("  ")] };
    });

  const screen: Screen = {
    title: `Grants of ${org.username}`,
    keys: [binding(["j", "k"], "move row"), binding(["h", "l"], "move account"), binding(["space"], "toggle"), binding(["esc"], "back")],
    render(area, s) {
      const c = ctx.theme.c;
      const [head, body] = split(area, "v", [len(1), fill(1)]);
      const text = note !== "" ? note : "One decision for every repository here without a grant of its own. space toggles.";
      s.text(head!.x, head!.y, truncate(text, head!.w), style(c.mutedFg, c.bg), head!.x + head!.w);
      drawList(s, body!, c, state, rows());
    },
    key(e) {
      note = "";
      if (state.key(e, who.length)) return true;
      if (e.ctrl || e.alt) return false;
      if (e.key === "h" || e.key === "left") col = Math.max(0, col - 1);
      else if (e.key === "l" || e.key === "right") col = Math.max(0, Math.min(subs.length - 1, col + 1));
      else if (e.key === " " || e.key === "space") {
        const w = who[state.index];
        const sub = subs[col];
        if (w === undefined || sub === undefined) return true;
        if (!admitted()) {
          note = "Only an admin of this organization who is a forge admin sets its grants.";
        } else {
          const has = new Set(granted.get(w.id) ?? []);
          if (has.has(sub.id)) has.delete(sub.id);
          else has.add(sub.id);
          setGrants(db, org.id, w.id, [...has]);
          load();
          note = SAVED;
        }
      } else return false;
      ctx.invalidate();
      return true;
    },
  };
  return screen;
}

export function orgGrantsScreen(f: Session, ctx: Ctx): Screen {
  const state = new ListState();
  const orgs = grantableOrgs(f);
  const rows: ListRow[] = orgs.map((o) => ({ title: o.username, secondary: "organization" }));
  return {
    title: "Org grants",
    keys: [binding(["j", "k"], "move cursor"), binding(["enter"], "grants"), binding(["esc"], "back")],
    render(area, s) {
      drawList(s, area, ctx.theme.c, state, rows);
    },
    key(e) {
      if (state.key(e, orgs.length)) return true;
      if (e.ctrl || e.alt || e.key !== "enter") return false;
      const org = orgs[state.index];
      if (org === undefined) return false;
      ctx.push(grantsScreen(f, ctx, org));
      return true;
    },
  };
}

/** An organization's default grants, as its page's Subscriptions form has them: a forge admin who administers one. */
export const entry: PaletteEntry = {
  id: "org-grants",
  title: "org grants",
  hint: "which Claude accounts your organization's repositories without a grant of their own use",
  after: ["org-teams", "subscriptions", "teams"],
  offered: (session) => grantableOrgs(session).length > 0,
  run: (session, ctx) => ctx.push(orgGrantsScreen(session, ctx)),
};
