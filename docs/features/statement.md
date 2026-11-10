# The statement — what the forge would charge an app

One app, one UTC calendar month (#508). No payment processor: every line is
quantity × price, so anyone can check it by hand.

| line                         | quantity                      | price                      |
| ---------------------------- | ----------------------------- | -------------------------- |
| Awake time                   | awake-hours, all environments | list $/awake-hour          |
| Storage                      | GB-months (GB-hours / 730)    | list $/GB-month            |
| Crew spend at cost           | USD of crew spend             | 1                          |
| Margin on crew spend (N%)    | USD of crew spend             | N / 100                    |

The total is the unrounded sum, rounded once to the cent.

- **Set the list prices** in Settings → Economics, beside the costs, or with
  `PUT /api/v1/forge/economics` (`awakePriceHourUsd`, `storagePriceGbMonthUsd`).
  The margin is the one beside the profit slider.
- **Read it** at `GET /api/v1/repos/:owner/:name/statement?month=2026-10`;
  `format=csv` (or `accept: text/csv`) is the same lines as a table file.
  Without `month`, this month so far.
- **Print it** from the repository's Settings → App → Statement
  (`/:owner/:name/settings/app/statement`); printing hides the navigation.
- **At the terminal**, open the repository and pick `owner/name — Statement`
  from the `:` palette: the same lines and total. `m` takes a month
  (YYYY-MM), `[` and `]` step back and forward.

The repository's admins and forge admins can read it; anyone else gets a 404.
