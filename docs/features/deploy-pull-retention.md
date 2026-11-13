# What a deploy carries, and when each change first went live

Two questions about production deploys used to share one table, `deploy_pull`, with a row for every merged pull each deploy carried: what does this deploy carry (the run page, the run API field `carries`, the terminal's deploys screen), and when did this pull first go live (ask-to-live on the map and the milestones). The forge's own repository has about 2,500 merged pulls and about 650 deploys a week, so each deploy wrote about 2,500 rows. On production that was 9.9M rows and 2.2 GB of a 4.6 GB file, and 98.5% of it was one repository (#12009, part of #11973).

## What is kept now

- **When each pull first went live** is `deploy_landed`: one row per merged pull (`issue_id`, the deploy run that first carried it, the pull's number, the instant that deploy went live). A finished production deploy walks its commit once (`git rev-list`) and writes only the pulls no earlier deploy had carried, a handful of rows (`recordCarried`, `src/core/carried.ts`). Ask-to-live reads it by key, one read for all the window's pulls (`firstLiveOf`, `src/core/pillars.ts`), and no deploy is read at all.
- **What a deploy carries** is not stored. It is the merged pulls whose merge commit the deploy's commit contains: a fact git gives in one walk. The run page, the run API and the deploys screen ask `carriedFor` / `carriedForRuns`, which read the rows an older release wrote while they last and otherwise walk git and keep the answer in memory (at most 200 lists per forge process; a deploy that carries none is remembered for as long as the process runs, up to 10,000 deploys; a walk git cannot finish is retried after a minute). Nothing a walk finds is written to the database. Preview deploys and deploys that failed or are still running are never walked.

## The old table

Nothing writes `deploy_pull` any more. `retention_deploys.ts` trims what an older release wrote, in slices: it keeps the rows of deploys from the last `retention.deploy_pull_days` days (1 by default, `DEPLOY_PULL_KEEP_DAYS`; an admin moves it on `/admin/limits`) and of the deploy each app is running now, and deletes the rest. It starts only once `deploy_landed` has been filled from those rows (`backfillLanded`: for each pull merged in the last 7 days, the first deploy that carries it), so nothing ask-to-live reads goes with them. The table and its two indexes are dropped in a later release, once no release that writes it is left in play.

## How it runs

`src/system/retention.ts` runs the trim and the backfill as paced jobs, `retention-deploys` (250 rows a slice, about 15 ms) and `landed-backfill` (60 pulls a slice). Each slice is its own short transaction; after a slice of `t` ms the job waits `19 t` (never under 100 ms), so it takes 5% of the thread at most. It runs the same on the serving thread and on the engine's Worker. Both appear by name in the stall blame (`perf/jobs.ts`).
