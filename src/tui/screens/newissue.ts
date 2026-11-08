/**
 * A new issue from anywhere (`c` on the web): the terminal's door is a
 * palette entry that asks which repository, from the ones the viewer may
 * write, and opens that repository's new-issue form. Enter picks.
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
import { newIssueScreen } from "./issues.ts";

export function newIssuePickScreen(f: Session, ctx: Ctx): Screen {
  const state = new ListState();
  const read = (): Repo[] => listReposWritableTo(f.db, f.user, { limit: 200, withoutArchived: true });
  return {
    title: "New issue: which repository?",
    keys: [binding(["j", "k"], "move cursor"), binding(["enter"], "new issue here")],
    render(area, s) {
      const c = ctx.theme.c;
      const repos = read();
      const [head, list] = split(area, "v", [len(1), fill(1)]);
      const text = repos.length === 0 ? "No repository to open an issue in." : "Which repository?";
      s.text(head!.x, head!.y, truncate(text, head!.w), style(c.mutedFg, c.bg), head!.x + head!.w);
      const rows: ListRow[] = repos.map((r) => ({ title: `${r.ownerName}/${r.name}` }));
      drawList(s, list!, c, state, rows);
    },
    key(e) {
      const repos = read();
      if (state.key(e, repos.length)) return true;
      const repo = repos[state.index];
      if (e.ctrl || e.alt || e.key !== "enter" || repo === undefined) return false;
      ctx.replace(newIssueScreen(f, ctx, repo));
      return true;
    },
  };
}

/** A new issue, as `/new/issue` offers it: anyone signed in. */
export const entry: PaletteEntry = {
  id: "new-issue-anywhere",
  title: "New issue",
  hint: "pick a repository",
  after: ["repos"],
  offered: (session) => session.user !== undefined,
  run: (session, ctx) => ctx.push(newIssuePickScreen(session, ctx)),
};
