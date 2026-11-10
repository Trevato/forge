# The money line — cost, revenue and the gap

Whether the economics slider is set right, read in one line (#510). All
figures are US dollars to the cent; a day is a UTC calendar day, and this
month runs from the 1st to now.

    This month · cost $103.50 · revenue $12.00 · -$91.50 · spend: responsive
    Today: gap -$5.00

- **cost** — `costOf`: the forge's own server's monthly price spread over
  the days so far, cloud awake-hours, storage, and crew spend.
- **revenue** — the sum of every app's statement (`docs/features/statement.md`),
  to the cent.
- **gap** — revenue − cost, with its sign. A loss is in the warning tint.
- **spend** — the Economics slider's position in words (#11102):
  `cheapest` at 0, `lean` below 40, `balanced` from 40 to 60 (the default,
  50, included), `responsive` above 60, `most responsive` at 100. On the
  board it is the line's one link to Settings → Economics, in the accent;
  its accessible name reads "Spend slider: balanced, open Economics
  settings".

## Where to read it

- **The board** (`/board`), for a site admin: the line above, and beside it
  the last 30 days' cost (muted) and revenue (text colour) as one small
  chart, the space between them shaded faintly for a profit and in the
  warning tint for a loss. The slider's word ("spend: balanced") is the one
  link to Settings → Economics.
- **An app's page**, for the repository's admins and forge admins: a
  "This month" card with the app's cost, revenue (linking to its statement),
  gap, and how many hours it was awake on the forge's own server against
  cloud. A brand-new app's page shows its progress instead, without the card.
- **At the terminal**, a site admin picks `Money` from the `:` palette for
  the month, today, the slider and each of the 30 days. With a repository
  open, its admins pick `owner/name — Money` for that app's month.

## The one assumption

An app's cost takes the forge's own server in proportion to its share of
the time apps were awake there this month. An app awake only on cloud takes
none of it. So the forge's cost is the apps' costs, plus the part of the
server's month no app was awake on.

Anyone else is told nothing: the board leaves the line out, the app page
leaves the card out, and the terminal offers neither screen.
