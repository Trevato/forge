/**
 * The multi-line editor behind every comment and review body.
 *
 * Text is stored per *logical* line; wrapping is a view concern. The one
 * performance rule that matters: each logical line's wrap is cached and only
 * the edited line is re-wrapped, with a prefix sum of visual heights rebuilt
 * from that line forward. Re-summing every line on every keystroke is the
 * documented mechanism behind bubbles' textarea becoming unusable on a large
 * body, and avoiding it costs about twenty lines.
 */

import type { KeyEvent } from "../term/input.ts";
import { Screen, type Rect } from "../term/screen.ts";
import { style } from "../term/style.ts";
import { clusters, displayWidth, wrap } from "../term/width.ts";
import type { Tokens } from "./theme.ts";
import type { CursorPos } from "./widgets.ts";

/** What the caller must react to. Everything else is handled internally. */
export type TextareaEvent =
  | "submit"
  | "cancel"
  | "changed"
  | "moved"
  | "ignored";

export class Textarea {
  private lines: string[];
  private wrapped: string[][] = [];
  private prefix: number[] = [0];
  private width = 0;
  row = 0;
  col = 0;
  /** Remembered column for up/down across short lines. */
  private desired = 0;
  offset = 0;

  constructor(value = "") {
    // Normalise line endings once, at the boundary. Every height and width
    // calculation downstream assumes "\n" and nothing else.
    this.lines = value.replace(/\r\n?/g, "\n").split("\n");
  }

  get value(): string {
    return this.lines.join("\n");
  }

  get isEmpty(): boolean {
    return this.lines.every((l) => l === "");
  }

  setValue(v: string): void {
    this.lines = v.replace(/\r\n?/g, "\n").split("\n");
    this.row = Math.min(this.row, this.lines.length - 1);
    this.col = Math.min(this.col, this.cur().length);
    this.width = 0; // force a re-wrap
  }

  private cur(): string[] {
    return clusters(this.lines[this.row] ?? "");
  }

  key(e: KeyEvent): TextareaEvent {
    // Ctrl+D submits here and pages down in a list — the contexts are
    // disjoint, so the two never collide, and Ctrl+Enter only exists under
    // the kitty protocol which we deliberately do not require.
    if (e.ctrl && e.key === "d") return "submit";
    if (e.ctrl && e.key === "enter") return "submit";
    if (e.key === "esc") return "cancel";

    if (e.ctrl && e.key === "w") return this.deleteWordBack();
    if (e.alt && e.key === "left") return this.move(this.wordBack());
    if (e.alt && e.key === "right") return this.move(this.wordForward());

    switch (e.key) {
      case "left":
        return this.move(this.back());
      case "right":
        return this.move(this.forward());
      case "up":
        return this.vertical(-1);
      case "down":
        return this.vertical(1);
      case "home":
        this.col = 0;
        this.desired = 0;
        return "moved";
      case "end":
        this.col = this.cur().length;
        this.desired = this.col;
        return "moved";
      case "enter":
        return this.insert("\n");
      case "backspace":
        return this.backspace();
      case "delete":
        return this.forwardDelete();
      case "tab":
        return this.insert("  ");
      default:
        break;
    }
    // A printable key is exactly one grapheme cluster with no ctrl/alt. Named
    // keys ("up", "f1", "esc") are two or more clusters, so they fall through
    // rather than being typed into the buffer.
    if (!e.ctrl && !e.alt && clusters(e.key).length === 1 && displayWidth(e.key) > 0)
      return this.insert(e.key);
    return "ignored";
  }

  /** Paste splices the whole run in one edit, never character by character. */
  paste(text: string): TextareaEvent {
    return this.insert(text.replace(/\r\n?/g, "\n"));
  }

  private insert(text: string): TextareaEvent {
    const cur = this.cur();
    const head = cur.slice(0, this.col).join("");
    const tail = cur.slice(this.col).join("");
    const parts = (head + text + tail).split("\n");
    const before = this.lines.slice(0, this.row);
    const after = this.lines.slice(this.row + 1);
    this.lines = [...before, ...parts, ...after];
    const added = text.split("\n");
    if (added.length === 1) this.col += clusters(text).length;
    else {
      this.row += added.length - 1;
      this.col = clusters(added[added.length - 1]!).length;
    }
    this.invalidate(this.row);
    this.syncDesired();
    return "changed";
  }

  private backspace(): TextareaEvent {
    if (this.col > 0) {
      const cur = this.cur();
      this.lines[this.row] = [
        ...cur.slice(0, this.col - 1),
        ...cur.slice(this.col),
      ].join("");
      this.col--;
    } else if (this.row > 0) {
      const prev = clusters(this.lines[this.row - 1] ?? "");
      this.col = prev.length;
      this.lines[this.row - 1] =
        (this.lines[this.row - 1] ?? "") + (this.lines[this.row] ?? "");
      this.lines.splice(this.row, 1);
      this.row--;
    } else return "ignored";
    this.invalidate(this.row);
    this.syncDesired();
    return "changed";
  }

  private forwardDelete(): TextareaEvent {
    const cur = this.cur();
    if (this.col < cur.length) {
      this.lines[this.row] = [
        ...cur.slice(0, this.col),
        ...cur.slice(this.col + 1),
      ].join("");
    } else if (this.row < this.lines.length - 1) {
      this.lines[this.row] =
        (this.lines[this.row] ?? "") + (this.lines[this.row + 1] ?? "");
      this.lines.splice(this.row + 1, 1);
    } else return "ignored";
    this.invalidate(this.row);
    return "changed";
  }

  private deleteWordBack(): TextareaEvent {
    const target = this.wordBack();
    if (target.row === this.row && target.col === this.col) return "ignored";
    const cur = this.cur();
    if (target.row === this.row) {
      this.lines[this.row] = [
        ...cur.slice(0, target.col),
        ...cur.slice(this.col),
      ].join("");
      this.col = target.col;
      this.invalidate(this.row);
      this.syncDesired();
      return "changed";
    }
    return this.backspace();
  }

  private back(): { row: number; col: number } {
    if (this.col > 0) return { row: this.row, col: this.col - 1 };
    if (this.row > 0)
      return {
        row: this.row - 1,
        col: clusters(this.lines[this.row - 1] ?? "").length,
      };
    return { row: this.row, col: this.col };
  }

  private forward(): { row: number; col: number } {
    if (this.col < this.cur().length)
      return { row: this.row, col: this.col + 1 };
    if (this.row < this.lines.length - 1) return { row: this.row + 1, col: 0 };
    return { row: this.row, col: this.col };
  }

  private wordBack(): { row: number; col: number } {
    const cur = this.cur();
    let i = this.col;
    while (i > 0 && /\s/.test(cur[i - 1] ?? "")) i--;
    while (i > 0 && !/\s/.test(cur[i - 1] ?? "")) i--;
    if (i === this.col && this.row > 0) return this.back();
    return { row: this.row, col: i };
  }

  private wordForward(): { row: number; col: number } {
    const cur = this.cur();
    let i = this.col;
    while (i < cur.length && !/\s/.test(cur[i] ?? "")) i++;
    while (i < cur.length && /\s/.test(cur[i] ?? "")) i++;
    if (i === this.col && this.row < this.lines.length - 1)
      return this.forward();
    return { row: this.row, col: i };
  }

  private move(to: { row: number; col: number }): TextareaEvent {
    if (to.row === this.row && to.col === this.col) return "ignored";
    this.row = to.row;
    this.col = to.col;
    this.syncDesired();
    return "moved";
  }

  /** The remembered column is a *visual* one, so it survives a wrap point. */
  private syncDesired(): void {
    this.desired =
      this.width > 0 && this.wrapped.length === this.lines.length
        ? this.visualOfCursor().column
        : this.col;
  }

  /** Up/down move by *visual* line, so wrapped text navigates as it reads. */
  private vertical(dir: -1 | 1): TextareaEvent {
    if (this.width <= 0) {
      const row = Math.max(0, Math.min(this.lines.length - 1, this.row + dir));
      if (row === this.row) return "ignored";
      this.row = row;
      this.col = Math.min(this.desired, this.cur().length);
      return "moved";
    }
    const v = this.visualOfCursor();
    const target = v.index + dir;
    if (target < 0 || target >= this.totalVisual()) return "ignored";
    const at = this.logicalOfVisual(target);
    this.row = at.row;
    this.col = Math.min(
      at.start + Math.min(this.desired, at.length),
      clusters(this.lines[this.row] ?? "").length,
    );
    return "moved";
  }

  // ---- wrapping, cached per logical line ----

  private ensureWrapped(width: number): void {
    if (width === this.width && this.wrapped.length === this.lines.length)
      return;
    this.width = width;
    this.wrapped = this.lines.map((l) => wrapLine(l, width));
    this.rebuildPrefix(0);
  }

  private invalidate(row: number): void {
    if (this.width <= 0) return;
    // Only the edited line is re-wrapped; the prefix sum is rebuilt from
    // there forward, and only when that line's height actually changed.
    const fresh = this.lines.map((l, i) =>
      i === row || this.wrapped[i] === undefined
        ? wrapLine(l, this.width)
        : this.wrapped[i]!,
    );
    this.wrapped = fresh;
    this.rebuildPrefix(row);
  }

  private rebuildPrefix(from: number): void {
    if (this.prefix.length !== this.wrapped.length + 1) {
      this.prefix = new Array<number>(this.wrapped.length + 1).fill(0);
      from = 0;
    }
    for (let i = from; i < this.wrapped.length; i++)
      this.prefix[i + 1] =
        this.prefix[i]! + Math.max(1, this.wrapped[i]!.length);
  }

  private totalVisual(): number {
    return this.prefix[this.prefix.length - 1] ?? 0;
  }

  private visualOfCursor(): { index: number; column: number } {
    const rows = this.wrapped[this.row] ?? [""];
    let seen = 0;
    for (let i = 0; i < rows.length; i++) {
      const n = clusters(rows[i]!).length;
      if (this.col <= seen + n || i === rows.length - 1)
        return {
          index: (this.prefix[this.row] ?? 0) + i,
          column: this.col - seen,
        };
      seen += n;
    }
    return { index: this.prefix[this.row] ?? 0, column: this.col };
  }

  private logicalOfVisual(index: number): {
    row: number;
    start: number;
    length: number;
  } {
    for (let r = 0; r < this.wrapped.length; r++) {
      const base = this.prefix[r] ?? 0;
      const rows = this.wrapped[r]!;
      if (index < base + Math.max(1, rows.length)) {
        let start = 0;
        for (let i = 0; i < index - base; i++)
          start += clusters(rows[i] ?? "").length;
        return {
          row: r,
          start,
          length: clusters(rows[index - base] ?? "").length,
        };
      }
    }
    return { row: this.lines.length - 1, start: 0, length: 0 };
  }

  /** Draw, scrolling so the caret stays visible. Returns the caret position. */
  render(s: Screen, r: Rect, c: Tokens, focused = true): CursorPos | null {
    if (r.w <= 0 || r.h <= 0) return null;
    this.ensureWrapped(r.w);
    const cursor = this.visualOfCursor();
    if (cursor.index < this.offset) this.offset = cursor.index;
    if (cursor.index >= this.offset + r.h) this.offset = cursor.index - r.h + 1;
    this.offset = Math.max(
      0,
      Math.min(this.offset, Math.max(0, this.totalVisual() - r.h)),
    );

    const st = style(c.fg, c.card);
    s.fill(r, " ", st);
    let drawn = 0;
    for (
      let idx = this.offset;
      drawn < r.h && idx < this.totalVisual();
      idx++, drawn++
    ) {
      const at = this.logicalOfVisual(idx);
      const rows = this.wrapped[at.row] ?? [""];
      const text = rows[idx - (this.prefix[at.row] ?? 0)] ?? "";
      s.text(r.x, r.y + drawn, text, st, r.x + r.w);
    }
    if (!focused) return null;
    return {
      x:
        r.x +
        Math.min(
          r.w - 1,
          columnWidth(this.wrappedRowText(cursor.index), cursor.column),
        ),
      y: r.y + (cursor.index - this.offset),
    };
  }

  private wrappedRowText(index: number): string {
    const at = this.logicalOfVisual(index);
    const rows = this.wrapped[at.row] ?? [""];
    return rows[index - (this.prefix[at.row] ?? 0)] ?? "";
  }
}

/**
 * Wrap one logical line, keeping the trailing space at each break. Dropping
 * it makes the caret jump when you navigate past a wrap point, which reads as
 * a bug even though the text is identical.
 */
function wrapLine(line: string, width: number): string[] {
  if (width <= 0) return [line];
  if (displayWidth(line) <= width) return [line];
  return wrap(line, width);
}

function columnWidth(text: string, col: number): number {
  return displayWidth(clusters(text).slice(0, col).join(""));
}
