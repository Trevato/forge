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
