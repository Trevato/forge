/**
 * The diff renderer: previous frame vs next frame → the minimal ANSI that
 * turns one into the other.
 *
 * Every frame is wrapped in DEC mode 2026 (synchronized output) so the
 * terminal paints once instead of showing our cursor walking the screen —
 * that, plus diffing cells rather than lines, is what removes the flicker
 * class that line-diff renderers spend their lives fighting.
 */

import {
  CURSOR_HIDE,
  CURSOR_SHOW,
  ERASE_ALL,
  SGR_RESET,
  SYNC_BEGIN,
  SYNC_END,
  OSC8_CLOSE,
  cup,
  osc8Open,
} from "./ansi.ts";
import { glyphText, Screen, TRAIL } from "./screen.ts";
import {
  PLAIN,
  sgrDelta,
  visibleOnBlank,
  type ColorDepth,
  type Style,
} from "./style.ts";

export interface Cursor {
  readonly x: number;
  readonly y: number;
}

export class Renderer {
  private prev: Screen | null = null;
  private prevCursor: Cursor | null = null;

  constructor(private depth: ColorDepth = "truecolor") {}

  /** Colour depth is per session: one style tree, N sessions, N depths. */
  setDepth(depth: ColorDepth): void {
    if (depth === this.depth) return;
    this.depth = depth;
    this.invalidate();
  }

  /** Force a full repaint. Called on resize, and whenever we lose the screen. */
  invalidate(): void {
    this.prev = null;
  }

  render(next: Screen, cursor: Cursor | null): string {
    const full =
      this.prev === null ||
      this.prev.cols !== next.cols ||
      this.prev.rows !== next.rows;
    const prev = full ? null : this.prev;

    const body = full ? this.paintAll(next) : this.paintDiff(prev!, next);
    const cursorMoved =
      (cursor?.x ?? -1) !== (this.prevCursor?.x ?? -1) ||
      (cursor?.y ?? -1) !== (this.prevCursor?.y ?? -1);

    this.remember(next, cursor);
    // A frame with no changes emits zero bytes. Terminals that get nothing
    // stay exactly as they were, which is the cheapest correct answer.
    if (body === "" && !cursorMoved && !full) return "";

    const tail =
      cursor === null ? "" : `${cup(cursor.y, cursor.x)}${CURSOR_SHOW}`;
    return `${SYNC_BEGIN}${CURSOR_HIDE}${full ? ERASE_ALL : ""}${body}${SGR_RESET}${tail}${SYNC_END}`;
  }

  private remember(next: Screen, cursor: Cursor | null): void {
    if (
      this.prev === null ||
      this.prev.cols !== next.cols ||
      this.prev.rows !== next.rows
    ) {
      this.prev = new Screen(next.cols, next.rows);
    }
    this.prev.glyph.set(next.glyph);
    this.prev.fg.set(next.fg);
    this.prev.bg.set(next.bg);
    this.prev.attr.set(next.attr);
    this.prev.width.set(next.width);
    this.prev.link.set(next.link);
    this.prev.adoptLinks(next);
    this.prevCursor = cursor;
  }

  private paintAll(next: Screen): string {
    return this.emit(next, () => true);
  }

  private paintDiff(prev: Screen, next: Screen): string {
    return this.emit(next, (i) => this.differs(prev, next, i));
  }

  private differs(prev: Screen, next: Screen, i: number): boolean {
    return (
      prev.glyph[i] !== next.glyph[i] ||
      prev.fg[i] !== next.fg[i] ||
      prev.bg[i] !== next.bg[i] ||
      prev.attr[i] !== next.attr[i] ||
      prev.width[i] !== next.width[i] ||
      // Plane values are per-frame table indices, so a raw compare would
      // call two different URLs equal whenever the tables were built in a
      // different order. Compare the URIs; the id compare short-circuits the
      // overwhelmingly common "neither cell is a link" case first.
      (prev.link[i] !== next.link[i] &&
        prev.uriOf(prev.link[i]!) !== next.uriOf(next.link[i]!))
    );
  }

  /**
   * Walk the grid advancing by *cell width*, never by index — the trailing
   * column of a wide glyph is printed by its lead and must not be visited on
   * its own, or the terminal receives one character too many for the row.
   */
  private emit(next: Screen, dirty: (i: number) => boolean): string {
    const prev = this.prev;
    let out = "";
    let cur: Style = PLAIN;
    let lastRow = -1;
    let lastCol = -1;
    // The URI currently open in the byte stream, "" for none. OSC 8 and SGR
    // are independent — the frame-final SGR reset does *not* close a
    // hyperlink — so this is tracked and closed explicitly.
    let openUri = "";
    const link = (uri: string, id: number): void => {
      if (uri === openUri) return;
      if (openUri !== "") out += OSC8_CLOSE;
      // Always carry `id=`: a diff renderer paints dirty *runs*, so one
      // logical link routinely reaches the terminal as several disjoint
      // spans, and without a shared id each underlines separately on hover.
      if (uri !== "") out += osc8Open(uri, id);
      openUri = uri;
    };

    for (let y = 0; y < next.rows; y++) {
      // Never carry a link across a row: the renderer positions absolutely,
      // and an open link spanning a CUP swallows everything in between.
      link("", 0);
      let x = 0;
      while (x < next.cols) {
        const i = next.idx(x, y);
        const w = next.width[i]!;
        if (w === 0) {
          // Orphaned trailing column (only reachable if a lead was clipped).
          x++;
          continue;
        }
        let write = dirty(i);
        // The stale-trailing-column bug: a wide styled cell replaced by a
        // narrow one leaves its second column holding the old background,
        // because nothing overwrites it. Force-write the uncovered column
        // whenever the outgoing cell was visible on a blank.
        if (!write && prev !== null && prev.width[i]! > w) {
          const old: Style = {
            fg: prev.fg[i]!,
            bg: prev.bg[i]!,
            attr: prev.attr[i]!,
          };
          if (visibleOnBlank(old)) write = true;
        }
        if (!write) {
          x += w;
          continue;
        }

        // Elide the cursor move when the previous write ended exactly here.
        if (lastRow !== y || lastCol !== x) {
          link("", 0);
          out += cup(y, x);
        }
        const st: Style = {
          fg: next.fg[i]!,
          bg: next.bg[i]!,
          attr: next.attr[i]!,
        };
        const delta = sgrDelta(cur, st, this.depth);
        if (delta !== "") {
          out += delta;
          cur = st;
        }
        // SGR first, then the OSC 8 open, so the styled underline covers the
        // link text rather than the cell before it.
        const id = next.link[i]!;
        link(next.uriOf(id), id);
        const g = next.glyph[i]!;
        out += g === TRAIL ? " " : glyphText(g);
        lastRow = y;
        lastCol = x + w;
        x += w;
      }
    }
    link("", 0);
    return out;
  }
}

// Note on the bottom-right cell: VT100-family terminals implement *deferred*
// wrap — writing the last column sets a pending-wrap flag, and the wrap only
// happens when the next character arrives. We emit SGR and CUP after the last
// glyph, never another character, and terminal.ts turns auto-wrap off for the
// duration of the session anyway. So the corner is safe to paint.
