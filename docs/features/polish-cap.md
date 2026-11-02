# Polish cap

An issue labelled `polish` is small work, and it is capped small (#8852). A builder run on it that has gone `polish.capMinutes` of run time (default 60) is stopped, not extended. The crew's tick checks every minute, from the run's own start time.

- **Set it.** An admin changes **Run time a polish issue may take (minutes)** on `/settings/capacity`. It is read on every tick.
- **What you see.** The run ends cancelled with the summary "stopped at the N-minute polish cap", and the issue gets one comment: `Stopped at the 60-minute polish cap, not extended. Left: pull #M is open, unmerged.` or `Left: nothing landed, no pull open.` It is the run's open pull that says what is left; a polish run never produces a second comment.
- **Who says it.** The person who turned autonomy on, else the user the run acted as. If neither exists the run is left running rather than stopped silently.
- **Other work.** Only the label `polish` (any case) is capped; polish also counts as a small fix against `slots.smallShare`.

Left out: stopping a polish issue before its run starts, and reading the run's last summary into the line (a running run has none yet).
