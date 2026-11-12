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
copy, then compare the SHA-256 manifest:
`bun scripts/copy-app-files.ts <source-dir> [target-dir]` (target defaults to
`$FORGE_APP_DATA`) copies regular files, hashes both ends
(`src/apps/file_manifest.ts`), prints MISSING / CHANGED / EXTRA lines and exits
0 only when the manifests match and nothing was left behind (a target that
already holds other files is EXTRA, exit 1). `--manifest <dir>` prints a
manifest alone, for the old node. Symlinks and devices are listed as SKIPPED,
never followed, and exit 1 unless `--allow-skips` says so. A target holding a
symlink is refused.
Secrets: the owner sets each by name
in the app's settings; they are never pasted into an issue, a pull or a run.

### The database import (built, #11697)
`POST /api/v1/repos/<owner>/<name>/data-import` with an admin-scope token (or a same-origin
admin session) and `{ "dump": "<sql text>", "env": "production", "file": "app.db", "replace": false }`
(`importAppData`, `src/actions/migrate.ts`; engine `src/apps/dump_import.ts`). Only a repository's
admins; the repository must be an app. The dump is SQL text up to 16 MB (413 past it, counted by
the bytes read), the kind `sqlite3 .dump` writes. A Postgres dump is not run as it is:
`pg_dump --inserts --no-owner` output that SQLite accepts works, nothing else (#11698).

What runs is narrower than a statement's first words. `CREATE TABLE` (never `AS`), `CREATE [UNIQUE]
INDEX`, `BEGIN`, `COMMIT`, `PRAGMA foreign_keys`, and `INSERT INTO <table> [(columns)] VALUES (...)[, (...)]`
whose values are literals: numbers, strings, `X'..'`, NULL, TRUE, FALSE. `SELECT` and `WITH` outside
quotes, a function call in a `VALUES` list, and the functions that make a big value from a small
statement (`randomblob`, `zeroblob`, `printf`, `replace`, `hex`...) are refused with the statement's
number before anything is written. At most 1,000,000 statements, and each database is capped at
16,384 pages (64 MiB).

The dump is loaded into a scratch in-memory database (the dump side) and into a new file beside the
target (the store side). The answer lists each table with its row count and a SHA-256 of its rows in
rowid order, each value written as SQLite's `quote()` literal, for both sides, and `inserted`: the
rows the dump's own text declares, counted from its `VALUES` tuples without SQLite. The file replaces
the target only when the two loads agree on the checksum and each table's rows equal `inserted`;
otherwise the answer is 409 `mismatch` and nothing changed. An existing file is refused (409
`exists`) unless `replace` is true, which keeps it as `<file>.before-import-<ms>` (a name no earlier
backup has; a hard link, so the target is never absent) and renames the new file over it. Put the
counts and checksums in the migration issue, beside the old node's `SELECT count(*)` per table.

Doors: the terminal's palette entry "Database import" on a repository's admin (`src/tui/screens/dataimport.ts`;
`i` imports, `r` imports and replaces) reads a `.sql` file already in the app's `imports/` directory
under the environment's data directory, since a terminal cannot paste 16 MB and must not read a path
it is given; MCP `app_data_import` takes the text as the API does. All three are the admin's alone.

Not done: the load runs on the request, not in a worker. With only literal values and the caps above
its time is linear in the dump's bytes (about a second near 16 MB), which is why a worker with a
timeout was left out; the running app keeps its old file open until it restarts, so import with the app
stopped or restart it after; the proof shows the load agrees with itself and with the dump's row count,
not that the old node's dump was complete: compare its row counts too. No web page yet.

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
person's. Webhooks reaching a preview's changing address: see "Webhooks" below.

### Webhooks
Give the provider's sandbox **one** URL that never changes:
`https://<app>.<forge host>/__forge/hook/<pull>/<path>`. A `POST` there reaches
the preview of pull `<pull>` as `POST /<path>`, body and headers untouched, so
the provider's own signature (`Stripe-Signature` and the like) verifies in the
app against the sandbox `STRIPE_WEBHOOK_SECRET` set for scope `preview`. The
forge adds no signature of its own and cannot break the provider's. When the
pull changes, change only the number.
- `POST` only (405 otherwise); 404 when the pull has no preview or the path
  would leave the app (`..`, `//`, `/__forge/…`); 413 over 1 MiB; a sleeping
  preview is woken by the request.
- A private app, or a sealed pull's preview, refuses it like any request
  without a grant: a provider cannot sign in. Rehearse payments on a public app.
- The app must verify the provider's signature itself and answer 2xx only then.

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

## 8. Customer accounts, without the crew reading them (person runs, crew writes)
Accounts are step 3's data with one more rule: the crew never sees a row of
them, not an email, not a hash. **Nothing here was run**; the forge has no
feature for it (the gap below), so it is a procedure and a script.
1. **Formats are kept, not converted.** A password hash cannot be turned into
   another format without the password. Carry each hash exactly as stored
   (`$2b$` bcrypt, `$argon2id$` argon2, `scrypt$`/`pbkdf2$` with their salt
   and cost parameters in the string). The inventory (step 1) names which
   formats the old app wrote, by prefix only, and whether a **pepper** (a
   server-side secret mixed in before hashing) was used. A pepper is a secret
   the owner sets by name in the new app's settings (step 3); without it
   every pepper-hashed account fails, so say so before cut-over.
2. **The crew writes against invented data.** In the migrated app's own
   repository (not in the forge, and **not yet written**), the crew will write
   (a) a loader that reads the owner's export file and writes the new `bun:sqlite` table
   without logging a row, and (b) a verifier that recognises each format by
   its prefix, with tests on made-up accounts and hashes made in the test.
   An unknown prefix is refused, never guessed at. Add the rehash: after a
   successful sign-in with an old format, store the new app's own format.
3. **The owner exports and loads.** On the old node, export only the columns
   the new app needs (id, email, hash, created-at, and flags such as
   verified or staff), to a file that stays on the owner's machine. Run the
   loader on the owner's own machine against a copy of the new app's
   database, then hand the loaded database over by the data copy of step 3.
   The file never goes to a preview or a run: the forge has no way to receive
   it unseen (#11697), so until that exists the owner, not the crew, does the
   load. The export file is deleted after the load. Do not export sessions, reset tokens or API keys: sign
   everyone out and let reset mail do its work.
4. **Report counts, never content.** The loader prints per-format counts
   (`bcrypt 1204, argon2id 31`), rows loaded, rows refused with the reason,
   and an HMAC-SHA-256 over the ordered `id` and `hash` pairs, computed on
   both sides with a throwaway key the owner makes and keeps. It must be
   keyed: an unkeyed digest lets anyone holding candidate hashes confirm
   them. Equal numbers and digests go in the issue; the key does not. Duplicate emails differing by case are listed by count and
   resolved by the owner.
5. **Prove it with the owner's own account.** In the rehearsal (step 4) the
   owner, or a test customer they create on the old app first, signs in on
   the preview. One working sign-in per format is the check; the crew is
   told "works" or "fails", never the password or the row.
6. **Cut-over order.** Freeze the old side (section 7), export again so
   accounts made since the rehearsal are in, load, compare, then switch the
   domain. Accounts changed on the old side after the last export are lost;
   the freeze is what prevents that.
7. **After.** Delete the export file and any copy; the step-5 backup is the
   only other copy and is encrypted. Remove the pepper from the old node only
   when the old app is switched off.

What stays open: nothing stops an export file being pasted somewhere it
should not be; the rule is a person's. OAuth accounts (Google and so on)
carry a provider id, not a hash, and the new app needs the same client
credentials set by name or those people sign in as new accounts.

## What the forge lacks (each is an issue)
- ~~A database import for an app.~~ Built: see "The database import" above. (#11697)
- ~~A file and upload copy with a manifest compared on both ends.~~ Done as a script a person runs (#11699); no page or upload from a browser yet.
- ~~A Postgres app has no home here.~~ Decided, not built: no managed Postgres; port to `bun:sqlite` or keep an external one by `egress` (docs/APPS.md). (#11698)
- A custom domain for an app, with certificate issuance and a one-step revert: see `docs/features/app-own-domain.md`. (#11700)
- Per-app encrypted backup with a restore proof: `scripts/app-backup.ts` and the terminal, see `docs/features/app-backup.md` (`docs/features/backup-truth.md` covers the forge's own, not an app's). Scheduling and a web button are not done. (#11701)
- A guard for rehearsal: data copy and `preview`-scoped sandbox keys exist and are the procedure in step 4; nothing yet refuses a payment name left in scope `all`. (#11702)
- ~~Inbound payment webhooks that survive a preview's changing address.~~ Built: `/__forge/hook/<pull>/…` on production's host. (#11703)
- ~~A read-only switch for the old side of a migration.~~ A procedure at the old proxy and database, section 7; the forge cannot reach the old node, so no feature is built. (#11704)
- Importing an app's customer accounts without the crew reading them. Section 8 is the procedure; the loader and verifier it names are still to be written in the migrated app, and the file's way into a preview is #11697. (#11705)
