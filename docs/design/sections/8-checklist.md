## 8. Checklist before you call a screen done

1. Every divider is exactly 1px. The only 2px things are the active-tab
   underline and the focus ring.
2. Every number that lines up is tabular.
3. Icons sit in a fixed 16px slot; the text baseline does not move when one
   appears.
4. Secondary actions are in the DOM at `opacity: 0` and revealed on hover —
   never `display: none` → `flex`. A settings row is the exception: its
   control is the point of the row, so it sits in `.row-fields`, visible at
   rest, and the list wears `.setting-list` (see §5d).
5. Exactly one accent-colored thing, and it is the action.
6. The empty state has exactly one button.
7. Nothing on the page needs JavaScript to work.
8. It survives 200% zoom and a 320px viewport with no horizontal body scroll —
   diffs and code scroll inside their own card.
9. Nothing inside a linked row is itself a link.
10. Any control that only works with a script carries `js-only`, so a page
    without JavaScript never shows a dead button.
11. Every token count sits beside a byte size, a cost or a percentage, and
    goes through `tokenCount()` — never a hand-written `k`.
