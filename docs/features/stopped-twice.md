# Stopped twice

When the forge restarts under a crew run twice, the run is marked failed with "stopped twice by its forge restarting; not tried again". Home names each such run (last 24 hours, up to five, repositories you may write) in one line with **Try again**; so does the terminal.

- **Web**: Home, under the held line. Try again posts (same origin, signed in) to `/:owner/:name/runs/:id/requeue`, which queues the run's task again and returns to Home. Writers with the crew ability only; others are refused.
- **Terminal**: the palette's "Stopped runs". `j`/`k` move, `Enter` or `r` tries again. The screen reads the database on every draw, so a retry on either door shows on the other.
- **Gone when**: a newer agent run of the same issue exists, the run is over a day old, or you cannot write the repository.
- Both doors read `stoppedTwiceRuns` (`src/runs/stopped_twice.ts`) and write through `requeueRepoRun`. The forge may refuse a retry (one already waiting, the day's ceiling); it says so.
