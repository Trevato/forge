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
2. Put the old app read-only (section 7, with its immediate check); take a last dump; load; compare counts.
3. Point the domain at the forge (`app-own-domain.md` has the steps, the
   certificate and the revert); switch payment webhooks and live keys.
4. Place one live order.
5. **Way back:** the old DNS records, written down before step 3 (`app-own-domain.md`); restoring
   them is the one step. The old app stays up read-only for a week.

## 7. The old side, read-only (person on the old node)
The forge cannot reach the old node, so the switch is a procedure at the
old app's reverse proxy, not a forge feature. It is used twice: in step 6.2
(freeze before the last dump, in a quiet hour) and for the week after
cut-over. **The nginx and SQL below were not run** (no nginx or Postgres is
reachable from a crew run); try them on a scratch copy first.
1. Refuse every method except `GET`, `HEAD` and `OPTIONS` at the proxy,
   before the request reaches the app, answering `503` with `Retry-After`
   and a body that names the new address. Refusing there needs no change to
   the old code and cannot be missed by a route the app forgot. nginx
   (untested), inside the `server` block:

       error_page 503 @frozen;
       if ($request_method !~ ^(GET|HEAD|OPTIONS)$) { return 503; }
       location @frozen {
           add_header Retry-After 3600 always;
           default_type text/plain;
           return 503 "Read-only: moved to https://NEW-ADDRESS\n";
       }

   `if` with `return` in a `server` block runs in the rewrite phase, before
   any `location` that would `proxy_pass`, so a refused write never reaches
   the app. Keep it to `return`; other directives inside `if` are unreliable.
   Reload (`nginx -t && nginx -s reload`).
2. Payment webhooks and background jobs are writes the proxy does not see
   as users: point the webhooks at the forge (step 6.3) and disable the old
   cron entries, or the old database still changes.
3. Make the database refuse writes too, so a missed path fails loudly.
   **Postgres only**; for another engine do the equivalent (a read-only
   user, or a read-only file mode for SQLite). Preferred: revoke write
   grants from the app's role (`REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON
   ALL TABLES IN SCHEMA public FROM app_role;`, untested). Alternative:
   `ALTER ROLE app_role SET default_transaction_read_only = on;`. That
   setting does not touch sessions already open and the app may override it
   with `SET`, so afterwards end the open sessions: `SELECT
   pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename =
   'app_role' AND pid <> pg_backend_pid();` (untested). Grants hold against
   an override; the setting does not.
4. Check, at once (the freeze, step 6.2): a `POST` to the old address
   answers `503` with the `Retry-After` header and the new address in the
   body, a `GET` answers `200`, and the step-3 row counts are equal across
   two reads a minute apart. Then take the last dump.
5. Check, over the week (after cut-over): the same counts read once a day
   do not move; any change means a write path was missed.
6. Sign-ins that write a session or a last-seen row will fail while it is on;
   say so on the old site's page, or serve it from the new address.
7. After the week, with the step-5 backup restored once, switch the old app
   off. Turning the switch off again (remove the rule, restore the grants,
   reload) is the way back before that.

What stays open: nothing in the forge records that the switch is on, nor
reminds anyone when the week ends; both are a person's.

## What the forge lacks (each is an issue)
- A database import for an app (`migrate` has no data path): upload a dump, load it, report counts and checksums. (#11697)
- ~~A Postgres app has no home here.~~ Decided, not built: no managed Postgres; port to `bun:sqlite` or keep an external one by `egress` (docs/APPS.md). (#11698)
- A file and upload copy with a manifest compared on both ends. (#11699)
- Per-app encrypted backup with a restore proof (`docs/features/backup-truth.md` covers the forge's own, not an app's). (#11701)
- A guard for rehearsal: data copy and `preview`-scoped sandbox keys exist and are the procedure in step 4; nothing yet refuses a payment name left in scope `all`. (#11702)
- Inbound payment webhooks that survive a preview's changing address. (#11703)
- ~~A read-only switch for the old side of a migration.~~ A procedure at the old proxy and database, section 7; the forge cannot reach the old node, so no feature is built. (#11704)
- Importing an app's customer accounts (password-hash formats) without the owner reading them. (#11705)
