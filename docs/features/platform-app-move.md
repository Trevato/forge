# Moving a platform app to the forge (gretchy-stretchy, #11687)

`migrate` (`src/actions/migrate.ts`) brings a repository's history, issues and
open pulls and, with a crew asked for, tells the crew to make it run here. It
moves **code only**. A shop also has data, files, secrets, a domain, payments
and jobs. This is the order that moves them, who does each step, and what the
forge lacks. Nothing here was run: the old node, its database and the owner
are outside a crew run's reach. Every step marked **person** needs one.

## 1. Inventory (read-only, person on the old node)
Write the answers in the migration issue; names of secrets, never values.
- Repository: host, default branch, last deploy commit.
- Database: engine and version, tables, bytes, row counts (`SELECT relname, n_live_tup`), extensions.
- Files and uploads: paths, bytes, file count, a SHA-256 manifest.
- Environment: variable names only; which are payment, mail, session secrets.
- Domain: registrar, DNS records, TTLs, TLS terminated where.
- Payments: provider, sandbox and live keys' names, webhook endpoints and the URL each calls.
- Scheduled jobs: schedule, command, timezone.
- Sign-in: who signs in (customers, staff), and how (password hashes, OAuth).

## 2. Run from the repository (crew)
`migrate` with a crew. The app must read `FORGE_APP_DATA`, listen as
`forge.json` says, and declare `schedules` for its jobs.
The forge's store is `bun:sqlite`; a Postgres app is ported (the crew's work)
or keeps an external Postgres reached by an egress entry. The pull says which.
The decision and both paths are in docs/APPS.md, "What is deliberately not here".

## 3. Copy the data (person runs, crew writes the script)
Dump with `pg_dump`, load, then compare per-table row counts and a per-table
checksum (`md5` of ordered rows). Counts and checksums go in the issue. Files:
copy, then compare the SHA-256 manifest. Secrets: the owner sets each by name
in the app's settings; they are never pasted into an issue, a pull or a run.

## 4. Rehearse on a preview (person)
Preview address, a copy of the data, the payment **sandbox** keys. The owner,
or the shop's owner, places an order and the webhook lands. No cut-over before
they say so in the issue.

The forge already does the parts of this (`docs/APPS.md`, "Rehearsal"): a
preview's data is a copy of production's taken when it is created, and a
variable set for scope `preview` beats the same name set for `all` or
`production`. So the rehearsal is a procedure, in this order:
1. In **Settings → App → Environment**, set each payment name (for example
   `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`) with scope `production` to
   the live value and with scope `preview` to the sandbox value.
2. **Never leave a payment name in scope `all`.** `all` reaches previews, so
   a live key there is a live key in the rehearsal. Move it to `production`
   before the pull is opened.
3. Open the pull; read the app's payment-mode indicator (the app should show
   `sandbox` on the preview) before anyone places an order.
4. The copy is disposable: it is gone with the pull, and nothing placed on it
   reaches production's data.

What stays open: the forge cannot tell which names are payment keys, so
nothing refuses a live key in `all` or in `preview`; the checks above are a
person's. Webhooks reaching a preview's changing address are #11703.

## 5. Backup before anything is removed (person)
Encrypted dump and files archive (`age` or `gpg`, key held by the owner, not
on the node). Restore it into a scratch database and compare the step-3
counts. The old copy stays until that has passed.

## 6. Cut-over (person, quiet hour, the owner says "go")
1. Lower the DNS TTL a day ahead.
2. Put the old app read-only; take a last dump; load; compare counts.
3. Point the domain at the forge (`app-own-domain.md` has the steps, the
   certificate and the revert); switch payment webhooks and live keys.
4. Place one live order.
5. **Way back:** the old DNS records, written down before step 3 (`app-own-domain.md`); restoring
   them is the one step. The old app stays up read-only for a week.

## What the forge lacks (each is an issue)
- A database import for an app (`migrate` has no data path): upload a dump, load it, report counts and checksums. (#11697)
- ~~A Postgres app has no home here.~~ Decided, not built: no managed Postgres; port to `bun:sqlite` or keep an external one by `egress` (docs/APPS.md). (#11698)
- A file and upload copy with a manifest compared on both ends. (#11699)
- Per-app encrypted backup with a restore proof (`docs/features/backup-truth.md` covers the forge's own, not an app's). (#11701)
- A guard for rehearsal: data copy and `preview`-scoped sandbox keys exist and are the procedure in step 4; nothing yet refuses a payment name left in scope `all`. (#11702)
- Inbound payment webhooks that survive a preview's changing address. (#11703)
- A read-only switch for the old side of a migration. (#11704)
- Importing an app's customer accounts (password-hash formats) without the owner reading them. (#11705)
