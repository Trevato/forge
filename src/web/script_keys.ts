/**
 * The keys the page scripts bind themselves, with no `data-shortcut` on the
 * element (those declare their own). One list: the feed script reads its key
 * here (the shell's `C` is a literal in client.ts, which test/help-keys.test.ts
 * parses; test/web-ui.test.ts pins it to this list). The pages draw
 * `keyHint(key)` beside the action, and the test walks the list and fails on a page whose action shows no hint.
 */

export interface ScriptKey {
  key: string;
  /** What it does, as the help overlay and the test name it. */
  action: string;
  /** A page that carries the action, with `{repo}` standing for an `owner/name` the viewer can reach. */
  page: string;
  /** The text of the element that must show the key beside it. */
  label: string;
}

/** Dismiss the focused feed card. */
export const DISMISS_KEY = "x";
/**
 * New issue from the page, on any page. `c` does it too where the page has no
 * box of its own (there it focuses the box), so the hint names the one key that
 * always works.
 */
export const NEW_ISSUE_KEY = "C";

export const SCRIPT_KEYS: readonly ScriptKey[] = [
  { key: DISMISS_KEY, action: "Dismiss a feed card", page: "/feed", label: "Dismiss" },
  { key: NEW_ISSUE_KEY, action: "New issue from this page", page: "/apps", label: "New issue" },
];
