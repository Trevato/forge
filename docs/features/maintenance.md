# Maintenance: shut down for a move and come back by itself (#9453)

**Prepare.** An admin opens `/maintenance` (linked from Resilience), the terminal's Maintenance command
(`src/tui/screens/maintenance.ts`: `p` prepare, `c` check again, `e` end; admins only), or calls
`POST /api/v1/admin/maintenance/prepare` (admin-scope token) or MCP
`maintenance {action: "prepare"}`. The forge then:

1. holds releases (an owner hold, `keeper/hold.ts`);
2. pauses the crew: the dispatcher starts nothing while `maintenance.json`
   stands in the data directory; vitals reads the queue as held by "planned maintenance";
3. takes a fresh snapshot (`actions/backups_now.ts`);
4. reports the drain: `GET /api/v1/admin/maintenance` says `draining` while runs
   or checks still go, `ready` when the backup is taken and nothing runs. Power
   off on `ready`; a SIGTERM drains the rest as in a release.

The page says plainly what stops: releases, new crew runs, then the forge, its
apps and previews when the host powers off.

**Come back.** On boot `resumeAtBoot` acts only when the host has restarted since the prepare
(`/proc/sys/kernel/random/boot_id` differs from the one stored); a release roll of the process on
the same host boot keeps what the admin prepared. It then lifts the hold, unpauses the crew and
records a line (shown on `/maintenance`, in the status, and as the
`maintenance.ended` event) with every check and its result (`src/maintenance/checks.ts`,
one plain function each: database, hold, dispatcher, apps, nightly lines, queue, and at boot
the tunnel, which must answer `/healthz` on the public address (asked again every 3 s for up to
30 s, since it often comes up after the process; the listener is already up when this runs), and the
runner, whose checks lane must hand out a slot within 2 s: that proves the lane is not wedged, not that
a check would run). A failed check reads `FAILED` as a badge on a `dl` row of `/maintenance`, first
in the terminal screen; the status reads "Back, NOT healthy" with `healthy: false`; the hold is lifted
regardless. Admins with a
notification address are told what is healthy and what is not. An admin can also press
"End maintenance now" (no outside probes then). The nightly jobs show on Resilience.
No Kubernetes is asked anything; the state is one file.

**While it is off.** `bun scripts/standby.ts 8080` serves the calm 503 page
(`src/maintenance/page.ts`) from the droplet; point the tunnel's or
Cloudflare's origin at it for the move, and back after. A Cloudflare Worker can
return the same HTML with status 503 and `Retry-After`.

**Size of a standby.** For reads or a whole forge: disk for the data (38 GB now,
apps 13 GB) plus one snapshot and headroom, so 64 GB; 4 GB of memory free for the
forge alone, 8 GB with apps running. The 16 GB droplet cannot hold it.

## Not done
- No standby takeover: nothing replicates data to a second machine, so the
  droplet can only show the page. That needs the snapshot mirror restored onto a
  machine of the size above, and is a separate issue.
- The page is not pushed to Cloudflare automatically; `standby.ts` is started by hand.
- The admin is told on the page, event and status, and by the notification address they saved (`/account`); no mail.
- Where the kernel gives no boot id, any restart ends maintenance.
