# Your team

Settings › Crew opens with **Your team**: whether auto mode is on, and the three seats — planner (turns your
direction into issues), builder (writes the change, opens a pull), reviewer (reads each pull and lands the good ones).
With auto mode on, an empty seat warns what will not happen ("No reviewer: agent pulls wait for you.") with one button
to put an agent in it; with auto mode off, or in a preview where the crew is held off, an empty seat is an open seat with
the same button, no warning. The button is the repository admin's; nobody else sees it.

One source: `seatsOf` in `src/crew/seats.ts`, drawn by `teamCard` (`src/web/studio/crew.ts`), listed on the terminal's
About card (`I` on a repository: one row per seat) and returned as `seats` by the MCP `crew` tool. The button posts
`agent` and `role` to the crew-add route; `p` on the terminal's About card does the same for the first empty seat
(`addToCrew(…, role)`). Either way the role is set only for an agent who joins now: one already on the crew keeps its role
(change it under its own role control).

The old "No reviewer" note under On its own, shown only for `autonomous`, is gone: the same warning now shows on the
reviewer seat for every mode except off.
