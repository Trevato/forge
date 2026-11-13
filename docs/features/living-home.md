# The home

Signed in, `/` is one page (`src/web/pages/home_flow.ts`): the pipeline as six live lanes (Asked, Building, Checks, Review, Landing, Live) or, beside it, a table of the same items; the old home's two lists, four-number line and tiles are gone. `/home` and `/?home=new` go to `/`, keeping `?view=table` and the filters; a visitor who is not signed in still gets the public door.

1. **The box** — one line that tells the crew (`POST /tell`, the same action the feed's composer posts to), with Notes and Talk beside it.
2. **The one line that needs you** — a failed proof, a red main, a stopped landing line, then what waits on you (`3 waiting on you, oldest 2 days`, over `/review`, in the largest sensible unit); or "Nothing needs you right now". Everyone sees it; the five figures beside it are an admin's.
3. **The lanes or the table** — each lane a live region of its own that redraws on its own events; the table is the same items one row each, with search, sort, filter chips and bulk actions that go through the fleet's verbs (previewed, receipted, undoable where they can be). `?view=` is remembered per browser.
4. **Figures** (admins) — one section under them: shipped over 14 days, visitors, crew spend, check time, page speed, open bugs, the last off-box backup. One card, one chart, one number formatter (`src/flow/figure_format.ts`); open or closed is remembered in the browser.
5. **The hosted forges** in one line.

None of it is read on a request. A worker reads the picture (`src/flow/lanes_worker.ts`; the fast part in a few milliseconds, the slow part — the crew's order for what is asked next, the figures, the alarms, what waits on each person who has the home open — every 30 s) and the thread keeps the last one: a page is drawn from it, a lane redraws from it and answers 304 when its version has not moved. The first page after a restart draws "reading…" and fills in place.

The feed — the composer, the timeline, what is on you, since you were here — is `/feed`, linked from the home. The terminal's home still carries the pipeline's four words and the being-built and just-shipped lists (`src/tui/screens/moving.ts`).

## The figures tell the truth (#10440)

- **Slots** in "Crew running" are `crew.concurrency` (`crewConcurrency` in `src/flow/slot_cap.ts`), or the repositories' slots when those are fewer. Home and the terminal read the same figure.
- **Dropped on purpose** from the old tiles: the ones the strip or a lane already says (shipped per hour, the live version, builders running, the week), and the Traffic, Reporting browsers and Accounts tiles; the same numbers stay on `/settings/traffic`, `/boards/reach` and the KPI probe.
- **Page speed** shows the 75th-percentile page load and, under it, `LCP … · INP …` over seven days from the first-party beacon: LCP is how long the main content takes to show, INP how long a tap takes to answer.
