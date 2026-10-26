/**
 * A repository's forks, ranked: the same order and words as the forks page
 * (`actions/forks.ts` decides both), so the best of the tree rises here too.
 * Forks that are ahead come first, with the one that has the most to offer on
 * top; those with nothing new follow under their count.
 */

import {
  driftWords,
  nothingNewHeading,
  rankedForksOf,
  MAX_RANKED_FORKS,
  type ForkRanking,
} from "../../actions/forks.ts";
import { canRead, forkTree, listForks, type ForkNode, type Repo } from "../../core/repos.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import { fill, len, split } from "../ui/layout.ts";
import { emptyState } from "../ui/widgets.ts";
import type { Session } from "../session.ts";
import { local } from "./where.ts";
import { repoScreen } from "./workspace.ts";
import { ListState, drawList, plural, type ListRow } from "./common.ts";

/** The rows the screen draws, in order: pure so a test reads them without a terminal. */
export function forkRows(
  ranked: ForkRanking,
  tree: readonly ForkNode[] = [],
): { repo: Repo; name: string; words: string; heading: string }[] {
  const below = new Map(tree.map((n) => [n.repo.id, n.forks]));
  const row = (f: ForkRanking["offering"][number], heading: string) => [
    {
      repo: f.fork,
      name: `${f.fork.ownerName}/${f.fork.name}`,
      words: driftWords(f.drift),
      heading,
    },
    ...(below.get(f.fork.id) ?? []).map((n) => ({
      repo: n.repo,
      name: `  ${n.repo.ownerName}/${n.repo.name}`,
      words: n.deeper === 0 ? "" : `and ${n.deeper} more fork${n.deeper === 1 ? "" : "s"} below`,
      heading: "",
    })),
  ];
  return [
    ...ranked.offering.flatMap((f) => row(f, "")),
    ...ranked.nothingNew.flatMap((f, i) => row(f, i === 0 ? nothingNewHeading(ranked.nothingNew.length) : "")),
  ];
}

export function forksScreen(f: Session, ctx: Ctx, repo: Repo): Screen {
  let ranked: ForkRanking | undefined;
  let tree: ForkNode[] = [];
  const state = new ListState();
  const rows = () => (ranked === undefined ? [] : forkRows(ranked, tree));
  return {
    title: "Forks",
    keys: [binding(["j", "k"], "move"), binding(["enter"], "open this fork"), binding(["esc"], "close")],
    async load() {
      const forks = listForks(f.db, repo.id).filter((r) => canRead(f.db, r, f.user));
      ranked = await rankedForksOf(f.app, repo, forks);
      tree = forkTree(f.db, repo.id, f.user);
      ctx.invalidate();
    },
    render(area, s) {
      const c = ctx.theme.c;
      const [head, body] = split(area, "v", [len(1), fill(1)]);
      const list = rows();
      s.text(
        head!.x,
        head!.y,
        truncate(
          `${repo.ownerName}/${repo.name} · ${plural(ranked?.total ?? 0, "fork")}${ranked?.truncated ? ` · ranking the first ${MAX_RANKED_FORKS}` : ""}`,
          head!.w,
        ),
        style(c.mutedFg, c.bg),
        head!.x + head!.w,
      );
      if (list.length === 0) {
        emptyState(s, body!, c, {
          title: ranked === undefined ? "Reading…" : "No forks yet",
          body: "",
        });
        return;
      }
      drawList(
        s,
        body!,
        c,
        state,
        list.map((r): ListRow => ({
          title: r.name,
          secondary: r.heading,
          meta: r.words,
        })),
      );
    },
    key(e) {
      const list = rows();
      if (state.key(e, list.length)) return true;
      if (e.key === "enter") {
        const row = list[state.index];
        if (row !== undefined) ctx.push(repoScreen(f, ctx, local(f, row.repo)));
        return true;
      }
      if (e.key === "esc" || e.key === "q") {
        ctx.pop();
        return true;
      }
      return false;
    },
  };
}
