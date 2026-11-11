/**
 * What a keydown means, as plain data in and an action out. The shell's one
 * handler (client.ts) ships this function's source and obeys its answer, so
 * the rule that keeps a key inert while someone types lives in one place
 * and is tested directly.
 *
 *  - `null`: the key is not ours (an open dialog owns its keys, a modifier
 *    is held, a field has focus).
 *  - `"chord"`: a Cmd/Ctrl chord with a row of its own; it answers even from a field.
 *  - `"blur"`: Escape in a field leaves the field.
 *  - `"key"`: a plain key; the shell looks it up in its table.
 */
export interface KeyFacts {
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  inField: boolean;
  inDialog: boolean;
  /** A chord row answers this key (read by the shell, ahead of the field guard). */
  hasChord: boolean;
  key: string;
}
export type KeyAction = "chord" | "blur" | "key" | null;

export function decideKey(f: KeyFacts): KeyAction {
  if (f.inDialog) return null;
  if (f.hasChord) return "chord";
  if (f.inField) return f.key === "Escape" ? "blur" : null;
  if (f.meta || f.ctrl || f.alt) return null;
  return "key";
}

/** The source the shell inlines. */
export const keyDecisionJs = decideKey.toString();
