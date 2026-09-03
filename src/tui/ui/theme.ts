/**
 * The web palette, in terminal terms. This file is a mapping table, not a
 * second palette — `src/design/themes.ts` stays the single source of truth so
 * the two surfaces cannot drift on what "danger", "merged" or an intra-line
 * change *mean*. That shared meaning is the product requirement; sharing code
 * is just how we get it.
 *
 * Unlike the web, the terminal paints the theme's `bg` across the whole
 * screen (terminal.shop's approach): a TUI that lets the user's own
 * background show through looks like six different half-themes.
 */

import { THEMES, type Palette, type ThemeName } from "../../design/themes.ts";
import type { TokenClass, TokenKind } from "../../web/highlight.ts";
import { rgb, type Color, type ColorDepth } from "../term/style.ts";

export type { ColorDepth };
export type { ThemeName };

export interface Tokens {
  readonly bg: Color;
  readonly fg: Color;
  readonly card: Color;
  readonly muted: Color;
  readonly mutedFg: Color;
  readonly faint: Color;
  readonly border: Color;
  readonly borderStrong: Color;
  readonly primary: Color;
  readonly primaryFg: Color;
  readonly accent: Color;
  readonly accentFg: Color;
  readonly danger: Color;
  readonly success: Color;
  readonly attn: Color;
  readonly merged: Color;
  readonly addBg: Color;
  readonly addFg: Color;
  readonly addEdge: Color;
  readonly delBg: Color;
  readonly delFg: Color;
  readonly delEdge: Color;
  readonly wdAdd: Color;
  readonly wdDel: Color;
  /** Syntax colours, keyed by the classes `web/highlight.ts` emits. */
  readonly tok: Readonly<Record<TokenClass, Color>>;
  /**
   * The refinements — `tok-property`, `tok-regex`, `tok-heading` and the
   * rest — read *generically* out of the palette rather than listed here.
   *
   * That is the whole trick: a kind added to `design/themes.ts` and
   * `web/highlight.ts` colours itself in the terminal the moment it lands,
   * with no third edit and no chance of the two surfaces disagreeing about
   * what `tok-regex` means. Partial because a kind is a refinement: dropping
   * it must never make a line wrong, only less specific, so anything the
   * palette does not name simply falls back to its class.
   */
  readonly tokKind: Readonly<Partial<Record<TokenKind, Color>>>;
}

/**
 * The colour for one token: its refinement when the palette names one, its
 * class otherwise. Every syntax-drawing call site goes through this, so the
 * precedence rule lives in exactly one place.
 */
export function tokColor(
  c: Tokens,
  token: { readonly cls: TokenClass; readonly kind?: TokenKind },
): Color {
  const refined = token.kind === undefined ? undefined : c.tokKind[token.kind];
  return refined ?? c.tok[token.cls];
}

export interface Theme {
  readonly name: ThemeName;
  readonly label: string;
  readonly appearance: "light" | "dark";
  readonly c: Tokens;
}

function tokens(p: Palette): Tokens {
  return {
    bg: rgb(p.bg),
    fg: rgb(p.fg),
    card: rgb(p.card),
    muted: rgb(p.muted),
    mutedFg: rgb(p["muted-fg"]),
    faint: rgb(p.faint),
    border: rgb(p.border),
    borderStrong: rgb(p["border-strong"]),
    primary: rgb(p.primary),
    primaryFg: rgb(p["primary-fg"]),
    accent: rgb(p.accent),
    accentFg: rgb(p["accent-fg"]),
    danger: rgb(p.danger),
    success: rgb(p.success),
    attn: rgb(p.attn),
    merged: rgb(p.merged),
    addBg: rgb(p["add-bg"]),
    addFg: rgb(p["add-fg"]),
    addEdge: rgb(p["add-edge"]),
    delBg: rgb(p["del-bg"]),
    delFg: rgb(p["del-fg"]),
    delEdge: rgb(p["del-edge"]),
    wdAdd: rgb(p["wd-add"]),
    wdDel: rgb(p["wd-del"]),
    tok: {
      keyword: rgb(p["tok-keyword"]),
      string: rgb(p["tok-string"]),
      comment: rgb(p["tok-comment"]),
      number: rgb(p["tok-number"]),
      function: rgb(p["tok-function"]),
      type: rgb(p["tok-type"]),
      constant: rgb(p["tok-constant"]),
      meta: rgb(p["tok-meta"]),
      operator: rgb(p["tok-operator"]),
      punctuation: rgb(p["tok-punctuation"]),
      // The one class with no palette entry: plain *is* body text.
      plain: rgb(p.fg),
    },
    tokKind: tokenKinds(p),
  };
}

/**
 * Every `tok-<name>` in the palette that is not one of the eleven classes
 * becomes a kind. Scanned, never listed: the list is `design/themes.ts`, and
 * a second copy of it here is a second thing to forget to update.
 */
function tokenKinds(p: Palette): Partial<Record<TokenKind, Color>> {
  const out: Record<string, Color> = {};
  for (const [key, value] of Object.entries(p))
    if (key.startsWith("tok-") && typeof value === "string")
      out[key.slice(4)] = rgb(value);
  return out as Partial<Record<TokenKind, Color>>;
}

const cache = new Map<ThemeName, Theme>();

export function theme(name: ThemeName): Theme {
  const hit = cache.get(name);
  if (hit) return hit;
  const t = THEMES[name];
  const made: Theme = {
    name,
    label: t.label,
    appearance: t.appearance,
    c: tokens(t.tokens),
  };
  cache.set(name, made);
  return made;
}

/**
 * Colour depth from `TERM` — the floor, not the whole story. `COLORTERM` does
 * not survive SSH (sshd forwards only `TERM`, via `pty-req`), so a heuristic
 * on it would silently degrade every session from a stock macOS client. The
 * real answer is a persisted per-user setting; this is what we assume until
 * there is one. Defaulting *up* to truecolor is right in 2026: a terminal
 * that approximates `38;2` looks fine, whereas assuming 256 everywhere makes
 * the design system look wrong for everyone.
 */
export function colorDepthFor(term: string | undefined): ColorDepth {
  if (process.env["NO_COLOR"]) return "256";
  if (term === undefined || term === "" || term === "dumb") return "256";
  if (
    /-direct|-truecolor|kitty|ghostty|alacritty|wezterm|contour|rio/.test(term)
  )
    return "truecolor";
  if (term.endsWith("256color")) return "256";
  if (term === "xterm" || term === "linux") return "256";
  return "truecolor";
}
