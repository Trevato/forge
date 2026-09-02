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

export class Palette {
  query = "";
  selected = 0;
  private commands: readonly Command[] = [];

  open(commands: readonly Command[]): void {
    this.commands = commands;
    this.query = "";
    this.selected = 0;
  }

  matches(): Match[] {
    return rank(this.commands, this.query);
  }

  /** Returns the chosen command, "close", or null when it merely consumed. */
  key(e: KeyEvent): Command | "close" | null {
    const list = this.matches();
    if (e.key === "esc") return "close";
    if (e.key === "enter") return list[this.selected]?.command ?? "close";
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

  render(s: Surface, area: Rect, c: Tokens): CursorPos | null {
    const list = this.matches();
    const height = Math.min(area.h - 4, list.length + 5);
    const r = center(area, Math.min(64, area.w - 4), Math.max(6, height));
    const inner = card(s, r, c, { title: "Command", focused: true });
    const [box, rest] = split(inner, "v", [len(1), fill(1)]);
    const cursor =
      box === undefined
        ? null
        : input(s, box, c, {
            value: this.query,
            cursor: [...this.query].length,
            placeholder: "type a command, or :pr 42",
            focused: true,
          });
    if (rest === undefined) return cursor;
    for (let i = 0; i < rest.h; i++) {
      const match = list[i];
      if (match === undefined) break;
      const y = rest.y + i;
      const sel = i === this.selected;
      const bg = sel ? c.muted : c.card;
      s.fill({ x: rest.x, y, w: rest.w, h: 1 }, " ", style(c.fg, bg));
      const title = truncate(match.command.title, Math.max(0, rest.w - 2));
      let x = rest.x + 1;
      // Bold exactly the matched characters — the payoff of returning indices.
      [...title].forEach((ch, ci) => {
        const hot = match.indices.includes(ci);
        x = s.text(
          x,
          y,
          ch,
          style(hot ? c.accent : c.fg, bg, hot || sel ? BOLD : 0),
          rest.x + rest.w,
        );
      });
      if (match.command.hint !== undefined)
        s.text(
          x + 2,
          y,
          truncate(match.command.hint, Math.max(0, rest.x + rest.w - x - 2)),
          style(c.faint, bg),
          rest.x + rest.w,
        );
    }
    return cursor;
  }
}
