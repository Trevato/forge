/**
 * `t` (or `ctrl+p`): every file in the revision, one query away.
 *
 * The listing comes from `RepoSource.paths(ref)` — one `ls-tree -r` locally, a
 * cached tree call on an origin — so this is a single read no matter how many
 * keystrokes follow it, and the matching happens entirely in memory
 * (`ui/fuzzy.ts`, fzf's path scheme). When the listing hit its own cap the
 * count says so out loud: a finder that quietly searches nine thousand of ten
 * thousand files is worse than one that admits it.
 */

import type { RepoSource } from "../../view/source.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { style, BOLD } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import { center, fill, len, split } from "../ui/layout.ts";
import { card, input } from "../ui/widgets.ts";
import {
  indexPaths,
  rankPaths,
  type FuzzyHit,
  type FuzzyItem,
} from "../ui/fuzzy.ts";
import type { Session } from "../session.ts";
import { errorText, ListState } from "./common.ts";

/** Results scored and kept; only a screenful is ever drawn. */
const MAX_RESULTS = 200;

export function finderScreen(
  _f: Session,
  ctx: Ctx,
  parent: Screen,
  src: RepoSource,
  ref: string,
  onPick: (path: string) => void,
): Screen {
  let items: FuzzyItem[] = [];
  let truncatedListing = false;
  let loaded = false;
  let query = "";
  let hits: FuzzyHit[] = [];
  const state = new ListState();

  const refilter = (): void => {
    hits = rankPaths(items, query, { limit: MAX_RESULTS });
    state.index = 0;
    state.offset = 0;
  };

  return {
    title: "Find file",
    keys: [
      binding(["enter"], "open"),
      binding(["up", "down"], "move"),
      binding(["esc"], "cancel"),
    ],
    async load() {
      const listed = await src.paths(ref);
      if (!listed.ok) {
        ctx.toast(`cannot list files: ${errorText(listed.error)}`, "danger");
        loaded = true;
        ctx.invalidate();
        return;
      }
      items = indexPaths(listed.value.paths);
      truncatedListing = listed.value.truncated;
      loaded = true;
      refilter();
      ctx.invalidate();
    },
    render(area, s) {
      parent.render(area, s);
      const c = ctx.theme.c;
      const r = center(
        area,
        Math.min(78, Math.max(30, area.w - 6)),
        Math.min(area.h, Math.max(8, Math.min(hits.length, 14) + 5)),
      );
      const count = !loaded
        ? "reading…"
        : `${items.length} files${truncatedListing ? " (truncated)" : ""}`;
      const inner = card(s, r, c, {
        title: "Find file",
        footer: count,
        focused: true,
      });
      const [box, list] = split(inner, "v", [len(1), fill(1)]);
      ctx.setCursor(
        input(s, box!, c, {
          value: query,
          cursor: [...query].length,
          placeholder: "path fragments, in order",
          focused: true,
        }),
      );
      const from = state.window(list!.h, hits.length);
      for (let i = 0; i < list!.h; i++) {
        const hit = hits[from + i];
        if (hit === undefined) break;
        const y = list!.y + i;
        const selected = from + i === state.index;
        const bg = selected ? c.muted : c.card;
        s.fill({ x: list!.x, y, w: list!.w, h: 1 }, " ", style(c.fg, bg));
        // The basename is the thing being looked for; the directory is
        // context. Colouring them apart is most of what makes a long list of
        // paths scannable.
        const text = truncate(hit.item.text, Math.max(0, list!.w - 1));
        const base = hit.item.base;
        let x = list!.x + 1;
        [...text].forEach((ch, ci) => {
          const matched = hit.indices.includes(ci);
          x = s.text(
            x,
            y,
            ch,
            style(
              matched ? c.accent : ci >= base ? c.fg : c.mutedFg,
              bg,
              matched || selected ? BOLD : 0,
            ),
            list!.x + list!.w,
          );
        });
      }
      if (loaded && hits.length === 0)
        s.text(
          list!.x + 1,
          list!.y,
          truncate(query === "" ? "No files here." : "No match.", list!.w - 1),
          style(c.faint, c.card),
          list!.x + list!.w,
        );
    },
    paste(text) {
      query += text.replace(/\s+/g, "");
      refilter();
      return true;
    },
    key(e) {
      if (e.key === "esc") {
        ctx.pop();
        return true;
      }
      if (e.key === "enter") {
        const hit = hits[state.index];
        ctx.pop();
        if (hit !== undefined) onPick(hit.item.text);
        return true;
      }
      if (e.key === "down" || (e.ctrl && e.key === "n")) {
        state.move(1, hits.length);
        return true;
      }
      if (e.key === "up" || (e.ctrl && e.key === "p")) {
        state.move(-1, hits.length);
        return true;
      }
      if (e.ctrl && e.key === "d") {
        state.move(Math.max(1, state.height >> 1), hits.length);
        return true;
      }
      if (e.ctrl && e.key === "u") {
        state.move(-Math.max(1, state.height >> 1), hits.length);
        return true;
      }
      if (e.key === "backspace") {
        query = [...query].slice(0, -1).join("");
        refilter();
        return true;
      }
      if (!e.ctrl && !e.alt && [...e.key].length === 1) {
        query += e.key;
        refilter();
        return true;
      }
      return true;
    },
  };
}
