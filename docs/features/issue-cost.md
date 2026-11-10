# Issue cost: what an issue and its pulls spent

An issue's page and its terminal screen say what the issue cost: the dollars
its own agent runs spent plus the dollars spent on every pull whose
description closes it. It is for people who write to the repository and want
to know what a piece of work cost before they look at the whole ledger.

- **Web** (`/<owner>/<repo>/issues/<n>`): under the Runs card, a list of rows.
  `Cost` is the total. When a closing pull spent anything, `This issue`
  shows the issue's own runs and one `Pull` row per pull follows, with the
  pull number linking to the pull. With no runs of its own but a closing pull
  that spent something, the Runs card is left out and the cost rows stay.
- **Terminal** (open the issue): one line under the Crew card, for example
  `Cost $0.75: this issue $0.50, #12 $0.25`.

## Rules

- A pull counts when its description closes the issue, read by
  `closesFromBody` (`src/core/pulls.ts`), in any state: `Closes #7` counts for
  #7 and not for #70. Runs are summed from `run.cost_usd`, in US dollars as
  recorded, rounded to a ten-thousandth.
- A pull that closes two issues counts in both, so the issues' totals can add
  up to more than the repository spent. The repository's total is the usage
  ledger's.
- Nothing is shown when nothing was spent.
- The same gate applies on both doors (`issueCostFor`,
  `src/core/issue_cost.ts`): the viewer must read the repository's runs, see
  the owner's facts (as the runs list hides cost from other readers), and be
  allowed to see the issue. A sealed pull the viewer may not see is left out
  of the sum. A guest sees nothing.

## Not done

There is no API or MCP field for the cost yet.
