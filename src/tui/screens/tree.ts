/**
 * Browsing a repository's files: one level of a tree, and one blob.
 *
 * Both are bounded by construction — `listTree` reads a single level and
 * `blobForRender` stats a blob before it reads a byte — so opening a
 * directory of ten thousand files, or a 2GB object, costs the same as
 * opening a small one.
 */

import { blobForRender, listTree, type TreeEntry } from "../../git/read.ts";
import type { Repo } from "../../core/repos.ts";
import { detectLanguage, highlightLines } from "../../web/highlight.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Span } from "../term/screen.ts";
import { style } from "../term/style.ts";
import { expandTabs, pad, truncate } from "../term/width.ts";
import { fill, len, split } from "../ui/layout.ts";
import { emptyState, scrollbar } from "../ui/widgets.ts";
import type { Session } from "../session.ts";
import { Filter, ListState, Scroll, drawList, runAsync } from "./common.ts";
import { refPickerScreen } from "./refs.ts";

/** A blob larger than this is described, never rendered. */
const MAX_BLOB = 1024 * 1024;

export function treeScreen(
  f: Session,
  ctx: Ctx,
  repo: Repo,
  ref: string,
  path = "",
): Screen {
  let entries: TreeEntry[] = [];
  const state = new ListState();
  const filter = new Filter();
  const shown = (): TreeEntry[] =>
    entries.filter((e) => filter.matches(e.name));

  const reload = async (): Promise<void> => {
    const result = await listTree(f.dir(repo), ref, path);
    entries = result.ok ? result.value : [];
    if (!result.ok) ctx.toast(`cannot read ${path || "/"}`, "danger");
    ctx.invalidate();
  };

  const screen: Screen = {
    title: path === "" ? "Files" : path,
    keys: [
      binding(["j", "k"], "move"),
      binding(["enter"], "open"),
      binding(["b"], "ref"),
      binding(["/"], "filter"),
      binding(["r"], "refresh"),
    ],
    load: reload,
    render(area, s) {
      const c = ctx.theme.c;
      const [head, box, body] = split(area, "v", [len(1), len(1), fill(1)]);
      s.text(
        head!.x,
        head!.y,
        truncate(`${repo.ownerName}/${repo.name} · ${ref}`, head!.w),
        style(c.mutedFg, c.bg),
        head!.x + head!.w,
      );
      ctx.setCursor(filter.render(s, box!, c, "filter files"));
      const items = shown();
      if (items.length === 0) {
        emptyState(s, body!, c, {
          title: "Nothing here",
          body: path === "" ? "This repo has no commits yet." : "Empty tree.",
        });
        return;
      }
      drawList(
        s,
        body!,
        c,
        state,
        items.map((e) => ({
          title: e.type === "tree" ? `${e.name}/` : e.name,
          secondary: e.type === "tree" ? "" : e.mode === "120000" ? "link" : "",
          meta: e.type === "tree" ? "" : formatSize(e.size),
        })),
      );
    },
    key(e) {
      if (filter.key(e)) {
        state.clamp(shown().length);
        return true;
      }
      const items = shown();
      if (state.key(e, items.length)) return true;
      if (e.key === "enter") {
        const entry = items[state.index];
        if (!entry) return true;
        const next = path === "" ? entry.name : `${path}/${entry.name}`;
        ctx.push(
          entry.type === "tree"
            ? treeScreen(f, ctx, repo, ref, next)
            : blobScreen(f, ctx, repo, ref, next),
        );
        return true;
      }
      if (e.key === "b") {
        ctx.push(
          refPickerScreen(f, ctx, screen, repo, (chosen) =>
            ctx.replace(treeScreen(f, ctx, repo, chosen, path)),
          ),
        );
        return true;
      }
      if (e.key === "r") {
        runAsync(ctx, reload);
        return true;
      }
      return false;
    },
  };
  return screen;
}

function formatSize(bytes: number): string {
  if (bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} K`;
  return `${(bytes / 1024 / 1024).toFixed(1)} M`;
}

export function blobScreen(
  f: Session,
  ctx: Ctx,
  repo: Repo,
  ref: string,
  path: string,
): Screen {
  let lines: Span[][] = [];
  let plain: string[] = [];
  let note = "";
  const scroll = new Scroll();
  const search = new Filter();
  let hits: number[] = [];
  let hit = 0;

  const findHits = (): void => {
    const q = search.query.toLowerCase();
    hits =
      q === ""
        ? []
        : plain.flatMap((l, i) => (l.toLowerCase().includes(q) ? [i] : []));
    hit = 0;
    if (hits[0] !== undefined) scroll.to(hits[0], plain.length);
  };

  const reload = async (): Promise<void> => {
    const blob = await blobForRender(f.dir(repo), ref, path, MAX_BLOB);
    const c = ctx.theme.c;
    if (blob.kind === "missing") {
      note = "No such file at this revision.";
    } else if (blob.kind === "too_large") {
      note = `${formatSize(blob.size)} — too large to display.`;
    } else if (blob.kind === "binary") {
      note = `Binary file, ${formatSize(blob.size)}.`;
    } else {
      const text = new TextDecoder().decode(blob.body).replace(/\n$/, "");
      plain = text.split("\n").map((l) => expandTabs(l));
      const width = String(plain.length).length;
      lines = highlightLines(plain.join("\n"), detectLanguage(path)).map(
        (tokens, i) => [
          {
            text: `${pad(String(i + 1), width, "right")} `,
            style: style(c.faint, c.bg),
          },
          ...tokens.map((t) => ({
            text: t.text,
            style: style(c.tok[t.cls], c.bg),
          })),
        ],
      );
    }
    ctx.invalidate();
  };

  return {
    title: path.split("/").pop() ?? path,
    keys: [
      binding(["j", "k"], "scroll"),
      binding(["ctrl+d", "ctrl+u"], "page"),
      binding(["g", "G"], "top/bottom"),
      binding(["/"], "search"),
      binding(["n", "N"], "next/prev match"),
    ],
    load: reload,
    render(area, s) {
      const c = ctx.theme.c;
      const [head, box, body] = split(area, "v", [len(1), len(1), fill(1)]);
      s.text(
        head!.x,
        head!.y,
        truncate(`${path} · ${ref}`, head!.w),
        style(c.mutedFg, c.bg),
        head!.x + head!.w,
      );
      ctx.setCursor(
        search.on || search.active
          ? search.render(s, box!, c, "search in file")
          : null,
      );
      if (!search.on)
        s.text(
          box!.x,
          box!.y,
          truncate(note === "" ? `${plain.length} lines` : "", box!.w),
          style(c.faint, c.bg),
          box!.x + box!.w,
        );
      if (note !== "") {
        emptyState(s, body!, c, { title: "Not shown", body: note });
        return;
      }
      const from = scroll.window(body!.h, lines.length);
      for (let i = 0; i < body!.h; i++) {
        const line = lines[from + i];
        if (line === undefined) break;
        const isHit = hits.includes(from + i);
        s.spans(
          body!.x,
          body!.y + i,
          isHit
            ? line.map((span) => ({
                ...span,
                style: { ...span.style, bg: c.muted },
              }))
            : line,
          body!.x + body!.w - 1,
        );
      }
      scrollbar(
        s,
        { x: body!.x + body!.w - 1, y: body!.y, w: 1, h: body!.h },
        c,
        { total: lines.length, offset: from },
      );
    },
    key(e) {
      if (search.active) {
        const handled = search.key(e);
        if (handled) findHits();
        return handled;
      }
      if (e.key === "/") {
        search.open();
        return true;
      }
      if (e.key === "n" && hits.length > 0) {
        hit = (hit + 1) % hits.length;
        scroll.to(hits[hit]!, plain.length);
        return true;
      }
      if (e.key === "N" && hits.length > 0) {
        hit = (hit - 1 + hits.length) % hits.length;
        scroll.to(hits[hit]!, plain.length);
        return true;
      }
      return scroll.key(e, lines.length);
    },
  };
}
