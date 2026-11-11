/**
 * `/packs` in the terminal: the premade forges this forge ships, one pack's
 * contents (apps, crew), the commands that deploy it and what happens to a
 * stranger's pull. Words come from `src/packs/words.ts`, the same the web page
 * prints. Anyone may open it. The curated packs (#11006) are read from the
 * database and edited through `packs/curated.ts`, the page's own door.
 */

import { changeRepos, editPack, getPack, history, listPacks, mayCurate, resolveRepos, slugOf, type EditResult, type PackRepo } from "../../packs/curated.ts";
import { MAX_DIRECTION_CHARS } from "../../spawn/plan.ts";
import { newForgeScreen } from "./newforge.ts";
import { promptScreen } from "./common.ts";
import { catalog, refreshCatalogQuietly } from "../../packs/catalog.ts";
import type { App } from "../../app.ts";
import type { Pack } from "../../packs/pack.ts";
import { BRINGS_WORDS, deployCommands, STRANGER_WORDS } from "../../packs/words.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { style } from "../term/style.ts";
import { truncate, wrap } from "../term/width.ts";
import { Scroll } from "./common.ts";
import type { Session } from "../session.ts";

/** One pack as text lines: what it brings, the commands, and the stranger's way in. */
export function packLines(p: Pack, origin: string | undefined, width = 80): string[] {
  const w = Math.max(20, width);
  return [
    `${p.title} ${p.version}`,
    ...wrap(p.description, w),
    "",
    "Apps",
    ...p.apps.map((a) => `  ${a.name}  ${a.source}`),
    ...(p.crew.length === 0 ? [] : ["", "Crew", ...p.crew.map((c) => `  ${c.username}  ${c.roles.join(", ")}`)]),
    "",
    ...wrap(BRINGS_WORDS, w),
    "",
    "Deploy it on your own machine",
    ...deployCommands(p, origin).map((l) => `  ${l}`),
    "",
    "Help build these apps",
    ...STRANGER_WORDS.flatMap((t) => [...wrap(t, w), ""]).slice(0, -1),
  ];
}

function packScreen(ctx: Ctx, p: Pack, origin: string | undefined): Screen {
  const scroll = new Scroll();
  let lines: string[] = [];
  return {
    title: `${p.title} pack`,
    keys: [binding(["j", "k"], "scroll"), binding(["esc"], "back")],
    render(area, s) {
      const c = ctx.theme.c;
      lines = packLines(p, origin, area.w - 4);
      const from = scroll.window(area.h, lines.length);
      for (let i = 0; i < area.h; i++) {
        const line = lines[from + i];
        if (line !== undefined) s.text(area.x + 1, area.y + i, line, style(c.fg, c.bg), area.x + area.w);
      }
    },
    key(e) {
      if (e.key === "esc" || e.key === "q") {
        ctx.pop();
        return true;
      }
      return scroll.key(e, lines.length);
    },
  };
}

const says = (done: EditResult): string => (done.ok ? "Saved. /packs shows it now." : done.says);

/**
 * One curated pack, read from the database on every draw (so an edit on the
 * page shows here at once, and an edit here is on the page the same way).
 * Everyone: j/k scroll, s starts a forge from it as it stands. A person admin
 * also: a add, x remove, u/d move the repo under the cursor, t/p/b title,
 * pitch, brief. Repos that are private or missing are named to admins only.
 */
export function curatedScreen(session: Session, ctx: Ctx, name: string): Screen {
  let at = 0;
  let note = "";
  const user = session.user;
  const db = session.app.db;
  const view = (): { repos: PackRepo[]; shown: PackRepo[] } | undefined => {
    const pack = getPack(db, name);
    if (pack === undefined) return undefined;
    const repos = resolveRepos(db, pack, user);
    return { repos: mayCurate(user) ? repos : repos.filter((r) => r.left === undefined), shown: repos.filter((r) => r.left === undefined) };
  };
  const wrote = (done: EditResult): void => {
    note = says(done);
    ctx.invalidate();
  };
  const edit = (label: string, field: "title" | "pitch" | "brief"): void => {
    const pack = getPack(db, name);
    if (pack === undefined || !mayCurate(user)) return;
    ctx.push(promptScreen(ctx, screen, { title: `Pack ${field}`, label, value: pack[field], onSubmit: (text) => { wrote(editPack(db, user, name, { [field]: text })); } }));
  };
  const start = (): void => {
    const pack = getPack(db, name);
    const v = view();
    if (pack === undefined || v === undefined) return;
    ctx.push(newForgeScreen(session, ctx, { apps: v.shown.map((r) => r.full).join(", "), direction: pack.brief.slice(0, MAX_DIRECTION_CHARS) }));
  };
  const screen: Screen = {
    title: "Pack",
    keys: [binding(["j", "k"], "move"), binding(["s"], "start a forge"), ...(mayCurate(user) ? [binding(["a", "x", "u", "d", "t", "p", "b"], "edit")] : []), binding(["esc"], "back")],
    render(area, s) {
      const c = ctx.theme.c;
      const pack = getPack(db, name);
      const v = view();
      if (pack === undefined || v === undefined) {
        s.text(area.x + 1, area.y, "This pack is gone.", style(c.mutedFg, c.bg), area.x + area.w);
        return;
      }
      at = Math.min(at, Math.max(0, v.repos.length - 1));
      const lines: [string, "fg" | "muted" | "accent"][] = [
        [`${pack.title} pack`, "fg"],
        ...wrap(pack.pitch, area.w - 4).map((l): [string, "muted"] => [l, "muted"]),
        ["", "fg"],
        [`${v.shown.length} repo${v.shown.length === 1 ? "" : "s"}. Press s to start a forge from this.`, "muted"],
        ["", "fg"],
        ...v.repos.map((r, i): [string, "fg" | "muted" | "accent"] => [`${i === at && mayCurate(user) ? "> " : "  "}${r.full}${r.left === undefined ? (r.live ? "  live" : "") : `  (${r.left})`}`, r.left === undefined ? (i === at ? "accent" : "fg") : "muted"]),
        ...(pack.brief === "" ? [] : ([["", "fg"], ["Crew brief", "fg"], ...wrap(pack.brief, area.w - 4).map((l): [string, "muted"] => [l, "muted"])] as [string, "fg" | "muted"][])),
        ...(mayCurate(user)
          ? ([["", "fg"], ["History", "fg"], ...history(db, name, 5).map((h): [string, "muted"] => [`  ${h.actor} ${h.what}`, "muted"])] as [string, "fg" | "muted"][])
          : []),
        ...(note === "" ? [] : ([["", "fg"], [note, "accent"]] as [string, "accent"][])),
      ];
      lines.slice(0, area.h).forEach(([t, tone], i) => s.text(area.x + 1, area.y + i, truncate(t, area.w - 2), style(tone === "muted" ? c.mutedFg : tone === "accent" ? c.accent : c.fg, c.bg), area.x + area.w));
    },
    key(e) {
      if (e.ctrl || e.alt) return false;
      const v = view();
      const mine = mayCurate(user);
      const row = v?.repos[at];
      if (e.key === "esc" || e.key === "q") ctx.pop();
      else if (e.key === "j" || e.key === "down") at = Math.min(Math.max(0, (v?.repos.length ?? 1) - 1), at + 1);
      else if (e.key === "k" || e.key === "up") at = Math.max(0, at - 1);
      else if (e.key === "s") start();
      else if (mine && e.key === "a")
        ctx.push(promptScreen(ctx, screen, { title: "Add a repo", label: "owner/name", onSubmit: (text) => { wrote(changeRepos(db, user, name, "add", text)); } }));
      else if (mine && row !== undefined && (e.key === "x" || e.key === "u" || e.key === "d")) {
        const word = getPack(db, name)?.repos[at];
        wrote(changeRepos(db, user, name, e.key === "x" ? "remove" : e.key === "u" ? "up" : "down", word));
        if (e.key === "u") at = Math.max(0, at - 1);
        if (e.key === "d") at += 1;
      } else if (mine && e.key === "t") edit("Title", "title");
      else if (mine && e.key === "p") edit("Pitch", "pitch");
      else if (mine && e.key === "b") edit("Crew brief", "brief");
      else return false;
      return true;
    },
  };
  return screen;
}

/** The list: curated packs first (Enter opens one, a person admin's n makes one), then the deployable pack.json ones. */
export function packsScreen(ctx: Ctx, origin: string | undefined, app?: App, session?: Session): Screen {
  if (app !== undefined) void refreshCatalogQuietly(app, 2_000).then(() => ctx.invalidate());
  let at = 0;
  let note = "";
  const curated = () => (app === undefined ? [] : listPacks(app.db));
  const total = () => curated().length + catalog().packs.length;
  const mine = () => session !== undefined && mayCurate(session.user);
  const screen: Screen = {
    title: "Forge packs",
    keys: [binding(["j", "k"], "move"), binding(["enter"], "open"), ...(mine() ? [binding(["n"], "new pack")] : []), binding(["esc"], "close")],
    render(area, s) {
      const c = ctx.theme.c;
      s.text(area.x + 1, area.y, "Packs: short lists of repos to start a forge from", style(c.mutedFg, c.bg), area.x + area.w);
      const rows = [
        ...curated().map((p) => `${p.title}  ${p.pitch}`),
        ...catalog().packs.map((p) => `${p.title}  v${p.version}  ${p.apps.length} apps, ${p.crew.length} crew  ${p.description}`),
      ];
      rows.forEach((text, i) => {
        const on = i === at;
        if (2 + i < area.h) s.text(area.x + 1, area.y + 2 + i, truncate(`${on ? "> " : "  "}${text}`, area.w - 2), on ? style(c.accent, c.bg) : style(c.fg, c.bg), area.x + area.w);
      });
      if (rows.length === 0) s.text(area.x + 1, area.y + 2, mine() ? "No packs yet. Press n to make one." : "No packs yet. An admin makes the first one.", style(c.mutedFg, c.bg), area.x + area.w);
      if (note !== "") s.text(area.x + 1, area.y + Math.min(area.h - 1, rows.length + 3), truncate(note, area.w - 2), style(c.accent, c.bg), area.x + area.w);
    },
    key(e) {
      if (e.ctrl || e.alt) return false;
      if (e.key === "esc" || e.key === "q") ctx.pop();
      else if (e.key === "j" || e.key === "down") at = Math.min(Math.max(0, total() - 1), at + 1);
      else if (e.key === "k" || e.key === "up") at = Math.max(0, at - 1);
      else if (e.key === "n" && session !== undefined && mine())
        ctx.push(
          promptScreen(ctx, screen, {
            title: "New pack",
            label: "Title",
            onSubmit: (title) => {
              const done = editPack(session.app.db, session.user, slugOf(title), { title, repos: [] }, true);
              note = done.ok ? "Pack made. Open it to add repos." : done.says;
              ctx.invalidate();
            },
          }),
        );
      else if (e.key === "enter") {
        const list = curated();
        const c = list[at];
        if (c !== undefined && session !== undefined) ctx.push(curatedScreen(session, ctx, c.name));
        else {
          const p = catalog().packs[at - list.length];
          if (p !== undefined) ctx.push(packScreen(ctx, p, origin));
        }
      } else return false;
      return true;
    },
  };
  return screen;
}

export const packsCommand = (session: Session, ctx: Ctx) => ({
  id: "packs",
  title: "Forge packs",
  hint: "premade forges to deploy, and how to help build their apps",
  run: () => ctx.push(packsScreen(ctx, session.app.config.url, session.app, session)),
});
