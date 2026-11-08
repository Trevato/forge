/**
 * The access log in the terminal, a forge admin's (#1768): the last day's
 * non-browser requests to public paths, newest first — `listAccess`, the
 * action the settings page and the `access` MCP tool read. Filters are the
 * same three: `s` since (a time), `u` user agent contains, `p` path starts
 * with; `c` clears them. Who may read is the action's call, not this
 * screen's: anyone else gets an empty screen that says nothing exists.
 */

import { listAccess } from "../../actions/access_log.ts";
import type { AccessLine, AccessQuery } from "../../http/access_log.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { fill, len, split } from "../ui/layout.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import type { Session } from "../session.ts";
import { ListState, drawList, promptScreen, type ListRow } from "./common.ts";
import type { PaletteEntry } from "./entries.ts";

type Filter = "since" | "ua" | "path";

const FILTERS: { key: string; filter: Filter; title: string; label: string }[] = [
  { key: "s", filter: "since", title: "Since", label: "ISO time, e.g. 2026-10-14T09:00" },
  { key: "u", filter: "ua", title: "User agent", label: "contains" },
  { key: "p", filter: "path", title: "Path", label: "starts with, e.g. /api/" },
];

const MAX = { since: 40, ua: 100, path: 200 } as const;

export function accessScreen(f: Session, ctx: Ctx): Screen {
  const state = new ListState();
  const filters: Partial<Record<Filter, string>> = {};
  let lines: AccessLine[] = [];
  let loaded = false;

  const query = (): AccessQuery => ({ ...filters });

  const reload = (): void => {
    const listed = listAccess(f.app, f.user, query());
    lines = listed.ok ? listed.value : [];
    loaded = true;
    state.clamp(lines.length);
    ctx.invalidate();
  };

  const ask = (which: (typeof FILTERS)[number]): void => {
    ctx.push(
      promptScreen(ctx, screen, {
        title: which.title,
        label: which.label,
        value: filters[which.filter] ?? "",
        onSubmit: (raw) => {
          const value = raw.trim();
          if (value.length > MAX[which.filter]) return "too long";
          if (which.filter === "since" && value !== "" && Number.isNaN(Date.parse(value)))
            return "not a time";
          if (value === "") delete filters[which.filter];
          else filters[which.filter] = value;
          reload();
          return undefined;
        },
      }),
    );
  };

  const rows = (): ListRow[] =>
    lines.map((l) => ({
      title: `${l.method} ${l.path}`,
      secondary: String(l.status),
      meta: `${l.t.slice(11, 19)} · ${l.ms} ms · ${l.auth ? "signed in" : "anonymous"} · ${l.who} · ${l.ua === "" ? "no user agent" : l.ua}`,
    }));

  const screen: Screen = {
    title: "Access",
    keys: [
      binding(["j", "k"], "move cursor"),
      binding(["s"], "since"),
      binding(["u"], "user agent"),
      binding(["p"], "path"),
      binding(["c"], "clear filters"),
    ],
    load() {
      reload();
      return Promise.resolve();
    },
    render(area, s) {
      const c = ctx.theme.c;
      const [head, list] = split(area, "v", [len(1), fill(1)]);
      const active = Object.entries(filters)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ");
      const note = !loaded
        ? "Loading…"
        : lines.length === 0
          ? "Nothing in the last day."
          : `${lines.length} outside request${lines.length === 1 ? "" : "s"}, newest first${active === "" ? "" : ` · ${active}`}`;
      s.text(head!.x, head!.y, truncate(note, head!.w), style(c.mutedFg, c.bg), head!.x + head!.w);
      drawList(s, list!, c, state, rows());
    },
    key(e) {
      if (state.key(e, lines.length)) return true;
      if (e.ctrl || e.alt) return false;
      const which = FILTERS.find((x) => x.key === e.key);
      if (which !== undefined) ask(which);
      else if (e.key === "c") {
        for (const k of Object.keys(filters)) delete filters[k as Filter];
        reload();
      } else return false;
      return true;
    },
  };
  return screen;
}

/** What outside agents tried, as Settings → Access says it: a site admin's (#1768). */
export const entry: PaletteEntry = {
  id: "access",
  title: "Access",
  hint: "what outside agents tried",
  after: ["file-holds"],
  offered: (session) => session.user?.isAdmin === true && session.user.kind !== "agent",
  run: (session, ctx) => ctx.push(accessScreen(session, ctx)),
};
