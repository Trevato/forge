# New commits upstream, on a mirror

A repository brought from another forge (or any origin) shows "N new commits
upstream" under its head when the origin's default branch has moved past it,
with **Take them** (`POST /:owner/:name/sync/take`).

- `src/origins/ahead.ts` reads the origin's tip (objects only, no ref moves),
  counts, and keeps the reading as an origin cursor. The worker re-reads up to
  four mirrors a minute, each at most every two minutes; a sync clears it.
- The readings run under their own single-flight guard (`runAheadReads`,
  started from the same minute tick as `runSync`), never inside the sweep's:
  a reading stuck on a slow origin holds only the next reading, never a sync.
- Only a person who may write the repository sees **Take them**; everyone who
  may read it sees the count, and a guest sees nothing on a private one.
- At the terminal: the palette's "New commits upstream" lists the mirrors you
  can read that are behind (one query over the readings, not one per
  repository); `t` takes them under the page's own check, `requireWriter`
  (`src/tui/screens/originahead.ts`).
- A mirror whose default branch holds commits the origin lacks shows
  "conflicts with commits here". Take them then moves nothing, and neither
  does the sweep: it leaves that mirror's git alone and says why where the
  last fetch is shown. **Sync now** is unchanged: the person asked for the
  origin's branches, so it replaces the diverged branch, and it is the way out.
  An origin that cannot be read just then is refused the same way: it is not
  known whether taking would overwrite.
- A repository's readings go with it when it is deleted or linked to another
  origin (`forgetRepoCursors`); disconnecting an origin drops its cursors by
  the schema.
- `test/origin-ahead.test.ts` runs two forges: commit on the origin, see the
  count, take them, count 0; a diverged mirror survives Take them and a sweep;
  a silent origin does not hold the sweep.
