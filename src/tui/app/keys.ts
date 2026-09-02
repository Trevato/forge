/**
 * Key bindings as data. One `Binding` drives input routing *and* the help
 * bar, and `matches()` returns false for a disabled binding — that single
 * rule gives context-sensitive input and context-sensitive help from one
 * mechanism, with zero effort at the call site. It is the best idea in
 * bubbles and it costs forty lines.
 */

import type { KeyEvent } from "../term/input.ts";

export interface Binding {
  /** Chords in the canonical spelling: "j", "ctrl+d", "shift+tab", "esc". */
  readonly keys: readonly string[];
  readonly help: string;
  /** Present but inert — still shown in help, greyed. */
  readonly disabled?: boolean;
  /** Never shown in the help bar (global plumbing). */
  readonly hidden?: boolean;
}

export function binding(
  keys: string | readonly string[],
  help: string,
  extra: { disabled?: boolean; hidden?: boolean } = {},
): Binding {
  const list = typeof keys === "string" ? [keys] : keys;
  return {
    keys: list,
    help,
    ...(extra.disabled === undefined ? {} : { disabled: extra.disabled }),
    ...(extra.hidden === undefined ? {} : { hidden: extra.hidden }),
  };
}

/** Canonical spelling of an event: "ctrl+alt+x", "shift+tab", "enter". */
export function chord(e: KeyEvent): string {
  let out = "";
  if (e.ctrl) out += "ctrl+";
  if (e.alt) out += "alt+";
  // Shift is implicit in the character for printable keys — only named keys
  // (tab, arrows, function keys) can carry it separately.
  if (e.shift && e.key.length > 1) out += "shift+";
  return out + e.key;
}

export function matches(b: Binding, e: KeyEvent): boolean {
  if (b.disabled === true) return false;
  return b.keys.includes(chord(e));
}

/** The first binding in `list` that `e` matches, or undefined. */
export function find(
  list: readonly Binding[],
  e: KeyEvent,
): Binding | undefined {
  for (const b of list) if (matches(b, e)) return b;
  return undefined;
}

export function visible(list: readonly Binding[]): Binding[] {
  return list.filter((b) => b.hidden !== true);
}
