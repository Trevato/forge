/**
 * The `:` command palette. Fuzzy over actions, and the scorer returns the
 * matched character indices so the list can bold exactly those characters —
 * that highlight is what makes a filter feel alive rather than merely fast.
 *
 * Greedy leftmost subsequence with fzf's bonus constants, without its DP.
 * Greedy is marginally worse on pathological inputs; on repo, file and issue
 * names nobody notices, and it is twenty-five lines instead of two hundred.
 */

import { Screen as Surface, type Rect } from "../term/screen.ts";
import { BOLD, style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import { center, split, len, fill } from "../ui/layout.ts";
import type { Tokens } from "../ui/theme.ts";
import { card, input, type CursorPos } from "../ui/widgets.ts";
import type { KeyEvent } from "../term/input.ts";

export interface Command {
  readonly id: string;
  readonly title: string;
  readonly hint?: string;
  run(): void | Promise<void>;
}

/**
 * One row of search results. Same shape as a command — because from the
 * palette's side "open octo/widgets" and "New repository" are the same act,
 * and the only difference worth drawing is which heading it sits under.
 */
export interface PaletteItem extends Command {
  /** The heading it appears under: "Repos", "Issues & pulls", "Code". */
  readonly section: string;
  /** A leading mark: the where-dot, `▲ mirrored as …`. */
  readonly mark?: string;
  /** Matched offsets in `title`, when the provider scored it itself. */
  readonly indices?: readonly number[];
}

/**
 * Where search results come from. The app owns the debounce and the
 * cancellation; a provider is handed a query, whether the caller has paused
 * long enough to justify spending somebody's rate budget on their origins,
 * and a signal that fires when the answer stops mattering.
 */
export type PaletteSearch = (
  query: string,
  live: boolean,
  signal: AbortSignal,
) => Promise<PaletteItem[]>;

/** A drawn line: either a heading, or something selectable. */
type Row =
  | { readonly kind: "header"; readonly label: string }
  | {
      readonly kind: "item";
      readonly item: Command | PaletteItem;
      readonly indices: readonly number[];
      readonly mark: string;
    };

/** What one paint of the palette produced: the caret, and the clickable rows. */
export interface PaletteFrame {
  readonly cursor: CursorPos | null;
  /** One per drawn item row, carrying its index into `items()`. */
  readonly rows: readonly { index: number; rect: Rect }[];
}

export interface Match {
  readonly command: Command;
  readonly score: number;
  readonly indices: readonly number[];
}

const SCORE_MATCH = 16;
const BONUS_CONSECUTIVE = 4;
const GAP_START = -3;
const GAP_EXTEND = -1;

export function score(
  pattern: string,
  haystack: string,
): { score: number; indices: number[] } | null {
  if (pattern === "") return { score: 0, indices: [] };
  const p = pattern.toLowerCase();
  const h = haystack.toLowerCase();
  const indices: number[] = [];
  let total = 0;
  let at = 0;
  let prev = -1;
  for (let i = 0; i < p.length; i++) {
    const found = h.indexOf(p[i]!, at);
    if (found === -1) return null;
    total += SCORE_MATCH;
    if (found === prev + 1) total += BONUS_CONSECUTIVE;
    else if (prev >= 0) total += GAP_START + GAP_EXTEND * (found - prev - 2);
    const before = found === 0 ? " " : haystack[found - 1]!;
    let bonus = 0;
    if (found === 0 || /\s/.test(before)) bonus = 10;
    else if ("/:;,-_.".includes(before)) bonus = 9;
    else if (/[a-z0-9]/.test(before) && /[A-Z]/.test(haystack[found]!))
      bonus = 7;
    total += i === 0 ? bonus * 2 : bonus;
    indices.push(found);
    prev = found;
    at = found + 1;
  }
  return { score: total, indices };
}

export function rank(commands: readonly Command[], query: string): Match[] {
  const out: Match[] = [];
  for (const command of commands) {
    const hit = score(query, command.title);
    if (hit === null) continue;
    out.push({ command, score: hit.score, indices: hit.indices });
  }
  // Ties break on the shorter title, then the earlier first match — both are
  // proxies for "the thing the user meant".
  out.sort(
    (a, b) =>
      b.score - a.score ||
      a.command.title.length - b.command.title.length ||
      (a.indices[0] ?? 0) - (b.indices[0] ?? 0),
  );
  return out;
}

/**
 * The palette is the search box.
 *
 * It used to be a filter over forty verbs. That is a fine thing to have and it
 * is still the last section — but the question a person actually types into a
 * box in a forge is "where is that repo / that issue / that line of code", and
 * asking it in three different places was the bug. So the same keystrokes now
 * run `actions/search.ts` across everything the session can reach, local *and*
 * every connected origin, and the answers arrive in sections.
 *
 * The palette itself stays synchronous and dumb: it holds a query, a list of
 * results somebody else fetched, and a cursor. Debouncing, cancelling and the
 * decision to spend an origin's rate budget all live in the loop
 * (`app/app.ts`), because those are timing concerns and this is a widget.
 */
export class Palette {
  query = "";
  selected = 0;
  /** True while a search for the current query is in flight. */
  searching = false;
  private commands: readonly Command[] = [];
  private results: readonly PaletteItem[] = [];

  open(commands: readonly Command[]): void {
    this.commands = commands;
    this.results = [];
    this.searching = false;
    this.query = "";
    this.selected = 0;
  }

  /** Fresh results for the current query. Keeps the cursor in range. */
  setResults(items: readonly PaletteItem[]): void {
    this.results = items;
    this.searching = false;
    this.selected = Math.min(
      this.selected,
      Math.max(0, this.items().length - 1),
    );
  }

  matches(): Match[] {
    return rank(this.commands, this.query);
  }

  /**
   * Everything drawable, headings included, in section order: search results
   * first (they answer the question that was typed), commands last.
   */
  rows(): Row[] {
    const out: Row[] = [];
    let section = "";
    for (const item of this.results) {
      if (item.section !== section) {
        section = item.section;
        out.push({ kind: "header", label: section });
      }
      out.push({
        kind: "item",
        item,
        indices: item.indices ?? [],
        mark: item.mark ?? "",
      });
    }
    const verbs = this.matches();
    if (verbs.length > 0) {
      if (out.length > 0) out.push({ kind: "header", label: "Commands" });
      for (const match of verbs)
        out.push({
          kind: "item",
          item: match.command,
          indices: match.indices,
          mark: "",
        });
    }
    return out;
  }

  /** Just the selectable rows, which is what `selected` indexes. */
  items(): (Command | PaletteItem)[] {
    return this.rows().flatMap((r) => (r.kind === "item" ? [r.item] : []));
  }

  /** Returns the chosen command, "close", or null when it merely consumed. */
  key(e: KeyEvent): Command | "close" | null {
    const list = this.items();
    if (e.key === "esc") return "close";
    if (e.key === "enter") return list[this.selected] ?? "close";
    if (e.key === "down" || (e.ctrl && e.key === "n")) {
      this.selected = Math.min(this.selected + 1, Math.max(0, list.length - 1));
      return null;
    }
    if (e.key === "up" || (e.ctrl && e.key === "p")) {
      this.selected = Math.max(0, this.selected - 1);
      return null;
    }
    if (e.key === "backspace") {
      this.query = [...this.query].slice(0, -1).join("");
      this.selected = 0;
      return null;
    }
    if (!e.ctrl && !e.alt && [...e.key].length === 1) {
      this.query += e.key;
      this.selected = 0;
    }
    return null;
  }

  render(s: Surface, area: Rect, c: Tokens): PaletteFrame {
    const hits: { index: number; rect: Rect }[] = [];
    const rows = this.rows();
    const height = Math.min(area.h - 4, rows.length + 5);
    const r = center(area, Math.min(76, area.w - 4), Math.max(6, height));
    const inner = card(s, r, c, {
      title: "Search",
      ...(this.searching ? { footer: "searching…" } : {}),
      focused: true,
    });
    const [box, rest] = split(inner, "v", [len(1), fill(1)]);
    const cursor =
      box === undefined
        ? null
        : input(s, box, c, {
            value: this.query,
            cursor: [...this.query].length,
            placeholder: "repos, issues, code, or a command",
            focused: true,
          });
    if (rest === undefined) return { cursor, rows: hits };

    // Scroll the flat row list so the selection stays visible, counting
    // headers as rows — otherwise a long Repos section hides the cursor.
    const selectedRow = rows.findIndex(
      (row, i) =>
        row.kind === "item" &&
        rows.slice(0, i).filter((x) => x.kind === "item").length ===
          this.selected,
    );
    let from = 0;
    if (selectedRow >= rest.h) from = selectedRow - rest.h + 1;

    let index = -1;
    for (let i = 0; i < rest.h; i++) {
      const row = rows[from + i];
      if (row === undefined) break;
      const y = rest.y + i;
      if (row.kind === "header") {
        s.fill({ x: rest.x, y, w: rest.w, h: 1 }, " ", style(c.faint, c.card));
        s.text(
          rest.x + 1,
          y,
          truncate(row.label.toUpperCase(), Math.max(0, rest.w - 2)),
          style(c.faint, c.card, BOLD),
          rest.x + rest.w,
        );
        continue;
      }
      index = rows.slice(0, from + i).filter((x) => x.kind === "item").length;
      hits.push({ index, rect: { x: rest.x, y, w: rest.w, h: 1 } });
      const sel = index === this.selected;
      const bg = sel ? c.muted : c.card;
      s.fill({ x: rest.x, y, w: rest.w, h: 1 }, " ", style(c.fg, bg));
      let x = rest.x + 1;
      if (row.mark !== "")
        x = s.text(x, y, `${row.mark} `, style(c.mutedFg, bg), rest.x + rest.w);
      const title = truncate(
        row.item.title,
        Math.max(0, rest.w - 2 - (x - rest.x)),
      );
      // Bold exactly the matched characters — the payoff of returning indices.
      [...title].forEach((ch, ci) => {
        const hot = row.indices.includes(ci);
        x = s.text(
          x,
          y,
          ch,
          style(hot ? c.accent : c.fg, bg, hot || sel ? BOLD : 0),
          rest.x + rest.w,
        );
      });
      if (row.item.hint !== undefined)
        s.text(
          x + 2,
          y,
          truncate(row.item.hint, Math.max(0, rest.x + rest.w - x - 2)),
          style(c.faint, bg),
          rest.x + rest.w,
        );
    }
    return { cursor, rows: hits };
  }
}
