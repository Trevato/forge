/**
 * Where people come from, in the terminal (#9427): the web page's reads
 * (`web/pages/sources.ts`) from the same figures (`perf/views_report.ts`),
 * gated the same way. A forge admin opens the forge's view from the palette;
 * a repository's admin opens that app's view from the palette while the
 * repository is open; anyone else is offered nothing and, were the screen
 * reached, sees no rows.
 *
 * `w` changes the window, `s` flips people and scrapers, Enter narrows every
 * panel to the value under the cursor, `c` clears the narrowing, `t` types
 * the steps of a path to a goal. Read-only.
 */

import { getAppByRepo } from "../../core/apps.ts";
import { canAdmin, type Repo } from "../../core/repos.ts";
import {
  DIMENSIONS,
  DIRECT,
  WINDOWS,
  funnel,
  parseSteps,
  sourcesReport,
  windowOfViews,
  type Counted,
  type Dimension,
  type Filter,
  type ViewWindow,
} from "../../perf/views_report.ts";
import type { Ctx, Screen } from "../app/app.ts";
import type { Command } from "../app/palette.ts";
import { binding } from "../app/keys.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import type { Session } from "../session.ts";
import { fill, len, split } from "../ui/layout.ts";
import { ListState, drawList, promptScreen, type ListRow } from "./common.ts";
import type { PaletteEntry } from "./entries.ts";

/** The scope this viewer may read, or undefined: the forge for an admin, the app for its repository's admin. */
export function readableScope(f: Session, repo?: Repo): string | undefined {
  if (f.user === undefined) return undefined;
  if (repo === undefined) return f.user.isAdmin ? "forge" : undefined;
  if (!canAdmin(f.db, repo, f.user)) return undefined;
  return getAppByRepo(f.db, repo.id)?.id;
}

interface Line {
  readonly row: ListRow;
  readonly dimension?: Dimension;
  readonly key?: string;
}

const PANELS: ReadonlyArray<[string, keyof ReturnType<typeof sourcesReport>, Dimension | null]> = [
  ["Source", "sources", "source"],
  ["Medium", "mediums", "medium"],
  ["Campaign", "campaigns", "campaign"],
  ["Landing", "landings", "landing"],
  ["Left at", "exits", "exit"],
  ["Outbound", "outbound", null],
];

export function trafficLines(f: Session, scope: string, window: ViewWindow, filter: Filter, steps: readonly string[], now = Date.now()): Line[] {
  const r = sourcesReport(f.db, scope, window, filter, now);
  const out: Line[] = [
    {
      row: {
        title: `${filter.who === "scrapers" ? "Scraper visits" : "Visits"}: ${r.visits} · page views ${r.pageViews} · ${r.pagesPerVisit} pages a visit`,
        meta: `${WINDOWS[window]} days · ${filter.who === "scrapers" ? `${r.people} people` : `${r.scrapers} scrapers`} kept apart`,
      },
    },
  ];
  for (const [title, field, dimension] of PANELS) {
    for (const c of r[field] as readonly Counted[])
      out.push({
        row: { title: `${title}: ${c.key}`, meta: `${c.visits}` },
        ...(dimension === null ? {} : { dimension, key: c.key }),
      });
  }
  if (steps.length > 0)
    for (const s of funnel(f.db, scope, window, filter, steps, now))
      out.push({ row: { title: `Path: ${s.step}`, meta: `${s.visits} visits · lost ${s.lost} (${s.lostShare}%)` } });
  out.push({
    row: {
      title: "Not seen",
      note: "Outbound clicks are reported by the visitor's browser and can be forged; scripts off, Do-Not-Track and hidden referrers are not counted.",
    },
  });
  return out;
}

export function trafficScreen(f: Session, ctx: Ctx, repo?: Repo): Screen {
  const state = new ListState();
  let window: ViewWindow = "7d";
  let who: Filter["who"] = "people";
  let narrow: Partial<Record<Dimension, string>> = {};
  let steps: string[] = [];
  const scope = (): string | undefined => readableScope(f, repo);
  const filter = (): Filter => ({ who, ...narrow });
  const lines = (): Line[] => {
    const s = scope();
    return s === undefined ? [] : trafficLines(f, s, window, filter(), steps);
  };
  const screen: Screen = {
    title: repo === undefined ? "Traffic sources" : `${repo.ownerName}/${repo.name} — Traffic sources`,
    keys: [
      binding(["j", "k"], "move cursor"),
      binding(["w"], "window"),
      binding(["s"], "people/scrapers"),
      binding(["enter"], "narrow"),
      binding(["c"], "clear"),
      binding(["t"], "path steps"),
    ],
    render(area, s) {
      const c = ctx.theme.c;
      const [head, list] = split(area, "v", [len(1), fill(1)]);
      const on = DIMENSIONS.filter((d) => narrow[d] !== undefined).map((d) => `${d}=${narrow[d] === "" ? DIRECT : narrow[d]}`);
      s.text(head!.x, head!.y, truncate(`${WINDOWS[window]} days · ${who}${on.length > 0 ? ` · ${on.join(" ")}` : ""}${steps.length > 0 ? ` · path ${steps.join(",")}` : ""}`, head!.w), style(c.mutedFg, c.bg), head!.x + head!.w);
      drawList(s, list!, c, state, lines().map((l) => l.row));
    },
    key(e) {
      if (scope() === undefined) return false;
      const all = lines();
      if (state.key(e, all.length)) return true;
      if (e.key === "w") {
        window = windowOfViews(window === "7d" ? "30d" : window === "30d" ? "90d" : "7d");
        return true;
      }
      if (e.key === "s") {
        who = who === "people" ? "scrapers" : "people";
        return true;
      }
      if (e.key === "c") {
        narrow = {};
        return true;
      }
      if (e.key === "enter") {
        const at = all[state.index];
        if (at?.dimension !== undefined && at.key !== undefined) narrow = { ...narrow, [at.dimension]: at.key === DIRECT ? "" : at.key };
        return true;
      }
      if (e.key === "t") {
        ctx.push(
          promptScreen(ctx, screen, {
            title: "Path to a goal",
            label: "Steps, in order",
            placeholder: "/, /explore, out:github.com",
            value: steps.join(","),
            onSubmit: (value) => {
              steps = parseSteps(value);
              return undefined;
            },
          }),
        );
        return true;
      }
      return false;
    },
  };
  return screen;
}

/** The palette's forge-wide view, to site admins. */
export const entry: PaletteEntry = {
  id: "traffic-sources",
  title: "Traffic sources",
  hint: "where people come from and where they go, for the forge",
  offered: (f) => readableScope(f) !== undefined,
  run: (f, ctx) => ctx.push(trafficScreen(f, ctx)),
};

/** The palette's per-app view while a repository is open, to the repository's admins. */
export function trafficCommands(f: Session, ctx: Ctx, repo: Repo | undefined): Command[] {
  if (repo === undefined || readableScope(f, repo) === undefined) return [];
  return [
    {
      id: "traffic-sources-app",
      title: `${repo.ownerName}/${repo.name} — Traffic sources`,
      hint: "where this app's visitors come from and go",
      run: () => ctx.push(trafficScreen(f, ctx, repo)),
    },
  ];
}
