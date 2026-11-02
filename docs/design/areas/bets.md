# Bets

## Proposed bet card (#8851)

On `/:owner/:name/bets` the owner sees each proposed bet as one `card()`: the
name, its journeys, a `<details>` whose summary is the issue count and whose
body lists the issues, one primary `Back it at N%` button that posts the
proposed appetite, and a second `<details>` ("Change the share") holding the
share field. When `mayBack` refuses (5 running, or the week would be passed)
the button is `disabled` and the reason is a `muted` note beside it. No new
class; the card is stacked blocks, so at 390 px it needs no horizontal scroll.
