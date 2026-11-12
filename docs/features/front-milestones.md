# Milestones at the front door (#1083)

The few biggest open milestones sit on the home, on the signed-out door and on an app's page, as plain rows: the name, how far it is, what landed in 7 days (or "quiet this week"), and the estimate when there is one. A region paints nothing when none of them moved this week. No spend is ever shown: that is the owner's, on the milestones page.

- Read: `biggestMilestones` in `src/web/studio/milestone_lines.ts`, over the plan the milestones pages use (`planFor`). At most 3 milestones from at most 30 apps.
- Whose apps: `frontApps`. A signed-in person gets their own apps (an admin, every one); a guest gets the public ones. An app's page reads only that app, for whoever may read it.
- Live: `GET /live/milestones` and `GET /:owner/:name/app/milestones` redraw the region on `issue.*`, `pull.merged` and `pull.closed`.
- The wave that moved a milestone: its page says "Last moved in wave X", and its JSON has `lastWave` and `movedThisWeek`. The newest 8 wave files are read from git once per repository's latest event (`src/story/wave_last.ts`), then kept for a minute.
- Terminal: the palette entry **Milestones** (`src/tui/screens/frontms.ts`) lists the same rows, gated by the same `frontApps`; `enter` opens one on the web.
- Tests: `test/milestone-front-door.test.ts`, `test/tui-front-milestones.test.ts`.
