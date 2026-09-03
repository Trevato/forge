/**
 * The cell buffer. Parallel typed arrays rather than an array of objects: one
 * allocation per resize, zero per frame, and diffing two cells is an integer
 * compare. Grapheme clusters are interned into a table so a cell stays a
 * fixed-width record no matter what the user pasted into it.
 *
 * Two invariants carry the wide-glyph correctness (notcurses' rules, which
 * ratatui learned the same way):
 *   - never store half a wide glyph: the lead column holds the cluster with
 *     width 2, the trailing column holds `TRAIL` with width 0;
 *   - any write that overlaps a wide glyph obliterates *both* of its columns,
 *     because a terminal asked to print over one half renders neither.
 */

import { clusterWidth, clusters, displayWidth, type Align } from "./width.ts";
import {
  DEFAULT,
  PLAIN,
  sameStyle,
  sgrDelta,
  type Style,
  type ColorDepth,
} from "./style.ts";

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** A run of text sharing one style — what markdown and diff rendering emit. */
export interface Span {
  readonly text: string;
  readonly style: Style;
  /** When set, these cells are an OSC 8 hyperlink to this URI. */
  readonly link?: string;
}

export const BLANK = 32; // ' '
export const TRAIL = 0; // the second column of a wide glyph

// Interned clusters. Seeded with ASCII so `id === codepoint` there, which
// keeps the common case free of a Map lookup on read-back.
const GLYPHS: string[] = [];
const GLYPH_IDS = new Map<string, number>();
for (let i = 0; i < 128; i++) {
  GLYPHS.push(String.fromCharCode(i));
  GLYPH_IDS.set(GLYPHS[i]!, i);
}
GLYPHS[TRAIL] = "";

export function internGlyph(cluster: string): number {
  const known = GLYPH_IDS.get(cluster);
  if (known !== undefined) return known;
  const id = GLYPHS.length;
  GLYPHS.push(cluster);
  GLYPH_IDS.set(cluster, id);
  return id;
}

export function glyphText(id: number): string {
  return GLYPHS[id] ?? " ";
}

export class Screen {
  readonly glyph: Uint32Array;
  readonly fg: Int32Array;
  readonly bg: Int32Array;
  readonly attr: Uint8Array;
  readonly width: Uint8Array;
  /**
   * The sixth plane: 0 for a plain cell, else a 1-based index into this
   * frame's URI table. A URL is a property of a *run of cells*, exactly like
   * a colour, so it belongs beside the other planes rather than in a side
   * table the diff renderer would have to reconcile — `differs()` gains one
   * integer compare and OSC 8 falls out of the emit loop that already does
   * SGR deltas.
   */
  readonly link: Uint16Array;

  /** This frame's URIs. Index 0 is unused, so `link[i] === 0` means "none". */
  private uris: string[] = [];
  private uriIds = new Map<string, number>();
  /** The link every subsequent `set()` joins, until it is cleared again. */
  private pendingLink = 0;

  constructor(
    readonly cols: number,
    readonly rows: number,
  ) {
    const n = cols * rows;
    this.glyph = new Uint32Array(n).fill(BLANK);
    this.fg = new Int32Array(n).fill(DEFAULT);
    this.bg = new Int32Array(n).fill(DEFAULT);
    this.attr = new Uint8Array(n);
    this.width = new Uint8Array(n).fill(1);
    this.link = new Uint16Array(n);
  }

  /**
   * Intern a URI for this frame and return its plane value. VTE and iTerm2
   * both cap a hyperlink URI at 2083 bytes, so anything longer is refused
   * here rather than emitted and silently dropped by the terminal.
   */
  linkId(uri: string): number {
    if (uri === "" || uri.length > 2083) return 0;
    const known = this.uriIds.get(uri);
    if (known !== undefined) return known;
    // 65534 distinct links in one frame is not a screen, it is a bug; past
    // the cap the cells render unlinked rather than aliasing to a wrong URL.
    if (this.uris.length >= 0xfffe) return 0;
    const id = this.uris.length + 1;
    this.uris.push(uri);
    this.uriIds.set(uri, id);
    return id;
  }

  /** The URI behind a plane value; "" for an unlinked cell. */
  uriOf(id: number): string {
    return id <= 0 ? "" : (this.uris[id - 1] ?? "");
  }

  /** The URI under one cell — what a test asks and what `y` copies. */
  linkAt(x: number, y: number): string {
    if (!this.inside(x, y)) return "";
    return this.uriOf(this.link[this.idx(x, y)]!);
  }

  /** Take another frame's URI table, so a remembered frame can be diffed. */
  adoptLinks(other: Screen): void {
    this.uris = [...other.uris];
    this.uriIds = new Map(other.uriIds);
  }

  rect(): Rect {
    return { x: 0, y: 0, w: this.cols, h: this.rows };
  }

  idx(x: number, y: number): number {
    return y * this.cols + x;
  }

  inside(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.cols && y < this.rows;
  }

  /** Paint every cell blank in `s` — the whole-screen theme background. */
  clear(s: Style = PLAIN): void {
    this.glyph.fill(BLANK);
    this.fg.fill(s.fg);
    this.bg.fill(s.bg);
    this.attr.fill(s.attr);
    this.width.fill(1);
    this.link.fill(0);
    this.uris = [];
    this.uriIds = new Map();
    this.pendingLink = 0;
  }

  styleAt(x: number, y: number): Style {
    const i = this.idx(x, y);
    return { fg: this.fg[i]!, bg: this.bg[i]!, attr: this.attr[i]! };
  }

  textAt(x: number, y: number): string {
    return glyphText(this.glyph[this.idx(x, y)]!);
  }

  /**
   * Write one cluster. Returns the columns consumed (0 when out of bounds).
   * A width-2 glyph with a single column left is replaced by a space rather
   * than split — the one place where dropping content beats corrupting a row.
   */
  set(x: number, y: number, cluster: string, s: Style, right?: number): number {
    if (!this.inside(x, y)) return 0;
    const limit = right ?? this.cols;
    let w = clusterWidth(cluster);
    if (w === 0) return 0;
    if (w === 2 && x + 1 >= limit) {
      cluster = " ";
      w = 1;
    }
    if (x + w > limit) return 0;
    this.obliterate(x, y);
    if (w === 2) this.obliterate(x + 1, y);
    const i = this.idx(x, y);
    this.glyph[i] = internGlyph(cluster);
    this.fg[i] = s.fg;
    this.bg[i] = s.bg;
    this.attr[i] = s.attr;
    this.width[i] = w;
    this.link[i] = this.pendingLink;
    if (w === 2) {
      const j = i + 1;
      this.glyph[j] = TRAIL;
      this.fg[j] = s.fg;
      this.bg[j] = s.bg;
      this.attr[j] = s.attr;
      this.width[j] = 0;
      this.link[j] = this.pendingLink;
    }
    return w;
  }

  /** Blank both halves of any wide glyph covering column x. */
  private obliterate(x: number, y: number): void {
    const i = this.idx(x, y);
    if (this.width[i] === 2 && x + 1 < this.cols) {
      this.glyph[i + 1] = BLANK;
      this.width[i + 1] = 1;
      this.link[i + 1] = 0;
    } else if (this.glyph[i] === TRAIL && x > 0) {
      this.glyph[i - 1] = BLANK;
      this.width[i - 1] = 1;
      this.link[i - 1] = 0;
    }
  }

  /** Draw a string, clipped to `right` (exclusive). Returns the next column. */
  text(x: number, y: number, s: string, st: Style, right?: number): number {
    const limit = right ?? this.cols;
    let cx = x;
    for (const cluster of clusters(s)) {
      if (cx >= limit) break;
      const w = this.set(cx, y, cluster, st, limit);
      if (w === 0 && clusterWidth(cluster) > 0) break;
      cx += w;
    }
    return cx;
  }

  /**
   * Draw a string whose cells carry `uri` — a clickable run. The renderer
   * closes the hyperlink at the end of every row and before every cursor
   * jump, so a caller cannot leak a link across a line by forgetting to.
   */
  linkText(
    x: number,
    y: number,
    text: string,
    st: Style,
    uri: string,
    right?: number,
  ): number {
    const previous = this.pendingLink;
    this.pendingLink = this.linkId(uri);
    const out = this.text(x, y, text, st, right);
    this.pendingLink = previous;
    return out;
  }

  /** Draw styled runs left to right within a clip. Returns the next column. */
  spans(x: number, y: number, list: readonly Span[], right?: number): number {
    let cx = x;
    for (const span of list)
      cx =
        span.link === undefined || span.link === ""
          ? this.text(cx, y, span.text, span.style, right)
          : this.linkText(cx, y, span.text, span.style, span.link, right);
    return cx;
  }

  /** Draw `s` padded/aligned inside a single row of `r`. */
  line(r: Rect, dy: number, s: string, st: Style, align: Align = "left"): void {
    if (dy < 0 || dy >= r.h) return;
    const w = displayWidth(s);
    const off =
      align === "right"
        ? Math.max(0, r.w - w)
        : align === "center"
          ? Math.max(0, (r.w - w) >> 1)
          : 0;
    this.text(r.x + off, r.y + dy, s, st, r.x + r.w);
  }

  fill(r: Rect, cluster: string, s: Style): void {
    for (let y = r.y; y < r.y + r.h; y++)
      for (let x = r.x; x < r.x + r.w; x++)
        this.set(x, y, cluster, s, r.x + r.w);
  }

  /** Every cell in `r` gets `s`'s colours, keeping whatever glyph is there. */
  tint(r: Rect, s: Style): void {
    for (let y = r.y; y < r.y + r.h; y++) {
      if (y < 0 || y >= this.rows) continue;
      for (let x = r.x; x < r.x + r.w; x++) {
        if (x < 0 || x >= this.cols) continue;
        const i = this.idx(x, y);
        this.fg[i] = s.fg;
        this.bg[i] = s.bg;
        this.attr[i] = s.attr;
      }
    }
  }

  /** Plain text, styles stripped — the readable form for tests. */
  toText(): string {
    const out: string[] = [];
    for (let y = 0; y < this.rows; y++) {
      let line = "";
      for (let x = 0; x < this.cols; x++) {
        const i = this.idx(x, y);
        if (this.glyph[i] === TRAIL) continue;
        line += glyphText(this.glyph[i]!);
      }
      out.push(line.replace(/ +$/, ""));
    }
    return out.join("\n");
  }

  /** The same grid with SGR sequences, for eyeballing a frame in a test. */
  toStyledText(depth: ColorDepth = "truecolor"): string {
    const out: string[] = [];
    for (let y = 0; y < this.rows; y++) {
      let line = "";
      let cur = PLAIN;
      for (let x = 0; x < this.cols; x++) {
        const i = this.idx(x, y);
        if (this.glyph[i] === TRAIL) continue;
        const st = this.styleAt(x, y);
        if (!sameStyle(cur, st)) {
          line += sgrDelta(cur, st, depth);
          cur = st;
        }
        line += glyphText(this.glyph[i]!);
      }
      out.push(line + "\x1b[0m");
    }
    return out.join("\n");
  }
}

// The safe glyph set: all BMP, all width 1, present in every default terminal
// font in wide use. No Nerd Font glyphs (we cannot assume a patched font over
// SSH) and no emoji in chrome (their width is genuinely inconsistent, and a
// one-column error shifts an entire row).
export const G = {
  v: "│",
  h: "─",
  tl: "╭",
  tr: "╮",
  bl: "╰",
  br: "╯",
  lt: "├",
  rt: "┤",
  vHeavy: "┃",
  hHeavy: "━",
  dot: "●",
  ring: "○",
  // The three at-a-glance marks a list row wears. `○` is an open
  // conversation, `↳` is a branch proposed into another (the ASCII-art shape
  // every terminal already draws a branch with), `▭` is a comment. All three
  // are BMP, width 1, and in every default terminal font — no Nerd Font, and
  // no emoji, whose width is genuinely inconsistent.
  pull: "↳",
  comment: "▭",
  diamond: "◆",
  caretRight: "▸",
  caretDown: "▾",
  check: "✓",
  cross: "✗",
  ellipsis: "…",
  // The pilcrow marks prose being *read* rather than edited — a rendered
  // markdown tab. U+00B6 is Latin-1, so it is in every font that can draw a
  // box-drawing character at all, and it is width 1 everywhere.
  para: "¶",
  chevron: "›",
  bar: "▏",
  block: "█",
  shade: "░",
  up: "▲",
  down: "▼",
  enter: "⏎",
} as const;

export interface BoxOpts {
  readonly style: Style;
  /** Fill the interior (and border row) with this before drawing. */
  readonly fill?: Style;
  readonly title?: string;
  readonly titleStyle?: Style;
  readonly footer?: string;
  readonly footerStyle?: Style;
}

/**
 * Hairline rounded border. Returns the inner Rect — that is the whole box
 * model: padding and borders live in the widget, never in the layout solver
 * (ratatui's `Block::inner()`), so nesting composes without arithmetic.
 */
export function box(screen: Screen, r: Rect, o: BoxOpts): Rect {
  if (r.w < 2 || r.h < 2) return { x: r.x, y: r.y, w: 0, h: 0 };
  if (o.fill) screen.fill(r, " ", o.fill);
  const right = r.x + r.w;
  const bottom = r.y + r.h - 1;
  for (let x = r.x + 1; x < right - 1; x++) {
    screen.set(x, r.y, G.h, o.style, right);
    screen.set(x, bottom, G.h, o.style, right);
  }
  for (let y = r.y + 1; y < bottom; y++) {
    screen.set(r.x, y, G.v, o.style, right);
    screen.set(right - 1, y, G.v, o.style, right);
  }
  screen.set(r.x, r.y, G.tl, o.style, right);
  screen.set(right - 1, r.y, G.tr, o.style, right);
  screen.set(r.x, bottom, G.bl, o.style, right);
  screen.set(right - 1, bottom, G.br, o.style, right);

  if (o.title !== undefined && r.w > 6) {
    const label = ` ${o.title} `;
    screen.text(r.x + 2, r.y, label, o.titleStyle ?? o.style, right - 2);
  }
  if (o.footer !== undefined && r.w > 6) {
    const label = ` ${o.footer} `;
    const w = displayWidth(label);
    screen.text(
      Math.max(r.x + 2, right - 2 - w),
      bottom,
      label,
      o.footerStyle ?? o.style,
      right - 2,
    );
  }
  return { x: r.x + 1, y: r.y + 1, w: r.w - 2, h: r.h - 2 };
}
