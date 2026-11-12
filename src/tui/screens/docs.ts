/**
 * The forge's documentation, the terminal's /docs: the same listing the page
 * makes (`docEntries`), for anyone, a guest included. Enter reads a document,
 * rendered as markdown, scrolled with j and k.
 */

import { docEntries, docText, type DocEntry } from "../../view/docs.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { renderMarkdown } from "../ui/markdown.ts";
import { Scroll, ListState, drawLines, drawList, type ListRow } from "./common.ts";

export function docRows(entries: readonly DocEntry[]): ListRow[] {
  return entries.map((e) => ({ title: e.title }));
}

function docScreen(ctx: Ctx, entry: DocEntry): Screen {
  const scroll = new Scroll();
  let cache: { w: number; lines: ReturnType<typeof renderMarkdown> } | undefined;
  const text = docText(entry);
  return {
    title: entry.title,
    keys: [binding(["j", "k"], "scroll"), binding(["esc", "q"], "back")],
    render(area, s) {
      const w = Math.max(20, area.w - 2);
      if (cache === undefined || cache.w !== w) cache = { w, lines: renderMarkdown(text, w, ctx.theme.c) };
      drawLines(s, area, ctx.theme.c, scroll, cache.lines);
    },
    key(e) {
      if (e.key === "esc" || e.key === "q") ctx.pop();
      else scroll.key(e, cache?.lines.length ?? 0);
      return true;
    },
  };
}

export function docsScreen(ctx: Ctx): Screen {
  const state = new ListState();
  const entries = docEntries();
  return {
    title: "Docs",
    keys: [binding(["j", "k"], "move"), binding(["enter"], "read"), binding(["esc", "q"], "close")],
    render(area, s) {
      drawList(s, area, ctx.theme.c, state, docRows(entries));
    },
    key(e) {
      if (e.key === "esc" || e.key === "q") ctx.pop();
      else if (e.key === "enter") {
        const entry = entries[state.index];
        if (entry !== undefined) ctx.push(docScreen(ctx, entry));
      } else state.key(e, entries.length);
      return true;
    },
  };
}
