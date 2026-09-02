/**
 * Browsing a repository's files: one level of a tree, and one blob.
 *
 * Both are bounded by construction — a source reads a single directory level
 * and stats a blob before it hands over a byte — so opening a directory of
 * ten thousand files, or a 2GB object, costs the same as opening a small one.
 * Neither screen knows whether the bytes came out of a bare git directory
 * here or off another forge's API: it asks the `RepoSource` and draws the
 * answer, and the where-strip at the top says which it was.
 */

import type { RepoSource } from "../../view/source.ts";
import type { TreeEntry } from "../../git/read.ts";
import { detectLanguage, highlightLines } from "../../web/highlight.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Span } from "../term/screen.ts";
import { style } from "../term/style.ts";
import { expandTabs, pad, truncate } from "../term/width.ts";
import { fill, len, split } from "../ui/layout.ts";
import { emptyState, scrollbar } from "../ui/widgets.ts";
import type { Session } from "../session.ts";
import {
  Filter,
  ListState,
  Scroll,
  drawList,
  errorText,
  runAsync,
} from "./common.ts";
import { refPickerScreen } from "./refs.ts";
import { sourceName, whereRows, whereStrip } from "./where.ts";

export function treeScreen(
  f: Session,
  ctx: Ctx,
  src: RepoSource,
  ref: string,
  path = "",
): Screen {
  let entries: TreeEntry[] = [];
  let loaded = false;
  const state = new ListState();
  const filter = new Filter();
  const shown = (): TreeEntry[] =>
    entries.filter((e) => filter.matches(e.name));

  const reload = async (): Promise<void> => {
    const result = await src.tree(ref, path);
    entries = result.ok ? result.value : [];
    loaded = true;
    if (!result.ok)
      ctx.toast(
        `cannot read ${path || "/"}: ${errorText(result.error)}`,
        "danger",
      );
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
      const [strip, head, box, body] = split(area, "v", [
        len(whereRows(src)),
        len(1),
        len(1),
        fill(1),
      ]);
      whereStrip(s, strip!, c, f, src);
      s.text(
        head!.x,
        head!.y,
        truncate(`${sourceName(src)} · ${ref}`, head!.w),
        style(c.mutedFg, c.bg),
        head!.x + head!.w,
      );
      ctx.setCursor(filter.render(s, box!, c, "filter files"));
      const items = shown();
      if (items.length === 0) {
        emptyState(s, body!, c, {
          title: !loaded
            ? "Reading…"
            : path === ""
              ? "Empty repository"
              : "Empty directory",
          body: !loaded
            ? `Listing ${path === "" ? "the root" : path}`
            : path === ""
              ? "Push a branch to get started."
              : "Nothing has been committed under this path.",
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
            ? treeScreen(f, ctx, src, ref, next)
            : blobScreen(f, ctx, src, ref, next),
        );
        return true;
      }
      if (e.key === "b") {
        ctx.push(
          refPickerScreen(f, ctx, screen, src, (chosen) =>
            ctx.replace(treeScreen(f, ctx, src, chosen, path)),
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
  src: RepoSource,
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
    const read = await src.blob(ref, path);
    const c = ctx.theme.c;
    if (!read.ok) {
      note =
        read.error === "not_found"
          ? "No such file at this revision."
          : errorText(read.error);
    } else if (read.value.kind === "too_large") {
      note = `${formatSize(read.value.size)} — too large to display.`;
    } else if (read.value.kind === "binary") {
      note = `Binary file, ${formatSize(read.value.size)}.`;
    } else {
      note = "";
      const text = new TextDecoder().decode(read.value.body).replace(/\n$/, "");
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
      const [strip, head, box, body] = split(area, "v", [
        len(whereRows(src)),
        len(1),
        len(1),
        fill(1),
      ]);
      whereStrip(s, strip!, c, f, src);
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
