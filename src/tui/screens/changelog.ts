/**
 * The changelog, the terminal's /changelog: the same `forgeChangelog` read the
 * page makes, for anyone, a guest included. Each release is a row: version,
 * date and the pulls it carried; Enter opens its first pull.
 */

import { forgeChangelog, type ReleaseEntry } from "../../release/changelog.ts";
import { sourceFor } from "../../view/source.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Session } from "../session.ts";
import { emptyState } from "../ui/widgets.ts";
import { pullScreen } from "./pull.ts";
import { ListState, ago, drawList, metaOf, type ListRow } from "./common.ts";

export function changelogRows(entries: readonly ReleaseEntry[]): ListRow[] {
  return entries.map((e) => ({
    title: e.version,
    meta: metaOf(
      ago(e.date),
      `${e.pulls.length} ${e.pulls.length === 1 ? "pull" : "pulls"}`,
      e.pulls.map((p) => `#${p.number} ${p.title}`.trim()).join("; "),
    ),
  }));
}

export function changelogScreen(f: Session, ctx: Ctx): Screen {
  const state = new ListState();
  let entries: ReleaseEntry[] = [];
  let loaded = false;
  let repoRef: { owner: string; name: string } | undefined;
  return {
    title: "Changelog",
    keys: [binding(["j", "k"], "move"), binding(["enter"], "open first pull"), binding(["esc", "q"], "close")],
    async load() {
      const read = await forgeChangelog(f.app);
      entries = read?.entries ?? [];
      repoRef = read === undefined ? undefined : { owner: read.repo.ownerName, name: read.repo.name };
      state.clamp(entries.length);
      loaded = true;
      ctx.invalidate();
    },
    render(area, s) {
      const c = ctx.theme.c;
      if (entries.length === 0) {
        emptyState(s, area, c, {
          title: loaded ? "No releases yet" : "Reading…",
          body: "Each release lands here with its pulls.",
        });
        return;
      }
      drawList(s, area, c, state, changelogRows(entries));
    },
    key(e) {
      if (e.key === "esc" || e.key === "q") ctx.pop();
      else if (e.key === "enter") {
        const first = entries[state.index]?.pulls[0];
        const opened = first === undefined || repoRef === undefined ? undefined : sourceFor(f.app, f.user, repoRef);
        if (first !== undefined && opened?.ok) ctx.push(pullScreen(f, ctx, opened.value, first.number));
      } else state.key(e, entries.length);
      return true;
    },
  };
}
