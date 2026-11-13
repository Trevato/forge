# What an older deploy carries

`deploy_pull` records which merged pulls each production deploy carries. The run page, the run API (`GET /api/v1/repos/<owner>/<repo>/runs/<id>`, field `carries`) and the terminal's deploys screen all read it. The table is an index over git, so it does not need to keep every deploy forever (#12009, part of #11973).

## The rule

`src/system/retention_deploys.ts` keeps the rows of:

- deploys from the last `retention.deploy_pull_days` days (14 by default, `DEPLOY_PULL_KEEP_DAYS`; an admin moves it on `/admin/limits`, never below 7, the week ask-to-live reads), and
- the deploy each app is running now (its newest successful production deploy), however old.

Every other deploy's rows are deleted by the crew tick in batches of at most `DEPLOY_PULL_BATCH` (5,000) rows. The tick reads the candidate rows first, then deletes them by rowid in one short transaction. It runs one batch per tick while each batch comes back full, then one batch an hour after that. When it deletes something, the log says `trimmed deploy_pull`.

## Asking for an older deploy

You don't have to do anything. Open `/<owner>/<repo>/runs/<id>` for a production deploy older than the window, or call the run API, or open the app's deploys screen in the terminal. The forge walks that deploy's commit in git (`carriedFor` / `carriedForRuns` in `src/core/carried.ts`), finds the merged pulls it contains and saves them again. You get the same list as before the trim, and later views read the saved rows.

Each running forge walks a deploy at most once at a time; views of the same deploy that arrive together share one walk. If a deploy carries no pulls, it is walked once and the empty answer is remembered for as long as the forge runs, for up to 10,000 deploys. If git can't walk the commit, the forge waits a minute before trying again. Preview deploys and deploys that failed or are still running are never walked.
