# The polish share

The percent of the last seven days' agent spend that polish may take: issues labelled `polish`, or in the small-fixes lane (`isSmall`, `src/crew/small_share.ts`). 10 to start; a whole number 0 to 50. At 0 no polish starts.

- **Set it.** Web: Settings → Branch and gates → Polish share. Terminal: Autonomy, key `o`. Both go through `updateRepoSettings`, refuse anything but 0–50, and are on the settings trail, so an open week page or screen updates.
- **See it.** `/:owner/:name/week` ("Polish this week"), the terminal's week screen (last line) and the `week` MCP tool (`polish: { share, percent, polishUsd, totalUsd, under, says }`) print the same `polishWords`.
- **Dispatch.** Polish is under its share when polish spend is below `share`% of all agent spend in the window (nothing spent yet counts as under). Over it, ready polish issues are skipped until the week catches up. Issues the owner raised, ranked or put first are never held back. The window is rolling, the seven days before now; spend is `run.cost_usd` of agent runs.
- **Next up** applies the same hold, since it shows dispatch's order: while polish is over, polish issues are not listed there.
- **Tests.** `test/polish-share.test.ts` (rules, setting, dispatch on a fake clock), `test/tui-autonomy.test.ts` (terminal).
