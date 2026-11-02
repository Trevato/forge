### 6·0. The pointer

The terminal UI is keyboard-first and mouse-**complete**: everything you can
see is something you can click, and clicking never reaches somewhere the
keyboard could not. Reporting is on from the moment a session starts
(`?1000h ?1002h ?1006h`, SGR coordinates last) and off before the alt screen
is left. The one cost is real and is said out loud in the `?` overlay:
**shift-drag** is now how you select text, because the terminal's own
selection is what mouse reporting takes away.

**The model is a hit table rebuilt every frame.** During `render`, a screen
claims rectangles with `ctx.hit(rect, handler)`:

```ts
ctx.hit(rect, (e) => open(rows[e.y])); // click only
ctx.hit(rect, { click, wheel }); // and the wheel
```

The registry is cleared at the top of every paint and rebuilt by whoever
draws, so a region can never outlive the pixels it stands for — the bug every
retained hit table eventually has. Regions are searched **newest-first**, so
whatever drew last is what a click reaches: an overlay draws after the screen
beneath it, and needs no z-index to win. A region that does not handle _this_
gesture is not in the way of one that does, so the wheel over a clickable row
still scrolls the list the row is in.

Four rules hold the gestures together:

- **A click selects; a second click on the selected row opens it.** So does a
  double-click on any row. A single click has to be safe, because half of
  pointing at a row is looking at it, and a list where looking navigates is a
  list you cannot browse.
- **One notch is three rows**, delivered to the region under the pointer. A
  notch nobody claimed falls back to arrow keys, which is what a wheel has
  always meant.
- **Mouse input is never a synthetic keystroke.** Nothing reaches
  `Screen.key`; a screen that wants a click says so with `ctx.hit`. The
  keyboard behaviour of every screen is unchanged by any of this.
- **A click on an overlay's dimmed backdrop dismisses it**, and does not reach
  the row underneath.

Clickable today: every list row, the dashboard's four panes, the workspace's
explorer rows and tab chips (including the active tab's `✗`), the file pane
(focus, and the wheel), the where-strip's three places, the palette's results,
the appearance picker's rows, the owner, refs, settings, account
lists, the pull's diff-and-threads pane, and **every
hint in the help bar** — clicking a hint presses the key it names, taken from
the binding itself so a label can never drift from the action. A list with no
`hitList` is a bug, not a design decision: "everything you can see is
something you can click" is the whole claim.
