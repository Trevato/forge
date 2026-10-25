# Failure domains

The seven ways the forge stops, and what it says when each does.
`src/kernel/domains.ts` is the data; `test/domains.test.ts` keeps this table
equal to it and proves each quoted phrase is what the forge's own code emits
under that condition. The words are quoted from `kernel/vitals.ts`, never
drafted. "Nothing yet" means the forge has no words for that domain today.
Minutes back are estimates, not measurements. A drill named here is the name
issue #1195 will build. Today the restore drill exists, and `POST /api/v1/drills`
keeps a drill's verdict for any domain here (see the README).

| Domain | What breaks | The forge says | Minutes back | The owner | Drill |
| --- | --- | --- | --- | --- | --- |
| Compute (the pod) | Nothing answers until the pod is rescheduled. | nothing yet | 2 | Wait for the platform to restart it; read the pod's events if it does not. | kill-pod |
| State (the volume) | Writes fail once the volume fills; the data is lost with the volume. | "Disk is nearly full:" | 60 | Free or grow the volume; if it is gone, restore the newest snapshot (docs/RECOVERY.md). | none: Filling or detaching the live volume would lose writes. |
| The snapshot store | Backups stop landing or cannot be read back; nothing live is affected. | "The restore drill failed at" | 30 | Fix the bucket or its keys, then run the restore drill again. | restore-drill |
| The edge (tunnel and DNS) | The forge runs but nobody outside can reach it. | nothing yet | 10 | Restart the tunnel; check the DNS record. | none: Cutting the tunnel cuts every person and agent off the forge. |
| Identity | Sign-in fails; sessions and tokens already issued may still work. | nothing yet | 15 | Restore the sign-in provider's settings; sign in with the admin password. | none: Breaking sign-in locks the owner out of the forge that would fix it. |
| The model credential | Agents cannot start work; everything else runs. | nothing yet | 5 | Set a fresh credential in the settings. | expire-token |
| The runner | Checks and runs queue behind a lane that is not moving. | "the oldest since"; "is stuck: no heartbeat for" | 10 | Cancel the stuck run; restart the runner if the lane stays empty. | lose-runner |

## Shared by accident

Two domains that fail together are one domain. The forge checks the one
pairing it can see from inside: snapshots written to a directory on the
volume they copy, with no off-box mirror, are lost with that volume. Vitals
then says "Snapshots are kept on the forge's own volume and mirrored
nowhere" on the board, the asks and `/api/v1/health`, and links Settings →
Backups, until the destination moves or a mirror is set. "One volume" means the
two paths report the same device (`st_dev`): a snapshot directory on a
different filesystem bind-mounted into the data directory is told apart, but
two directories on one disk under different mounts that share a device, or
two devices backed by the same physical disk, are not.

## Running a drill

`scripts/drills/run.ts` walks you through one. It refuses a domain whose drill
is none, prints the fault to cause, and waits for Enter (a line on stdin, so piping one works; closing stdin aborts). It then polls
`/api/v1/health` and `/` once a second, keeping each distinct line the forge
says while unhealthy; when the forge is healthy again it posts what it saw and
the seconds it took to `POST /api/v1/drills` and prints the verdict. If the
forge is still down after an hour it posts nothing, says so, and exits 0. A
refused post exits non-zero with the forge's message. `FORGE_TOKEN` must be a
site admin's token; without it the script still watches, prints the result as
JSON and says that nothing was posted.

```
FORGE_TOKEN=… bun scripts/drills/run.ts runner --forge https://forge.open-platform.sh
```
