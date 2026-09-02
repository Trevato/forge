/**
 * The component vocabulary — the same names, variants and meanings as the web
 * design system's class table. A "danger" button, a "merged" badge and an
 * intra-line change must mean the same thing in both surfaces; that is the
 * product requirement, and the way to keep it true is to have one list of
 * components with one list of variants, drawn from one palette.
 *
 * Two shapes here. Block widgets take a `Rect` and paint inside it. Inline
 * widgets (badge, pill, dot, kbd, avatar, chip) take an `x, y` and return the
 * next free column, so a row of them composes by threading `x`.
 *
 * Chrome uses only the safe glyph set in `screen.ts` — no emoji (their width
 * is inconsistent across Apple Terminal, tmux and older clients, and a
 * one-column error shifts an entire row) and no Nerd Font glyphs.
 */

import { box, G, Screen, type Rect, type Span } from "../term/screen.ts";
import {
  BOLD,
  DIM,
  ITALIC,
  REVERSE,
  STRIKE,
  UNDERLINE,
  luminance,
  mix,
  rgb,
  style,
  type Color,
  type Style,
} from "../term/style.ts";
import { displayWidth, pad, truncate, type Align } from "../term/width.ts";
import { split, len, fill, center, type Constraint } from "./layout.ts";
import type { Tokens } from "./theme.ts";
import { visible, type Binding } from "../app/keys.ts";

export type Tone =
  | "default"
  | "secondary"
  | "outline"
  | "success"
  | "danger"
  | "merged"
  | "attn";

export type ButtonVariant =
  | "default"
  | "secondary"
  | "outline"
  | "ghost"
  | "danger"
  | "link";

export type RowState = "open" | "closed" | "merged" | "draft";

/** Black or white over an arbitrary colour, whichever reads. */
export function readableOn(bg: Color): Color {
  return luminance(bg) > 0.55 ? 0x18181b : 0xfafafa;
}

function toneColor(c: Tokens, tone: Tone): Color {
  switch (tone) {
    case "success":
      return c.success;
    case "danger":
      return c.danger;
    case "merged":
      return c.merged;
    case "attn":
      return c.attn;
    case "secondary":
      return c.mutedFg;
    case "outline":
      return c.border;
    default:
      return c.accent;
  }
}

// ---- inline widgets ----

/** `badge` / `.badge` — a compact status chip. Returns the next column. */
export function badge(
  s: Screen,
  x: number,
  y: number,
  c: Tokens,
  o: { text: string; variant?: Tone },
  right?: number,
): number {
  const variant = o.variant ?? "default";
  const label = ` ${o.text} `;
  if (variant === "outline")
    return s.text(x, y, label, style(c.mutedFg, c.bg), right);
  const bg = variant === "default" ? c.muted : toneColor(c, variant);
  const fg = variant === "default" ? c.fg : readableOn(bg);
  return s.text(x, y, label, style(fg, bg), right);
}

/**
 * `labelChip` / `.label` — an issue label with an author-chosen hex colour.
 * The foreground is derived, never stored, so any colour stays readable.
 */
export function labelChip(
  s: Screen,
  x: number,
  y: number,
  _c: Tokens,
  o: { text: string; color: string },
  right?: number,
): number {
  const bg = rgb(o.color);
  return s.text(x, y, ` ${o.text} `, style(readableOn(bg), bg), right);
}

/** `avatar` — two initials on a hue derived from the name, so it is stable. */
export function avatar(
  s: Screen,
  x: number,
  y: number,
  _c: Tokens,
  o: { name: string },
  right?: number,
): number {
  const bg = hueFor(o.name);
  return s.text(x, y, initials(o.name), style(readableOn(bg), bg), right);
}

export function initials(name: string): string {
  const parts = name.split(/[\s._/-]+/).filter((p) => p.length > 0);
  const a = parts[0]?.[0] ?? "?";
  const b = parts[1]?.[0] ?? parts[0]?.[1] ?? "";
  return (a + b).toUpperCase().slice(0, 2).padEnd(2, " ");
}

function hueFor(name: string): Color {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return hsl((h >>> 0) % 360, 0.42, 0.5);
}

function hsl(h: number, s: number, l: number): Color {
  const k = (n: number): number => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number): number =>
    Math.round(
      255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))),
    );
  return (f(0) << 16) | (f(8) << 8) | f(4);
}

/** `pill` — a count or stat. Tabular by construction: everything is a cell. */
export function pill(
  s: Screen,
  x: number,
  y: number,
  c: Tokens,
  o: { text: string; tone?: Tone },
  right?: number,
): number {
  const fg = o.tone === undefined ? c.mutedFg : toneColor(c, o.tone);
  return s.text(x, y, ` ${o.text} `, style(fg, c.muted), right);
}

/** `dot` — a one-cell status indicator. */
export function dot(
  s: Screen,
  x: number,
  y: number,
  c: Tokens,
  o: { tone?: Tone; hollow?: boolean; bg?: Color },
  right?: number,
): number {
  const fg = o.tone === undefined ? c.faint : toneColor(c, o.tone);
  return s.text(
    x,
    y,
    o.hollow === true ? G.ring : G.dot,
    style(fg, o.bg ?? c.bg),
    right,
  );
}

/** `kbd` — a key cap. */
export function kbd(
  s: Screen,
  x: number,
  y: number,
  c: Tokens,
  o: { key: string },
  right?: number,
): number {
  return s.text(x, y, ` ${o.key} `, style(c.fg, c.muted), right);
}

// A one-cell bar that fills and empties: block elements, present in every
// default terminal font, unlike the braille frames most spinners use.
const SPINNER = [
  ..."\u258F\u258E\u258D\u258C\u258B\u258A\u2589\u2588\u2589\u258A\u258B\u258C\u258D\u258E",
];

/** `spinner` — one cell, driven by a caller-owned tick. */
export function spinner(
  s: Screen,
  x: number,
  y: number,
  c: Tokens,
  tick: number,
): number {
  const frame =
    SPINNER[((tick % SPINNER.length) + SPINNER.length) % SPINNER.length]!;
  return s.text(x, y, frame, style(c.accent, c.bg));
}

// ---- block widgets ----

/** `button` / `.btn[data-variant]`. Height 1, centred in `r`. */
export function button(
  s: Screen,
  r: Rect,
  c: Tokens,
  o: {
    label: string;
    variant?: ButtonVariant;
    focused?: boolean;
    disabled?: boolean;
  },
): void {
  if (r.w <= 0 || r.h <= 0) return;
  const v = o.variant ?? "default";
  const focused = o.focused === true;
  let fg = c.fg;
  let bg = c.bg;
  let attr = 0;
  switch (v) {
    case "default":
      fg = c.primaryFg;
      bg = c.primary;
      break;
    case "secondary":
      fg = c.fg;
      bg = c.muted;
      break;
    case "outline":
      fg = c.fg;
      bg = c.bg;
      break;
    case "ghost":
      fg = c.mutedFg;
      bg = c.bg;
      break;
    case "danger":
      bg = c.danger;
      fg = readableOn(c.danger);
      break;
    case "link":
      fg = c.accent;
      bg = c.bg;
      attr = UNDERLINE;
      break;
  }
  if (o.disabled === true) {
    fg = c.faint;
    attr |= DIM;
  }
  const y = r.y + (r.h >> 1);
  const inner = v === "outline" ? `[ ${o.label} ]` : ` ${o.label} `;
  const st = style(fg, bg, attr);
  s.fill({ x: r.x, y, w: r.w, h: 1 }, " ", st);
  const text = truncate(inner, r.w);
  const off = Math.max(0, (r.w - displayWidth(text)) >> 1);
  s.text(r.x + off, y, text, st, r.x + r.w);
  // Accent is reserved for focus and interaction; a caret plus an underline
  // reads as focus at any colour depth, including 16.
  if (focused) {
    s.tint({ x: r.x, y, w: r.w, h: 1 }, style(fg, bg, attr | UNDERLINE));
    if (r.w > 2) s.set(r.x, y, G.caretRight, style(c.accent, bg), r.x + r.w);
  }
}

export interface InputOpts {
  readonly value: string;
  readonly placeholder?: string;
  /** Caret offset in clusters; omit for an unfocused field. */
  readonly cursor?: number;
  readonly invalid?: boolean;
  readonly focused?: boolean;
}

export interface CursorPos {
  readonly x: number;
  readonly y: number;
}

/**
 * `input` / `.input`. Returns where the real terminal cursor belongs, so the
 * app can show a live caret — a visible cursor in an editor is worth a lot.
 * Horizontal scroll is grown from the caret in the direction of travel.
 */
export function input(
  s: Screen,
  r: Rect,
  c: Tokens,
  o: InputOpts,
): CursorPos | null {
  if (r.w < 3 || r.h <= 0) return null;
  const y = r.y + (r.h >> 1);
  const edge =
    o.invalid === true ? c.danger : o.focused === true ? c.accent : c.border;
  const st = style(c.fg, c.card);
  s.fill({ x: r.x, y, w: r.w, h: 1 }, " ", st);
  s.set(r.x, y, G.bar, style(edge, c.card), r.x + r.w);

  const field = { x: r.x + 2, w: r.w - 3 };
  const chars = [...o.value];
  if (chars.length === 0 && o.placeholder !== undefined) {
    s.text(
      field.x,
      y,
      truncate(o.placeholder, field.w),
      style(c.faint, c.card),
    );
  }
  const caret = Math.max(0, Math.min(o.cursor ?? chars.length, chars.length));
  let start = 0;
  if (caret > field.w - 1) start = caret - (field.w - 1);
  const shown = chars.slice(start, start + field.w).join("");
  if (shown !== "") s.text(field.x, y, shown, st, field.x + field.w);
  if (o.cursor === undefined) return null;
  return { x: field.x + (caret - start), y };
}

/** `field` / `.field` — label, input, then hint or error. */
export function field(
  s: Screen,
  r: Rect,
  c: Tokens,
  o: InputOpts & { label: string; hint?: string; error?: string },
): CursorPos | null {
  if (r.h < 1) return null;
  s.text(r.x, r.y, truncate(o.label, r.w), style(c.mutedFg, c.bg), r.x + r.w);
  if (r.h < 2) return null;
  const cursor = input(s, { x: r.x, y: r.y + 1, w: r.w, h: 1 }, c, o);
  if (r.h >= 3) {
    const note = o.error ?? o.hint;
    if (note !== undefined)
      s.text(
        r.x,
        r.y + 2,
        truncate(note, r.w),
        style(o.error !== undefined ? c.danger : c.faint, c.bg),
        r.x + r.w,
      );
  }
  return cursor;
}

export interface CardOpts {
  readonly title?: string;
  readonly footer?: string;
  readonly tone?: "default" | "success" | "danger" | "merged" | "attn";
  readonly focused?: boolean;
}

/** `card` / `.card` — a rounded hairline box. Returns the padded interior. */
export function card(s: Screen, r: Rect, c: Tokens, o: CardOpts = {}): Rect {
  const edge =
    o.focused === true
      ? c.accent
      : o.tone === undefined || o.tone === "default"
        ? c.border
        : toneColor(c, o.tone);
  const inner = box(s, r, {
    style: style(edge, c.card),
    fill: style(c.fg, c.card),
    ...(o.title === undefined ? {} : { title: o.title }),
    titleStyle: style(c.fg, c.card, BOLD),
    ...(o.footer === undefined ? {} : { footer: o.footer }),
    footerStyle: style(c.mutedFg, c.card),
  });
  // One cell of horizontal padding, always. Consistency here is most of what
  // makes a terminal UI look designed rather than assembled.
  return {
    x: inner.x + 1,
    y: inner.y,
    w: Math.max(0, inner.w - 2),
    h: inner.h,
  };
}

export interface RowOpts {
  readonly title: string;
  readonly state?: RowState;
  readonly secondary?: string;
  readonly meta?: string;
  readonly selected?: boolean;
  readonly focused?: boolean;
}

const ROW_TONE: Record<RowState, Tone> = {
  open: "success",
  closed: "danger",
  merged: "merged",
  draft: "secondary",
};

/** `row` / `.row` — the list row: dot, title, secondary text, right meta. */
export function row(s: Screen, r: Rect, c: Tokens, o: RowOpts): void {
  if (r.w <= 0 || r.h <= 0) return;
  const selected = o.selected === true;
  const bg = selected ? c.muted : c.bg;
  const line = { x: r.x, y: r.y, w: r.w, h: 1 };
  s.fill(line, " ", style(c.fg, bg));
  const right = r.x + r.w;

  let x = r.x;
  // The selection marker is a shape, not just a colour — it survives a
  // 16-colour client and a colour-blind reader alike.
  x = s.text(
    x,
    r.y,
    selected ? `${G.caretRight} ` : "  ",
    style(c.accent, bg),
    right,
  );
  if (o.state !== undefined)
    x = dot(s, x, r.y, c, { tone: ROW_TONE[o.state], bg }, right) + 1;

  const meta = o.meta ?? "";
  const metaW = meta === "" ? 0 : displayWidth(meta) + 1;
  const titleRight = Math.max(x, right - metaW);
  const titleStyle = style(
    o.state === "closed" ? c.mutedFg : c.fg,
    bg,
    selected || o.focused === true ? BOLD : 0,
  );
  x = s.text(
    x,
    r.y,
    truncate(o.title, Math.max(0, titleRight - x)),
    titleStyle,
    titleRight,
  );
  if (o.secondary !== undefined && x + 2 < titleRight)
    s.text(
      x + 1,
      r.y,
      truncate(o.secondary, titleRight - x - 1),
      style(c.faint, bg),
      titleRight,
    );
  if (meta !== "")
    s.text(right - metaW + 1, r.y, meta, style(c.mutedFg, bg), right);
}

export interface Column {
  readonly header: string;
  /** A layout constraint, so tables and panes use one solver. */
  readonly width: Constraint;
  readonly align?: Align;
  /** Right-aligned digits read as a column; use for counts and sizes. */
  readonly numeric?: boolean;
}

export interface TableOpts {
  readonly columns: readonly Column[];
  readonly rows: readonly (readonly string[])[];
  readonly selected?: number;
  readonly offset?: number;
}

/** `table` / `.table` — header rule, no vertical rules (they read as noise). */
export function table(s: Screen, r: Rect, c: Tokens, o: TableOpts): void {
  if (r.w <= 0 || r.h <= 1) return;
  const cols = split(
    { x: r.x, y: r.y, w: r.w, h: 1 },
    "h",
    o.columns.map((col) => col.width),
  );
  const right = r.x + r.w;
  s.fill({ x: r.x, y: r.y, w: r.w, h: 1 }, " ", style(c.mutedFg, c.bg));
  // One column of gutter between cells: without it a right-aligned number
  // and the next header run together and the table reads as one word.
  const inner = (i: number): number => {
    const cell = cols[i]!;
    return Math.max(0, cell.w - (i === o.columns.length - 1 ? 0 : 1));
  };
  o.columns.forEach((col, i) => {
    const cell = cols[i];
    if (!cell) return;
    const align: Align = col.align ?? (col.numeric === true ? "right" : "left");
    const w = inner(i);
    s.text(
      cell.x,
      r.y,
      pad(truncate(col.header, w), w, align),
      style(c.mutedFg, c.bg),
      right,
    );
  });
  for (let x = r.x; x < right; x++)
    s.set(x, r.y + 1, G.h, style(c.border, c.bg), right);

  // A bounded window: at most the visible rows are ever touched, so cost is
  // independent of how many rows exist.
  const body = r.h - 2;
  const offset = Math.max(0, o.offset ?? 0);
  for (let i = 0; i < body; i++) {
    const data = o.rows[offset + i];
    if (!data) break;
    const y = r.y + 2 + i;
    const sel = o.selected === offset + i;
    const bg = sel ? c.muted : c.bg;
    s.fill({ x: r.x, y, w: r.w, h: 1 }, " ", style(c.fg, bg));
    o.columns.forEach((col, ci) => {
      const cell = cols[ci];
      if (!cell) return;
      const align: Align =
        col.align ?? (col.numeric === true ? "right" : "left");
      const w = inner(ci);
      const text = pad(truncate(data[ci] ?? "", w), w, align);
      s.text(cell.x, y, text, style(c.fg, bg, sel ? BOLD : 0), right);
    });
  }
}

export interface TabItem {
  readonly label: string;
  readonly count?: number;
}

/** `tabs` — active tab underlined, counts as muted pills. Needs 2 rows. */
export function tabs(
  s: Screen,
  r: Rect,
  c: Tokens,
  o: { items: readonly TabItem[]; active: number },
): void {
  if (r.w <= 0 || r.h <= 0) return;
  const right = r.x + r.w;
  s.fill(
    { x: r.x, y: r.y, w: r.w, h: Math.min(2, r.h) },
    " ",
    style(c.fg, c.bg),
  );
  let x = r.x;
  o.items.forEach((item, i) => {
    if (x >= right) return;
    const active = i === o.active;
    const st = style(active ? c.fg : c.mutedFg, c.bg, active ? BOLD : 0);
    const start = x;
    x = s.text(x, r.y, ` ${item.label} `, st, right);
    if (item.count !== undefined)
      x = pill(s, x, r.y, c, { text: String(item.count) }, right);
    x += 1;
    if (active && r.h > 1)
      for (let ux = start; ux < Math.min(x - 1, right); ux++)
        s.set(ux, r.y + 1, G.hHeavy, style(c.accent, c.bg), right);
  });
  if (r.h > 1)
    for (let ux = r.x; ux < right; ux++)
      if (s.textAt(ux, r.y + 1) === " ")
        s.set(ux, r.y + 1, G.h, style(c.border, c.bg), right);
}

/** `segmented` / `.seg` — a one-row exclusive choice. */
export function segmented(
  s: Screen,
  r: Rect,
  c: Tokens,
  o: { items: readonly string[]; active: number },
): void {
  if (r.w <= 0 || r.h <= 0) return;
  const right = r.x + r.w;
  s.fill({ x: r.x, y: r.y, w: r.w, h: 1 }, " ", style(c.mutedFg, c.muted));
  let x = r.x;
  o.items.forEach((label, i) => {
    const active = i === o.active;
    const st = active
      ? style(c.primaryFg, c.primary, BOLD)
      : style(c.mutedFg, c.muted);
    x = s.text(x, r.y, ` ${label} `, st, right);
  });
}

/** `menu` / `.menu` — a popup list. Draws its own frame over what is beneath. */
export function menu(
  s: Screen,
  r: Rect,
  c: Tokens,
  o: { items: readonly string[]; selected: number; title?: string },
): void {
  const inner = card(s, r, c, o.title === undefined ? {} : { title: o.title });
  for (let i = 0; i < inner.h; i++) {
    const label = o.items[i];
    if (label === undefined) break;
    const sel = i === o.selected;
    const st = style(
      sel ? c.fg : c.mutedFg,
      sel ? c.muted : c.card,
      sel ? BOLD : 0,
    );
    s.fill({ x: inner.x, y: inner.y + i, w: inner.w, h: 1 }, " ", st);
    s.text(
      inner.x,
      inner.y + i,
      `${sel ? G.caretRight : " "} ${truncate(label, Math.max(0, inner.w - 2))}`,
      st,
      inner.x + inner.w,
    );
  }
}

/**
 * `dialog` — a modal over a dimmed backdrop. Modality is structural: the app
 * draws the parent first, then this paints over it, and the dialog screen's
 * `key()` returns true for everything.
 */
export function dialog(
  s: Screen,
  area: Rect,
  c: Tokens,
  o: {
    title: string;
    body: readonly string[];
    actions: readonly { label: string; variant?: ButtonVariant }[];
    selected?: number;
    width?: number;
  },
): void {
  // Dim rather than blank: the user keeps their place in the page behind.
  for (let y = area.y; y < area.y + area.h; y++)
    for (let x = area.x; x < area.x + area.w; x++) {
      const st = s.styleAt(x, y);
      s.tint(
        { x, y, w: 1, h: 1 },
        style(mix(st.fg, c.bg, 0.62), mix(st.bg, c.bg, 0.62), st.attr & ~BOLD),
      );
    }
  const w = Math.min(o.width ?? 54, area.w - 4);
  const h = Math.min(o.body.length + 6, area.h - 2);
  const r = center(area, w, h);
  const inner = card(s, r, c, { title: o.title, focused: true });
  o.body.forEach((line, i) => {
    if (i >= inner.h - 2) return;
    s.text(
      inner.x,
      inner.y + i,
      truncate(line, inner.w),
      style(c.fg, c.card),
      inner.x + inner.w,
    );
  });
  const barY = inner.y + inner.h - 1;
  const widths = o.actions.map((a) => len(displayWidth(a.label) + 4));
  const slots = split({ x: inner.x, y: barY, w: inner.w, h: 1 }, "h", [
    fill(1),
    ...widths,
  ]);
  o.actions.forEach((a, i) => {
    const slot = slots[i + 1];
    if (!slot) return;
    button(s, slot, c, {
      label: a.label,
      ...(a.variant === undefined ? {} : { variant: a.variant }),
      focused: (o.selected ?? 0) === i,
    });
  });
}

/** `toast` / `.toast` — a transient severity-coloured line in the status bar. */
export function toast(
  s: Screen,
  r: Rect,
  c: Tokens,
  o: { text: string; tone?: Tone },
): void {
  if (r.w <= 0 || r.h <= 0) return;
  const fg = o.tone === undefined ? c.fg : toneColor(c, o.tone);
  const st = style(readableOn(fg), fg, BOLD);
  s.fill({ x: r.x, y: r.y, w: r.w, h: 1 }, " ", st);
  s.text(r.x + 1, r.y, truncate(o.text, r.w - 2), st, r.x + r.w);
}

/** `crumbs` / `.crumbs` — the breadcrumb row, truncated from the left. */
export function crumbs(
  s: Screen,
  r: Rect,
  c: Tokens,
  parts: readonly string[],
): void {
  if (r.w <= 0 || r.h <= 0) return;
  const right = r.x + r.w;
  s.fill({ x: r.x, y: r.y, w: r.w, h: 1 }, " ", style(c.mutedFg, c.bg));
  // Drop leading crumbs before truncating text: a user reads a breadcrumb to
  // know where they are *now*, so the tail is what must survive.
  let shown = [...parts];
  const measure = (list: string[]): number =>
    displayWidth(list.join(` ${G.chevron} `));
  while (shown.length > 1 && measure(shown) > r.w) shown = shown.slice(1);
  if (shown.length < parts.length) shown = [G.ellipsis, ...shown];
  let x = r.x;
  shown.forEach((part, i) => {
    const last = i === shown.length - 1;
    if (i > 0)
      x = s.text(x, r.y, ` ${G.chevron} `, style(c.faint, c.bg), right);
    x = s.text(
      x,
      r.y,
      truncate(part, right - x),
      style(last ? c.fg : c.mutedFg, c.bg, last ? BOLD : 0),
      right,
    );
  });
}

/** `helpBar` — derived entirely from the focused screen's bindings. */
export function helpBar(
  s: Screen,
  r: Rect,
  c: Tokens,
  bindings: readonly Binding[],
): void {
  if (r.w <= 0 || r.h <= 0) return;
  const right = r.x + r.w;
  s.fill({ x: r.x, y: r.y, w: r.w, h: 1 }, " ", style(c.mutedFg, c.muted));
  let x = r.x + 1;
  for (const b of visible(bindings)) {
    const keyText = ` ${b.keys[0] ?? "?"} `;
    const width = displayWidth(keyText) + displayWidth(b.help) + 2;
    // Truncate in priority order: bindings are listed most-useful first.
    if (x + width > right - 1) {
      s.text(right - 2, r.y, G.ellipsis, style(c.faint, c.muted), right);
      return;
    }
    const dimmed = b.disabled === true;
    x = s.text(
      x,
      r.y,
      keyText,
      style(dimmed ? c.faint : c.fg, c.borderStrong),
      right,
    );
    x = s.text(
      x,
      r.y,
      ` ${b.help}`,
      style(dimmed ? c.faint : c.mutedFg, c.muted),
      right,
    );
    x += 2;
  }
}

/** `timelineItem` / `.tl-item` — a comment or an event in an issue thread. */
export function timelineItem(
  s: Screen,
  r: Rect,
  c: Tokens,
  o: {
    kind: "comment" | "event";
    actor: string;
    when: string;
    body: readonly string[];
  },
): number {
  if (r.w <= 0 || r.h <= 0) return 0;
  const right = r.x + r.w;
  let x = r.x;
  x = avatar(s, x, r.y, c, { name: o.actor }, right) + 1;
  x = s.text(x, r.y, o.actor, style(c.fg, c.bg, BOLD), right);
  s.text(x + 1, r.y, o.when, style(c.faint, c.bg), right);
  const bodyStyle = style(
    o.kind === "event" ? c.mutedFg : c.fg,
    c.bg,
    o.kind === "event" ? ITALIC : 0,
  );
  let used = 1;
  for (const line of o.body) {
    if (used >= r.h) break;
    s.set(r.x + 1, r.y + used, G.v, style(c.border, c.bg), right);
    s.text(r.x + 3, r.y + used, truncate(line, r.w - 3), bodyStyle, right);
    used++;
  }
  return used;
}

/**
 * `emptyState` — a muted mark, one headline, one sentence, one action. Never
 * an illustration; never more than one call to action.
 */
export function emptyState(
  s: Screen,
  r: Rect,
  c: Tokens,
  o: { title: string; body?: string; action?: string },
): void {
  if (r.w <= 0 || r.h < 3) return;
  const w = Math.min(r.w, 44);
  const inner = center(r, w, Math.min(r.h, 6));
  s.line(inner, 0, G.ring, style(c.faint, c.bg), "center");
  s.line(inner, 2, truncate(o.title, w), style(c.fg, c.bg, BOLD), "center");
  if (o.body !== undefined && inner.h > 3)
    s.line(inner, 3, truncate(o.body, w), style(c.mutedFg, c.bg), "center");
  if (o.action !== undefined && inner.h > 5)
    button(
      s,
      center({ ...inner, y: inner.y + 5, h: 1 }, displayWidth(o.action) + 4, 1),
      c,
      { label: o.action },
    );
}

/**
 * `scrollbar` — one column. Drawn only when there is something to scroll, so
 * a short list never grows a decoration it does not need.
 */
export function scrollbar(
  s: Screen,
  r: Rect,
  c: Tokens,
  o: { total: number; offset: number },
): void {
  if (r.h <= 0 || r.w <= 0 || o.total <= r.h) return;
  const thumb = Math.max(1, Math.round((r.h * r.h) / o.total));
  const span = r.h - thumb;
  const maxOffset = Math.max(1, o.total - r.h);
  const top = Math.round((Math.min(o.offset, maxOffset) / maxOffset) * span);
  for (let i = 0; i < r.h; i++) {
    const on = i >= top && i < top + thumb;
    s.set(
      r.x,
      r.y + i,
      on ? G.block : G.shade,
      style(on ? c.borderStrong : c.border, c.bg),
    );
  }
}

/** Draw pre-styled spans (markdown, diffs) with the standard clip. */
export function spanLine(
  s: Screen,
  r: Rect,
  dy: number,
  spans: readonly Span[],
): void {
  if (dy < 0 || dy >= r.h) return;
  s.spans(r.x, r.y + dy, spans, r.x + r.w);
}

export { REVERSE, STRIKE, BOLD, DIM, ITALIC, UNDERLINE };
