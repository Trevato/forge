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

/**
 * The inverse of `chord`: the event a spelling stands for.
 *
 * This is what makes a help hint clickable — the bar already knows the chord,
 * so pressing the hint is pressing the key, with no second table mapping
 * labels to actions that could fall out of step with the bindings. Returns
 * undefined for a spelling no single keypress produces ("wheel", "click"),
 * which is exactly the set that must not be clickable.
 */
export function keyFor(spelling: string): KeyEvent | undefined {
  let rest = spelling;
  let ctrl = false;
  let alt = false;
  let shift = false;
  for (;;) {
    if (rest.startsWith("ctrl+")) {
      ctrl = true;
      rest = rest.slice(5);
    } else if (rest.startsWith("alt+")) {
      alt = true;
      rest = rest.slice(4);
    } else if (rest.startsWith("shift+")) {
      shift = true;
      rest = rest.slice(6);
    } else break;
  }
  if (rest === "") return undefined;
  // A named key, or exactly one character. Anything else is a label.
  if ([...rest].length > 1 && !/^[a-z0-9]+$/.test(rest)) return undefined;
  return { type: "key", key: rest, ctrl, alt, shift };
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
