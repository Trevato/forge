/**
 * The changelog, the terminal's /changelog: the same `forgeChangelog` read the
 * page makes, for anyone, a guest included. Each release is a row: version,
 * date and the pulls it carried. `/` narrows them by a word of the version or a
 * pull title; Enter lists a release's pulls, and Enter on a pull opens it.
 */

import { forgeChangelog, type ReleaseEntry } from "../../release/changelog.ts";
import { sourceFor } from "../../view/source.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Session } from "../session.ts";
import { fill, len, split } from "../ui/layout.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import { emptyState } from "../ui/widgets.ts";
import { pullScreen } from "./pull.ts";
import { Filter, ListState, ago, drawList, metaOf, type ListRow } from "./common.ts";

/** Whether a release's version or any pull it carried names the word. */
export function releaseMatches(filter: Filter, e: ReleaseEntry): boolean {
  return filter.matches([e.version, ...e.pulls.map((p) => p.title)].join("\n"));
}

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

type Repo = { owner: string; name: string };

/** One release's pulls, `#N title`; Enter opens the pull as the changelog's Enter once did. */
function releasePulls(f: Session, ctx: Ctx, repoRef: Repo, entry: ReleaseEntry): Screen {
  const state = new ListState();
  return {
    title: entry.version,
    keys: [binding(["j", "k"], "move"), binding(["enter"], "open pull"), binding(["esc", "q"], "back")],
    render(area, s) {
      const rows = entry.pulls.map((p) => ({ title: `#${p.number} ${p.title}`.trim() }));
      if (rows.length === 0) {
        emptyState(s, area, ctx.theme.c, { title: "No pulls", body: "This release carried none." });
        return;
      }
      drawList(s, area, ctx.theme.c, state, rows);
    },
    key(e) {
      if (e.key === "esc" || e.key === "q") ctx.pop();
      else if (e.key === "enter") {
        const pull = entry.pulls[state.index];
        const opened = pull === undefined ? undefined : sourceFor(f.app, f.user, repoRef);
        if (pull !== undefined && opened?.ok) ctx.push(pullScreen(f, ctx, opened.value, pull.number));
      } else state.key(e, entry.pulls.length);
      return true;
    },
  };
}

export function changelogScreen(f: Session, ctx: Ctx): Screen {
  const state = new ListState();
  const filter = new Filter();
  let entries: ReleaseEntry[] = [];
  let loaded = false;
  let repoRef: Repo | undefined;
  const shown = (): ReleaseEntry[] => entries.filter((e) => releaseMatches(filter, e));
  return {
    title: "Changelog",
    keys: [
      binding(["j", "k"], "move"),
      binding(["/"], "find"),
      binding(["enter"], "list pulls"),
      binding(["esc", "q"], "close"),
    ],
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
      const list = shown();
      const [head, box, body] = split(area, "v", [len(1), len(filter.on ? 1 : 0), fill(1)]);
      const count = filter.query === "" ? `${entries.length} releases` : `${list.length} of ${entries.length} releases match`;
      s.text(head!.x, head!.y, truncate(count, head!.w), style(c.mutedFg, c.bg), head!.x + head!.w);
      ctx.setCursor(filter.on ? filter.render(s, box!, c, "find a version or pull") : null);
      if (list.length === 0) {
        emptyState(s, body!, c, { title: "No release matches", body: "Esc clears the word." });
        return;
      }
      drawList(s, body!, c, state, changelogRows(list));
    },
    key(e) {
      if (filter.key(e)) {
        state.clamp(shown().length);
        return true;
      }
      if (e.key === "esc" && filter.query !== "") {
        filter.query = "";
        state.clamp(shown().length);
      } else if (e.key === "esc" || e.key === "q") ctx.pop();
      else if (e.key === "enter") {
        const entry = shown()[state.index];
        if (entry !== undefined && repoRef !== undefined) ctx.push(releasePulls(f, ctx, repoRef, entry));
      } else state.key(e, shown().length);
      return true;
    },
  };
}
