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
| The runner | Checks and runs queue behind a lane that is not moving. | "wait behind one lane; the oldest since"; "is stuck: no heartbeat for" | 10 | Cancel the stuck run; restart the runner if the lane stays empty. | lose-runner |
