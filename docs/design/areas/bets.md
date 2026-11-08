# Bets

## Proposed bet card (#8851)

On `/:owner/:name/bets` the owner sees each proposed bet as one `card()`: the
name, its journeys, a `<details>` whose summary is the issue count and whose
body lists the issues, one primary `Back it at N%` button that posts the
proposed appetite, and a second `<details>` ("Change the share") holding the
share field. When `mayBack` refuses (5 running, or the week would be passed)
the button is `disabled` and the reason is a `muted` note beside it. No new
class; the card is stacked blocks, so at 390 px it needs no horizontal scroll.

### One screen at 390 px (#8970)

At rest the card shows the name, at most three journeys (the rest behind a
"N more" disclosure), the issue count, the button and the cut button; the
share field stays folded. The card carries `data-bet-card` (an attribute, not
a class) which wraps long words anywhere and tightens block margins, so a long
name or journey neither scrolls sideways nor pushes the button off the screen.
Desk and phone looks are attached to the pull from its preview.

**Departure, named.** `data-bet-card` is not a variant of `card()`: the card
itself is the stock one. The attribute only scopes three rules inside it
(wrap anywhere, `8px` block margins, `16px` list indent, all from the 4px
scale in DESIGN §4; there are no spacing custom properties to use). It is an
attribute because the area adds no component class. The preview seed holds a
third proposed bet with a long name and an unbroken address as a journey, so
the worst case is on `/preview-admin/sample/bets`.

### Bounded body (#9321)

The bound is on what a disclosure opens (`[data-bet-card] details ul`, `max-height: 40vh`,
`overflow-y: auto`), not on the row: the row never scrolls, the page does, and a long
issue list scrolls inside its own details. No new
class. `test/bets-card-fit.test.ts` fails if the bound is removed.

## Rows, not boxes (#9859)

The list on `/:owner/:name/bets` is one `row()` per bet in a `ul.list.setting-list[data-bets]`, no `card()`. A proposed bet's row carries its share and next action in the meta; its journeys (three, the rest in a "N more" `<details>`), issue count and actions sit in the row's `after` slot. `data-bet-card` is now on the row's `<li>` (the bounds above still scope to it). The one CSS change: `[data-bets]` joins `[data-origins]` in giving `.row-after` the full row width. A finished bet's "This is done. Try it." is a `settings-block` heading and a line. No new class.
