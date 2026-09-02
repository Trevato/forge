/**
 * Every repository this session can see, newest first. The visibility rule is
 * `listReposVisibleTo` and nothing else — a private repo is not filtered out
 * of a list the TUI built, it never enters it.
 */

import { listReposVisibleTo, type Repo } from "../../core/repos.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { fill, len, split } from "../ui/layout.ts";
import { emptyState } from "../ui/widgets.ts";
import type { Session } from "../session.ts";
import { Filter, ListState, drawList, runAsync } from "./common.ts";
import { ownerScreen } from "./owner.ts";
import { repoScreen } from "./repo.ts";

const PAGE = 100;

export function exploreScreen(f: Session, ctx: Ctx): Screen {
  let repos: Repo[] = [];
  let more = false;
  const state = new ListState();
  const filter = new Filter();

  const reload = (): void => {
    repos = listReposVisibleTo(f.db, f.user, { limit: PAGE });
    more = repos.length === PAGE;
    ctx.invalidate();
  };

  const loadMore = (): void => {
    const last = repos[repos.length - 1];
    if (!last) return;
    const next = listReposVisibleTo(f.db, f.user, {
      limit: PAGE,
      cursor: last.id,
    });
    repos = [...repos, ...next];
    more = next.length === PAGE;
    ctx.invalidate();
  };

  const shown = (): Repo[] =>
    repos.filter((repo) =>
      filter.matches(`${repo.ownerName}/${repo.name} ${repo.description}`),
    );

  return {
    title: "Explore",
    keys: [
      binding(["j", "k"], "move"),
      binding(["enter"], "open"),
      binding(["o"], "owner"),
      binding(["/"], "filter"),
      binding(["r"], "refresh"),
    ],
    load() {
      reload();
      return Promise.resolve();
    },
    render(area, s) {
      const c = ctx.theme.c;
      const [box, body] = split(area, "v", [len(1), fill(1)]);
      ctx.setCursor(filter.render(s, box!, c, "filter repositories"));
      const rows = shown();
      if (rows.length === 0) {
        emptyState(s, body!, c, {
          title: "No repositories",
          body: "Nothing here is visible to you.",
        });
        return;
      }
      const list = rows.map((repo) => ({
        title: `${repo.ownerName}/${repo.name}`,
        secondary: repo.description,
        meta: repo.visibility === "private" ? "private" : "",
      }));
      if (more && !filter.on)
        list.push({ title: "Load more…", secondary: "", meta: "" });
      drawList(s, body!, c, state, list);
    },
    key(e) {
      if (filter.key(e)) {
        state.clamp(shown().length);
        return true;
      }
      const rows = shown();
      if (state.key(e, rows.length + (more ? 1 : 0))) return true;
      if (e.key === "enter") {
        const repo = rows[state.index];
        if (repo) ctx.push(repoScreen(f, ctx, repo));
        else loadMore();
        return true;
      }
      if (e.key === "o") {
        const repo = rows[state.index];
        if (repo) ctx.push(ownerScreen(f, ctx, repo.ownerName));
        return true;
      }
      if (e.key === "r") {
        runAsync(ctx, async () => reload());
        return true;
      }
      return false;
    },
  };
}
