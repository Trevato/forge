### 6·0b. Icons, and the appearance picker

Two vocabularies. **`plain`** is the safe set (§6a) — BMP, width 1, in every
default terminal font. **`nerd`** is the same vocabulary drawn from a Nerd
Font, which is a bet on the reader's _font_, a thing `TERM` cannot tell us.
`auto` takes the bet on Ghostty, kitty and WezTerm, because those are
terminals people install deliberately and installing a Nerd Font is the next
thing those people do. Everything else gets `plain`.

The bet is bounded: every glyph in both sets is exactly one cell (asserted by
`test/tui-icons.test.ts`, since every Nerd codepoint lives in a Private Use
Area that `width.ts` measures as width 1), so a missing glyph is one tofu box
and never a shifted row. Where the two sets would say different things, the
plain set keeps the documented grammar: `◆` still means "kept on your
machine", and an unpinned row still wears nothing.

`ctrl+t` opens **Appearance**: the six themes, then two more rows —

| row      | values                                        |
| -------- | --------------------------------------------- |
| `Images` | `auto (kitty)` · kitty · sixel · iterm · none |
| `Icons`  | `auto (nerd)` · nerd · plain                  |

`j`/`k` move, `left`/`right`/`enter` cycle a setting's value, a theme applies
as the cursor passes over it, and both settings persist through
`setPreference` into `user_setting`. It is `ctrl+t` and not `t` because the
workspace already spends `t` on the file finder, and an appearance picker
that silently does nothing on the one screen people live in is worse than a
modifier: one key, every screen, whatever has focus. Under the rows is a **live preview** —
three real icons in the set currently chosen — because the only honest way to
settle a bet about somebody's font is to show them three glyphs and let them
look. If they see boxes, one keypress puts it back.
