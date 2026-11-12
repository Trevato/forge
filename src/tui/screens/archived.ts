/**
 * Archived repositories in the terminal: what /apps?archived=1 lists on the
 * web. Archiving hides a repository from the dashboard, never from its
 * readers; this screen is the way back. Enter opens the About card; `a` restores
 * the selected one through `updateRepoSettings`, offered only to a person who
 * administers it.
 */

import { updateRepoSettings } from "../../actions/repos.ts";
import { appsForRepos } from "../../core/apps.ts";
import { canAdmin, listReposVisibleTo, type Repo } from "../../core/repos.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import type { Session } from "../session.ts";
import { fill, len, split } from "../ui/layout.ts";
import { emptyState } from "../ui/widgets.ts";
import { aboutScreen } from "./about.ts";
import { ListState, drawList, type ListRow } from "./common.ts";
import type { PaletteEntry } from "./entries.ts";
import { local } from "./where.ts";

/** Newest archived first; visibility is decided in SQL, as the web's list does. */
function archivedRepos(f: Session): { repos: Repo[]; withApp: Set<string> } {
  const repos = listReposVisibleTo(f.db, f.user, { limit: 200, archivedOnly: true }).sort((a, b) =>
    (b.archivedAt ?? "").localeCompare(a.archivedAt ?? ""),
  );
  const withApp = new Set(appsForRepos(f.db, repos.map((r) => r.id)).keys());
  return { repos, withApp };
}

export function archivedScreen(f: Session, ctx: Ctx): Screen {
  const state = new ListState();
  let { repos, withApp } = archivedRepos(f);
  const selected = (): Repo | undefined => repos[state.index];
  // A person's, an admin's: the About card's gate for `a`.
  const mayRestore = (repo: Repo | undefined): repo is Repo =>
    repo !== undefined && f.user !== undefined && f.user.kind !== "agent" && canAdmin(f.db, repo, f.user);

  const screen: Screen = {
    title: "Archived repositories",
    keys: [binding(["j", "k"], "move cursor"), binding(["enter"], "about"), binding(["a"], "restore")],
    render(area, s) {
      const c = ctx.theme.c;
      const [head, body] = split(area, "v", [len(1), fill(1)]);
      if (repos.length === 0) {
        emptyState(s, body!, c, { title: "Nothing archived." });
        return;
      }
      const rows: ListRow[] = repos.map((r) => ({
        title: `${r.ownerName}/${r.name}`,
        secondary: (r.archivedAt ?? "").slice(0, 10),
        meta: withApp.has(r.id) ? "app spun down" : "",
      }));
      const line = mayRestore(selected()) ? "enter opens it · a restores it" : "enter opens it";
      s.text(head!.x, head!.y, truncate(line, head!.w), style(c.mutedFg, c.bg), head!.x + head!.w);
      drawList(s, body!, c, state, rows);
    },
    key(e) {
      if (state.key(e, repos.length)) return true;
      if (e.ctrl || e.alt) return false;
      const repo = selected();
      if (repo === undefined) return false;
      if (e.key === "enter") {
        ctx.push(aboutScreen(f, ctx, screen, local(f, repo), undefined, ""));
        return true;
      }
      if (e.key === "a" && mayRestore(repo)) {
        void updateRepoSettings(f.app, f.user, repo, { archived: false }).then((done) => {
          if (done.ok) {
            ({ repos, withApp } = archivedRepos(f));
            state.clamp(repos.length);
            ctx.toast("restored", "success");
          } else ctx.toast("that could not be changed", "danger");
          ctx.invalidate();
        });
        return true;
      }
      return false;
    },
  };
  return screen;
}

/** Archived repositories, as /apps?archived=1 has them. */
export const entry: PaletteEntry = {
  id: "archived",
  title: "Archived repositories",
  hint: "put away, not gone: open one or restore it",
  offered: (session) => session.user !== undefined,
  run: (session, ctx) => ctx.push(archivedScreen(session, ctx)),
};
