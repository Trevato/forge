/**
 * Your repositories (/repos on the web): every repository the viewer may
 * write, from `listReposWritableTo`. Enter opens one as the dashboard does.
 */

import { listReposWritableTo, type Repo } from "../../core/repos.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import type { Session } from "../session.ts";
import { fill, len, split } from "../ui/layout.ts";
import { ListState, drawList, type ListRow } from "./common.ts";
import type { PaletteEntry } from "./entries.ts";
import { repoScreen } from "./repo.ts";
import { local } from "./where.ts";

export function repoListScreen(f: Session, ctx: Ctx): Screen {
  const state = new ListState();
  const read = (): Repo[] => listReposWritableTo(f.db, f.user, { limit: 200, withoutArchived: true });
  return {
    title: "Your repositories",
    keys: [binding(["j", "k"], "move cursor"), binding(["enter"], "open")],
    render(area, s) {
      const c = ctx.theme.c;
      const repos = read();
      const [head, list] = split(area, "v", [len(1), fill(1)]);
      const text = repos.length === 0 ? "No repositories yet." : `${repos.length} repositories you may write`;
      s.text(head!.x, head!.y, truncate(text, head!.w), style(c.mutedFg, c.bg), head!.x + head!.w);
      const rows: ListRow[] = repos.map((r) => ({ title: `${r.ownerName}/${r.name}` }));
      drawList(s, list!, c, state, rows);
    },
    key(e) {
      const repos = read();
      if (state.key(e, repos.length)) return true;
      const repo = repos[state.index];
      if (e.ctrl || e.alt || e.key !== "enter" || repo === undefined) return false;
      ctx.push(repoScreen(f, ctx, local(f, repo)));
      return true;
    },
  };
}

/** Your repositories, as /repos lists them: anyone signed in. */
export const entry: PaletteEntry = {
  id: "repos",
  title: "Repositories",
  hint: "the repositories you may write",
  after: ["profile"],
  offered: (session) => session.user !== undefined,
  run: (session, ctx) => ctx.push(repoListScreen(session, ctx)),
};
