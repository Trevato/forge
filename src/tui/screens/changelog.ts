/**
 * The changelog, the terminal's /changelog: the same `forgeChangelog` read the
 * page makes, for anyone, a guest included. Each release is a row: version,
 * date and the pulls it carried. `/` narrows them by a word of the version or a
 * pull title; Enter lists a release's pulls, and Enter on a pull opens it.
 */

import { gather, plainTitle } from "../../story/gather.ts";
import { forgeChangelog, type ReleaseEntry } from "../../release/changelog.ts";
import { readLandings } from "../../release/landings.ts";
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
  return filter.matches([e.version, ...e.pulls.map((p) => plainTitle(p.title))].join("\n"));
}

export function changelogRows(entries: readonly ReleaseEntry[]): ListRow[] {
  return entries.map((e) => ({
    title: e.version,
    meta: metaOf(
      ago(e.date),
      `${e.pulls.length} ${e.pulls.length === 1 ? "pull" : "pulls"}`,
      e.pulls.map((p) => `#${p.number} ${plainTitle(p.title)}`.trim()).join("; "),
    ),
  }));
}

type Repo = { owner: string; name: string };

/** Who built a pull, in plain words: "by Scout, with Claude Sonnet 5.5"; empty when the commit says nothing. */
export function creditWords(by: string | undefined, withNames: readonly string[] | undefined): string {
  const parts = [by === undefined ? "" : `by ${by}`, withNames === undefined || withNames.length === 0 ? "" : `with ${withNames.join(", ")}`];
  return parts.filter((p) => p !== "").join(", ");
}

type Pull = ReleaseEntry["pulls"][number];

/** A release's pulls as lines: pulls of one shape gathered ("Keys on … · 9 pulls"), the rest `#N title`. */
export function pullLines(pulls: readonly Pull[], credits: ReadonlyMap<number, string>): { row: ListRow; pulls: readonly Pull[] }[] {
  return gather(pulls).map((g) =>
    g.landings.length === 1
      ? { row: { title: `#${g.landings[0]!.number} ${plainTitle(g.landings[0]!.title)}`.trim(), meta: credits.get(g.landings[0]!.number) ?? "" }, pulls: g.landings }
      : { row: { title: g.shape, meta: metaOf(`${g.landings.length} pulls`, g.landings.map((p) => `#${p.number}`).join(" ")) }, pulls: g.landings },
  );
}

/** One release's pulls; Enter opens a pull as the changelog's Enter once did, and a gathered line lists its own pulls. */
function releasePulls(f: Session, ctx: Ctx, repoRef: Repo, entry: ReleaseEntry, credits: ReadonlyMap<number, string>, title = entry.version): Screen {
  const state = new ListState();
  const lines = pullLines(entry.pulls, credits);
  return {
    title,
    keys: [binding(["j", "k"], "move"), binding(["enter"], "open pull"), binding(["esc", "q"], "back")],
    render(area, s) {
      const rows = lines.map((l) => l.row);
      if (rows.length === 0) {
        emptyState(s, area, ctx.theme.c, { title: "No pulls", body: "This release carried none." });
        return;
      }
      drawList(s, area, ctx.theme.c, state, rows);
    },
    key(e) {
      if (e.key === "esc" || e.key === "q") ctx.pop();
      else if (e.key === "enter") {
        const line = lines[state.index];
        const opened = line === undefined ? undefined : sourceFor(f.app, f.user, repoRef);
        if (line !== undefined && line.pulls.length > 1) ctx.push(releasePulls(f, ctx, repoRef, { ...entry, pulls: line.pulls }, credits, line.row.title));
        else if (line !== undefined && opened?.ok) ctx.push(pullScreen(f, ctx, opened.value, line.pulls[0]!.number));
      } else state.key(e, lines.length);
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
  let credits = new Map<number, string>();
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
      if (read !== undefined) {
        const landings = await readLandings(f.app).catch(() => undefined);
        const repoName = `${read.repo.ownerName}/${read.repo.name}`.toLowerCase();
        credits = new Map();
        for (const l of [...(landings?.live ?? []), ...(landings?.onItsWay ?? [])]) {
          const words = creditWords(l.by, l.with);
          if (words !== "" && l.repo.toLowerCase() === repoName) credits.set(l.number, words);
        }
      }
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
        if (entry !== undefined && repoRef !== undefined) ctx.push(releasePulls(f, ctx, repoRef, entry, credits));
      } else state.key(e, shown().length);
      return true;
    },
  };
}
