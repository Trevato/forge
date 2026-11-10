# Hotkey hints (#8930)

Every action with a key shows it without taking room. Hints are never a box in the layout.

**See them**
- **Hover or keyboard focus** on a control: its key appears as a small tooltip. This is CSS alone and works with JavaScript off.
- **Hold Option (Alt)**: every hinted control shows its key at once; release to hide.
- **`?`**: the same overlay, kept until you press Escape or `?` again (the second `?` clears them and opens the full help).
- Touch screens never draw hints. Menu and palette rows keep their key in a column of their own.

**For builders**
- Beside a button, link, tab, label or the top bar: add `${hintAttr("g h")}` (`data-hint`). Icon-only controls pass a name, `hintAttr("g t", "Talk")`, and carry no `title` (two tooltips would stack).
- `keyHint(key)` (an inline `<kbd>`) only inside a menu or palette row; `bun scripts/design-lint.ts` refuses it elsewhere (rule `keyhint`).
- The chip is a `::before` and out of flow; the host rule is `:where([data-hint])`, so a component's own `position` wins. In a card it sits on the element's top-right corner, above the label; in the tab strip, in the tab's top padding; at the top bar's edges it hangs inward.
- Screen readers: the chip's text is excluded from the name (`content: … / ""`). A single key is announced through `aria-keyshortcuts`; a chord such as `g h` is not, because that attribute means "g or h", so the `?` help lists it.
- Test: `test/hotkey-hints.test.ts`. It checks the stylesheet's rules and the rendered markup. It does not measure a rendered layout, because the test run has no layout engine.

**Terminal:** none. Terminal screens already print their keys in their footer line, which is always visible, so there is nothing to reveal.

**`:` go to a page (#10434)**
- `:` outside a field opens one line; typing narrows the forge's top-level pages (`src/web/go_pages.ts`, the one list; the Cmd/Ctrl K palette's "Go to" rows are built from the same list), Enter opens the leading match (a name that starts with what you typed beats one that contains it, ties in list order), Esc closes. With no match the line under the box says "No page called that" and Enter does nothing. It reuses the palette's dialog classes: no new component, and the list has a fixed height so nothing shifts.
- Screen readers: the input is a combobox over a listbox; `aria-activedescendant` names the leading match.
- `?` help lists the same pages: it reads `gotoPages()` in the keys script (the list the script carries, cut to the viewer's level), not the prompt's markup, which is drawn only when `:` is first pressed.
- Inside a field `:` types a colon; inside the open prompt the dialog owns the keys.
- Touch: `:` needs a keyboard. On a phone the way in is the command palette button in the top bar, whose "Go to" rows are the same pages; no second touch control was added.
- **Terminal:** none. The terminal screens print their keys in their footer line and have no `:` prompt; their pages are reached by their own menus.
- Left out: pages that belong to a repository (waves live at `/:owner/:name/waves`), so they are not top-level names.
- Test: `test/keys-palette.test.ts`.
