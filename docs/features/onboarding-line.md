# Where a new app stands

A new or migrated app says where it stands until production first runs (#10295).

## What it says

- **Imported.** The crew has not started yet.
- **Making it run.** The crew has a pull open. The owner reads the agent's name; everyone else reads "the crew".
- **Check failed.** The owner and the crew read the failing line and a link to the run's log. Anyone else reads only "A check failed."
- **Retrying.** The crew is at it again after a failed check. Same rule for the failing line.
- **Preview up.** The pull's preview answers.
- **Landed.** The pull landed and production is starting.
- **Stopped.** The pull closed without landing. It needs the owner.
- **Live.** Production answered. The page says this itself; the owner is told once.

## Which apps

Only apps created since this shipped, and only for 14 days after they were made. An app that went live stops being looked at a day later. Older apps never show the line and never notify.

## Where it shows

- **App page.** The head card's facts row. While production has no deploy of its own, the line takes that row's place. Once production has one, the row says what production is doing, as for any app. It swaps with the head when a run or pull event arrives, and only while the row is there.
- **Terminal.** The first line under the Deploys screen's head.
- **Notifications.** The owner is told once when the app goes live, and once when its pull closes without landing. A failed check or a retry never notifies.

## How it works

`src/apps/onboarding.ts` judges the line from the pulls and runs the forge keeps. Pulls are read through `sealedScope`, and the failing line through `mayReadRunLog`, so a viewer learns nothing the repository withholds.

Two things are kept in memory:

- When an app's production first served. It never changes once set.
- The notifier's last judgment per app. A run or pull event on the app clears it, so a clock tick reads no pulls or runs.
