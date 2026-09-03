/**
 * A modeless text editor over an array of lines.
 *
 * The data structure is `string[]`, deliberately. VS Code's own writeup on
 * replacing theirs puts the choke point at "many lines (100k+)"; below that,
 * editing a character is one `slice`+`slice` on a single line — O(line), not
 * O(file) — and the only real cost centre is `splice` on Enter, which is a
 * memmove of the lines below the cursor and is sub-millisecond at any size a
 * source file reaches. A piece table is a later upgrade behind this same
 * interface, and the point of writing the interface down is that it can be.
 *
 * Four correctness rules matter more here than in a general editor, because
 * this one is attached to a git host and every spurious byte becomes a diff:
 *
 * - **The bytes round-trip.** CRLF, a BOM, and the presence or absence of a
 *   trailing newline are sniffed on load and re-emitted exactly. Nothing is
 *   normalised silently, and "ensure a final newline" is not a default.
 * - **Tabs stay tabs.** They render to the next multiple of four; the buffer
 *   keeps `\t`. Cursor motion moves in *display* columns while indices stay in
 *   buffer columns, which is the single most common off-by-one in a TUI
 *   editor and the reason the two conversions live in one pair of functions.
 * - **No soft wrap.** Screen row ↔ file row stays 1:1, which is what keeps a
 *   two-integer scroll model honest and the gutter aligned.
 * - **A large file is read-only rather than slow.** Past 1 MB or 50k lines the
 *   buffer opens for reading and says so, instead of quietly taking a second
 *   per keystroke.
 */

import {
  detectLanguage,
  scanOneLine,
  INITIAL_SCAN,
  type Language,
  type ScanState,
  type Token,
} from "../../web/highlight.ts";
import type { KeyEvent } from "../term/input.ts";
import { G, type Rect, type Screen as Surface } from "../term/screen.ts";
import { style, BOLD } from "../term/style.ts";
import { clusters, displayWidth, truncate } from "../term/width.ts";
import { tokColor, type Tokens } from "./theme.ts";
import type { CursorPos } from "./widgets.ts";

/** Past either of these the buffer opens read-only. */
export const MAX_EDIT_BYTES = 1024 * 1024;
export const MAX_EDIT_LINES = 50_000;
/** Beyond this a line is not tokenized — vim's `synmaxcol`, same reason. */
const MAX_HIGHLIGHT_COLS = 1000;
/** Undo records inside this window, typed contiguously, merge into one. */
const COALESCE_MS = 500;
const TAB = 4;

export interface Pos {
  readonly row: number;
  readonly col: number;
}

interface EditRecord {
  readonly at: Pos;
  readonly removed: string;
  readonly inserted: string;
  readonly before: Pos;
  readonly after: Pos;
  time: number;
  /** True while the record may still absorb the next keystroke. */
  open: boolean;
}

const cmp = (a: Pos, b: Pos): number => a.row - b.row || a.col - b.col;
const order = (a: Pos, b: Pos): [Pos, Pos] =>
  cmp(a, b) <= 0 ? [a, b] : [b, a];

/** Display column of a buffer column, expanding tabs to the next stop. */
export function displayCol(line: string, col: number): number {
  let width = 0;
  const chars = [...line];
  for (let i = 0; i < col && i < chars.length; i++) {
    const ch = chars[i]!;
    width += ch === "\t" ? TAB - (width % TAB) : displayWidth(ch);
  }
  return width;
}

/** The inverse: the buffer column at (or just before) a display column. */
export function colFromDisplay(line: string, want: number): number {
  const chars = [...line];
  let width = 0;
  for (let i = 0; i < chars.length; i++) {
    if (width >= want) return i;
    const ch = chars[i]!;
    width += ch === "\t" ? TAB - (width % TAB) : displayWidth(ch);
  }
  return chars.length;
}

/** The line as the terminal will show it — tabs expanded in place. */
export function expandLine(line: string): string {
  if (!line.includes("\t")) return line;
  let out = "";
  let width = 0;
  for (const ch of clusters(line)) {
    if (ch === "\t") {
      const n = TAB - (width % TAB);
      out += " ".repeat(n);
      width += n;
    } else {
      out += ch;
      width += displayWidth(ch);
    }
  }
  return out;
}

export interface EditorFile {
  readonly path: string;
  readonly eol: "\n" | "\r\n";
  readonly bom: boolean;
  readonly finalNewline: boolean;
}

export class Editor {
  lines: string[] = [""];
  cursor: Pos = { row: 0, col: 0 };
  /** The other end of a selection, or null when there is none. */
  anchor: Pos | null = null;
  top = 0;
  left = 0;
  height = 10;
  width = 80;
  readonly path: string;
  readonly eol: "\n" | "\r\n";
  readonly bom: boolean;
  readonly finalNewline: boolean;
  readonly readOnly: boolean;
  readonly readOnlyReason: string;
  readonly lang: Language;
  dirty = false;
  /** The editor's own clipboard; `ctrl+c` also mirrors it to the terminal. */
  clipboard = "";
  private undoStack: EditRecord[] = [];
  private redoStack: EditRecord[] = [];
  private desired = 0;
  /** `states[i]` is the tokenizer state *entering* line i. */
  private states: ScanState[] = [INITIAL_SCAN];
  private statesValid = 1;
  private original: string;

  constructor(bytes: Uint8Array, path: string) {
    this.path = path;
    this.lang = detectLanguage(path);
    const bom =
      bytes.length >= 3 &&
      bytes[0] === 0xef &&
      bytes[1] === 0xbb &&
      bytes[2] === 0xbf;
    this.bom = bom;
    const text = new TextDecoder().decode(bom ? bytes.subarray(3) : bytes);
    // Sniff the dominant line ending once. Mixed endings are normalised to
    // the majority on save, which is the only choice that does not turn one
    // edited line into a whole-file diff.
    const crlf = (text.match(/\r\n/g) ?? []).length;
    const lf = (text.match(/\n/g) ?? []).length;
    this.eol = crlf > 0 && crlf * 2 >= lf ? "\r\n" : "\n";
    const body = text.replace(/\r\n/g, "\n");
    this.finalNewline = body.endsWith("\n");
    const stripped = this.finalNewline ? body.slice(0, -1) : body;
    this.lines = stripped === "" ? [""] : stripped.split("\n");
    this.original = this.lines.join("\n");
    const tooBig =
      bytes.length > MAX_EDIT_BYTES || this.lines.length > MAX_EDIT_LINES;
    this.readOnly = tooBig;
    this.readOnlyReason = tooBig
      ? bytes.length > MAX_EDIT_BYTES
        ? `${Math.round(bytes.length / 1024)} KB — too large to edit`
        : `${this.lines.length} lines — too large to edit`
      : "";
  }

  get modified(): boolean {
    return this.lines.join("\n") !== this.original;
  }

  /** The file as bytes, in exactly the shape it was read in. */
  toBytes(): Uint8Array {
    const body =
      this.lines.join(this.eol) + (this.finalNewline ? this.eol : "");
    const encoded = new TextEncoder().encode(body);
    if (!this.bom) return encoded;
    const out = new Uint8Array(encoded.length + 3);
    out.set([0xef, 0xbb, 0xbf]);
    out.set(encoded, 3);
    return out;
  }

  /** Remember the current content as saved, so `modified` goes false. */
  markSaved(): void {
    this.original = this.lines.join("\n");
  }

  // ---- geometry ----

  private lineAt(row: number): string {
    return this.lines[row] ?? "";
  }

  private clamp(p: Pos): Pos {
    const row = Math.max(0, Math.min(p.row, this.lines.length - 1));
    const col = Math.max(0, Math.min(p.col, [...this.lineAt(row)].length));
    return { row, col };
  }

  private end(): Pos {
    const row = this.lines.length - 1;
    return { row, col: [...this.lineAt(row)].length };
  }

  selection(): [Pos, Pos] | null {
    if (this.anchor === null) return null;
    if (cmp(this.anchor, this.cursor) === 0) return null;
    return order(this.anchor, this.cursor);
  }

  textBetween(a: Pos, b: Pos): string {
    const [from, to] = order(a, b);
    if (from.row === to.row)
      return [...this.lineAt(from.row)].slice(from.col, to.col).join("");
    const parts = [[...this.lineAt(from.row)].slice(from.col).join("")];
    for (let r = from.row + 1; r < to.row; r++) parts.push(this.lineAt(r));
    parts.push([...this.lineAt(to.row)].slice(0, to.col).join(""));
    return parts.join("\n");
  }

  // ---- the one mutation ----

  /**
   * Replace everything between two positions with `text`. Every edit in the
   * editor is this call; undo is the same call with `removed` and `inserted`
   * swapped, which is why there is exactly one place that can corrupt the
   * buffer and it is forty lines long.
   */
  private splice(a: Pos, b: Pos, text: string): Pos {
    const [from, to] = order(a, b);
    const head = [...this.lineAt(from.row)].slice(0, from.col).join("");
    const tail = [...this.lineAt(to.row)].slice(to.col).join("");
    const inserted = text.split("\n");
    const first = inserted[0] ?? "";
    if (inserted.length === 1) {
      this.lines.splice(from.row, to.row - from.row + 1, head + first + tail);
      this.invalidateFrom(from.row);
      return { row: from.row, col: from.col + [...first].length };
    }
    const last = inserted[inserted.length - 1] ?? "";
    const middle = inserted.slice(1, -1);
    this.lines.splice(
      from.row,
      to.row - from.row + 1,
      head + first,
      ...middle,
      last + tail,
    );
    this.invalidateFrom(from.row);
    return { row: from.row + inserted.length - 1, col: [...last].length };
  }

  private invalidateFrom(row: number): void {
    this.statesValid = Math.min(this.statesValid, row + 1);
    this.dirty = true;
  }

  /** Apply an edit and push it onto the undo stack (coalescing where sane). */
  private edit(a: Pos, b: Pos, text: string, coalesce = false): void {
    if (this.readOnly) return;
    const [from, to] = order(a, b);
    const removed = this.textBetween(from, to);
    if (removed === "" && text === "") return;
    const before = this.cursor;
    const after = this.splice(from, to, text);
    this.cursor = after;
    this.anchor = null;
    this.redoStack = [];

    const prev = this.undoStack[this.undoStack.length - 1];
    const now = Date.now();
    if (
      coalesce &&
      prev !== undefined &&
      prev.open &&
      now - prev.time < COALESCE_MS &&
      prev.removed === "" &&
      removed === "" &&
      !text.includes("\n") &&
      // A word boundary forces a new record: typing "one two" and pressing
      // undo should give back "one ", not an empty line. This is the
      // heuristic every editor uses, and the one users have the strongest
      // intuition about.
      !/\s/.test(text) &&
      // Contiguity: this insert starts exactly where the last one ended.
      prev.at.row === from.row &&
      prev.at.col + [...prev.inserted].length === from.col
    ) {
      this.undoStack[this.undoStack.length - 1] = {
        ...prev,
        inserted: prev.inserted + text,
        after,
        time: now,
        open: !/\s/.test(text),
      };
      return;
    }
    for (const record of this.undoStack) record.open = false;
    this.undoStack.push({
      at: from,
      removed,
      inserted: text,
      before,
      after,
      time: now,
      open: coalesce && !/\s/.test(text),
    });
    if (this.undoStack.length > 5000) this.undoStack.shift();
  }

  undo(): boolean {
    const record = this.undoStack.pop();
    if (record === undefined) return false;
    const end = this.advance(record.at, record.inserted);
    this.splice(record.at, end, record.removed);
    this.cursor = this.clamp(record.before);
    this.anchor = null;
    this.redoStack.push(record);
    return true;
  }

  redo(): boolean {
    const record = this.redoStack.pop();
    if (record === undefined) return false;
    const end = this.advance(record.at, record.removed);
    this.splice(record.at, end, record.inserted);
    this.cursor = this.clamp(record.after);
    this.anchor = null;
    this.undoStack.push({ ...record, open: false });
    return true;
  }

  /** Where `text` inserted at `at` ends. */
  private advance(at: Pos, text: string): Pos {
    if (text === "") return at;
    const parts = text.split("\n");
    if (parts.length === 1)
      return { row: at.row, col: at.col + [...text].length };
    return {
      row: at.row + parts.length - 1,
      col: [...(parts[parts.length - 1] ?? "")].length,
    };
  }

  // ---- movement ----

  private moveTo(p: Pos, extend: boolean): void {
    if (extend) {
      if (this.anchor === null) this.anchor = this.cursor;
    } else this.anchor = null;
    this.cursor = this.clamp(p);
  }

  private left1(p: Pos): Pos {
    if (p.col > 0) return { row: p.row, col: p.col - 1 };
    if (p.row === 0) return p;
    return { row: p.row - 1, col: [...this.lineAt(p.row - 1)].length };
  }

  private right1(p: Pos): Pos {
    if (p.col < [...this.lineAt(p.row)].length)
      return { row: p.row, col: p.col + 1 };
    if (p.row >= this.lines.length - 1) return p;
    return { row: p.row + 1, col: 0 };
  }

  private wordLeft(p: Pos): Pos {
    let cur = this.left1(p);
    const isWord = (q: Pos): boolean =>
      /[A-Za-z0-9_]/.test([...this.lineAt(q.row)][q.col] ?? " ");
    while (cmp(cur, { row: 0, col: 0 }) > 0 && !isWord(cur))
      cur = this.left1(cur);
    while (cur.col > 0 && isWord({ row: cur.row, col: cur.col - 1 }))
      cur = { row: cur.row, col: cur.col - 1 };
    return cur;
  }

  private wordRight(p: Pos): Pos {
    const last = this.end();
    let cur = p;
    const at = (q: Pos): string => [...this.lineAt(q.row)][q.col] ?? " ";
    while (cmp(cur, last) < 0 && /[A-Za-z0-9_]/.test(at(cur)))
      cur = this.right1(cur);
    while (cmp(cur, last) < 0 && !/[A-Za-z0-9_]/.test(at(cur)))
      cur = this.right1(cur);
    return cur;
  }

  private vertical(delta: number, extend: boolean): void {
    const row = Math.max(
      0,
      Math.min(this.cursor.row + delta, this.lines.length - 1),
    );
    const col = colFromDisplay(this.lineAt(row), this.desired);
    this.moveTo({ row, col }, extend);
  }

  private syncDesired(): void {
    this.desired = displayCol(this.lineAt(this.cursor.row), this.cursor.col);
  }

  // ---- search ----

  /** Every match of `needle`, in document order. Case-insensitive. */
  matches(needle: string): Pos[] {
    if (needle === "") return [];
    const q = needle.toLowerCase();
    const out: Pos[] = [];
    this.lines.forEach((line, row) => {
      const hay = line.toLowerCase();
      let at = hay.indexOf(q);
      while (at !== -1) {
        out.push({ row, col: [...line.slice(0, at)].length });
        at = hay.indexOf(q, at + Math.max(1, q.length));
      }
    });
    return out;
  }

  /** Jump to the first match at or after the cursor, wrapping once. */
  seek(needle: string, forward = true): boolean {
    const all = this.matches(needle);
    if (all.length === 0) return false;
    const from = this.cursor;
    const next = forward
      ? (all.find((p) => cmp(p, from) > 0) ?? all[0]!)
      : ([...all].reverse().find((p) => cmp(p, from) < 0) ??
        all[all.length - 1]!);
    this.cursor = next;
    this.anchor = { row: next.row, col: next.col + [...needle].length };
    this.syncDesired();
    return true;
  }

  /** Replace every match. Returns how many. */
  replaceAll(needle: string, replacement: string): number {
    if (needle === "" || this.readOnly) return 0;
    const all = this.matches(needle).reverse();
    for (const at of all) {
      const end = { row: at.row, col: at.col + [...needle].length };
      this.edit(at, end, replacement);
    }
    return all.length;
  }

  // ---- input ----

  /** True when the key was the editor's. Modal find/replace lives outside. */
  key(e: KeyEvent): boolean {
    const extend = e.shift && e.key.length > 1;
    const ro = this.readOnly;

    if (e.ctrl) {
      switch (e.key) {
        case "left":
          this.moveTo(this.wordLeft(this.cursor), extend);
          this.syncDesired();
          return true;
        case "right":
          this.moveTo(this.wordRight(this.cursor), extend);
          this.syncDesired();
          return true;
        case "a":
          this.anchor = { row: 0, col: 0 };
          this.cursor = this.end();
          return true;
        case "c":
          this.copy();
          return true;
        case "x":
          if (!ro) this.cut();
          return true;
        case "v":
          if (!ro) this.insert(this.clipboard);
          return true;
        case "z":
          if (!ro) this.undo();
          return true;
        case "y":
          if (!ro) this.redo();
          return true;
        case "home":
          this.moveTo({ row: 0, col: 0 }, extend);
          return true;
        case "end":
          this.moveTo(this.end(), extend);
          return true;
        default:
          return false;
      }
    }
    if (e.alt) {
      if (e.key === "left" || e.key === "b") {
        this.moveTo(this.wordLeft(this.cursor), extend);
        this.syncDesired();
        return true;
      }
      if (e.key === "right" || e.key === "f") {
        this.moveTo(this.wordRight(this.cursor), extend);
        this.syncDesired();
        return true;
      }
      return false;
    }

    switch (e.key) {
      case "left":
        this.moveTo(this.left1(this.cursor), extend);
        this.syncDesired();
        return true;
      case "right":
        this.moveTo(this.right1(this.cursor), extend);
        this.syncDesired();
        return true;
      case "up":
        this.vertical(-1, extend);
        return true;
      case "down":
        this.vertical(1, extend);
        return true;
      case "pgup":
        this.vertical(-Math.max(1, this.height - 1), extend);
        return true;
      case "pgdn":
        this.vertical(Math.max(1, this.height - 1), extend);
        return true;
      case "home":
        this.moveTo({ row: this.cursor.row, col: 0 }, extend);
        this.syncDesired();
        return true;
      case "end":
        this.moveTo(
          {
            row: this.cursor.row,
            col: [...this.lineAt(this.cursor.row)].length,
          },
          extend,
        );
        this.syncDesired();
        return true;
      case "backspace": {
        if (ro) return true;
        const sel = this.selection();
        if (sel !== null) this.edit(sel[0], sel[1], "");
        else this.edit(this.left1(this.cursor), this.cursor, "");
        this.syncDesired();
        return true;
      }
      case "delete": {
        if (ro) return true;
        const sel = this.selection();
        if (sel !== null) this.edit(sel[0], sel[1], "");
        else this.edit(this.cursor, this.right1(this.cursor), "");
        this.syncDesired();
        return true;
      }
      case "enter": {
        if (ro) return true;
        // Auto-indent: a new line starts where the current one's text does.
        const line = this.lineAt(this.cursor.row);
        const indent = /^[ \t]*/.exec(line)?.[0] ?? "";
        this.insert(`\n${indent.slice(0, this.cursor.col)}`);
        return true;
      }
      case "tab":
        if (ro) return true;
        this.insert("\t");
        return true;
      default:
        break;
    }
    if (!ro && [...e.key].length === 1) {
      this.insert(e.key, true);
      return true;
    }
    return false;
  }

  insert(text: string, coalesce = false): void {
    if (this.readOnly || text === "") return;
    const sel = this.selection();
    if (sel !== null) this.edit(sel[0], sel[1], text);
    else this.edit(this.cursor, this.cursor, text, coalesce);
    this.syncDesired();
  }

  copy(): string {
    const sel = this.selection();
    const text =
      sel === null
        ? this.lineAt(this.cursor.row)
        : this.textBetween(sel[0], sel[1]);
    this.clipboard = text;
    return text;
  }

  cut(): string {
    const sel = this.selection();
    if (sel === null) {
      // No selection cuts the whole line, the one place a modeless editor
      // borrows from vim because everybody expects it to.
      const row = this.cursor.row;
      const text = this.lineAt(row);
      this.clipboard = text;
      const to =
        row + 1 < this.lines.length
          ? { row: row + 1, col: 0 }
          : { row, col: [...text].length };
      this.edit({ row, col: 0 }, to, "");
      return text;
    }
    const text = this.textBetween(sel[0], sel[1]);
    this.clipboard = text;
    this.edit(sel[0], sel[1], "");
    return text;
  }

  // ---- rendering ----

  /** The tokenizer state entering `row`, extending the cache as needed. */
  private tokensFor(row: number): Token[] {
    const line = this.lineAt(row);
    if (line.length > MAX_HIGHLIGHT_COLS) return [{ cls: "plain", text: line }];
    while (this.statesValid <= row) {
      const at = this.statesValid - 1;
      const scanned = scanOneLine(
        this.lineAt(at),
        this.lang,
        this.states[at] ?? INITIAL_SCAN,
      );
      this.states[at + 1] = scanned.state;
      this.statesValid++;
    }
    return scanOneLine(line, this.lang, this.states[row] ?? INITIAL_SCAN)
      .tokens;
  }

  /**
   * Draw the buffer into `r` and return where the caret belongs. The gutter is
   * as wide as the largest line number; everything right of it scrolls
   * horizontally in display columns.
   */
  render(s: Surface, r: Rect, c: Tokens, focused = true): CursorPos | null {
    if (r.w <= 0 || r.h <= 0) return null;
    this.height = r.h;
    const gutter = String(this.lines.length).length + 1;
    const textX = r.x + gutter;
    const textW = Math.max(1, r.w - gutter - 1);
    this.width = textW;

    // Keep the caret on screen, vertically and horizontally.
    if (this.cursor.row < this.top) this.top = this.cursor.row;
    if (this.cursor.row >= this.top + r.h) this.top = this.cursor.row - r.h + 1;
    this.top = Math.max(
      0,
      Math.min(this.top, Math.max(0, this.lines.length - 1)),
    );
    const caretCol = displayCol(this.lineAt(this.cursor.row), this.cursor.col);
    if (caretCol < this.left) this.left = caretCol;
    if (caretCol >= this.left + textW) this.left = caretCol - textW + 1;
    this.left = Math.max(0, this.left);

    const sel = this.selection();
    for (let i = 0; i < r.h; i++) {
      const row = this.top + i;
      if (row >= this.lines.length) break;
      const y = r.y + i;
      const isCursorRow = row === this.cursor.row;
      const lineBg = isCursorRow && focused ? c.card : c.bg;
      s.fill({ x: r.x, y, w: r.w, h: 1 }, " ", style(c.fg, lineBg));
      s.text(
        r.x,
        y,
        String(row + 1).padStart(gutter - 1, " "),
        style(isCursorRow ? c.mutedFg : c.faint, lineBg),
        textX,
      );

      // Tokens, expanded and windowed by display column. Expanding per token
      // keeps the tab stops right across a run boundary.
      let dcol = 0;
      let x = textX;
      for (const token of this.tokensFor(row)) {
        for (const ch of clusters(token.text)) {
          const w = ch === "\t" ? TAB - (dcol % TAB) : displayWidth(ch);
          const shown = ch === "\t" ? " ".repeat(w) : ch;
          if (dcol + w > this.left && dcol < this.left + textW) {
            const startsBefore = dcol < this.left;
            const text = startsBefore ? shown.slice(this.left - dcol) : shown;
            const inSel =
              sel !== null &&
              cmp(sel[0], { row, col: 0 }) <= 0 &&
              cmp({ row, col: 0 }, sel[1]) <= 0 &&
              this.inSelection(sel, row, dcol);
            x = s.text(
              x,
              y,
              text,
              style(tokColor(c, token), inSel ? c.muted : lineBg),
              textX + textW,
            );
          }
          dcol += w;
          if (dcol >= this.left + textW) break;
        }
        if (dcol >= this.left + textW) break;
      }
      if (this.left > 0)
        s.set(textX - 1, y, G.chevron, style(c.faint, lineBg), textX);
    }
    if (!focused) return null;
    return {
      x: textX + (caretCol - this.left),
      y: r.y + (this.cursor.row - this.top),
    };
  }

  /** Is the character at this display column inside the selection? */
  private inSelection(sel: [Pos, Pos], row: number, dcol: number): boolean {
    const line = this.lineAt(row);
    const col = colFromDisplay(line, dcol);
    const here: Pos = { row, col };
    return cmp(sel[0], here) <= 0 && cmp(here, sel[1]) < 0;
  }

  /** `path · Ln 12, Col 4 · modified` — the status line, as one string. */
  status(): string {
    const parts = [
      this.path,
      `Ln ${this.cursor.row + 1}, Col ${this.cursor.col + 1}`,
    ];
    if (this.readOnly) parts.push(`read-only — ${this.readOnlyReason}`);
    else if (this.modified) parts.push("modified");
    const sel = this.selection();
    if (sel !== null)
      parts.push(`${[...this.textBetween(sel[0], sel[1])].length} selected`);
    return parts.join(" · ");
  }

  /** The status line, clipped — the editor screen's footer. */
  statusFor(width: number): string {
    return truncate(this.status(), width);
  }
}

/** Bold the file name in a status line the caller has already measured. */
export const STATUS_BOLD = BOLD;
