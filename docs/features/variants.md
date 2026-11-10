# Variants

A branch of an app kept running as its own environment, with values of its
own, beside production and the previews of pulls. Exploring means running
several versions at once; the variant board puts them side by side and
"Make this main" keeps the winner.

## Use

Open an app's **Variants** (`/<owner>/<name>/variants`, linked from the app
page). A writer who is a person (never an agent, never on a mirror):

- **Run a branch as a variant** — a branch and a label (1–16 lowercase letters
  and digits; the branch name by default). It runs at
  `<slug>--v-<label>.<domain>` with a copy of production's data.
- **Save values** — `NAME=value` lines, committed as `variant.json` on the
  branch, so they are versioned. The variant restarts with them.
- **Make this main** — opens the pull from the branch to the default branch
  (or hands back the one open). The merge is the pull's: its checks, a person.
- **Retire** — stops the environment and drops the row. The branch stays.

## `variant.json`

```json
{ "values": { "PRINT": "true", "VOICE": "dry" } }
```

Plain values, at most 20, each one printable line of at most 200 characters,
named like environment variables and never `FORGE_*` or a name the forge sets
(`PORT`, `HOME`…). They go over the app's own environment variables of the
same name. Secrets are never in the file: set them under the app's
environment settings, where they stay sealed forge-side. A file that is
present and wrong starts the variant with no values.

## What the board shows

For each variant: its state, its distinguishing values (read from the branch),
its preview, and what it last made. An app tells the forge what it last made
by writing `last-output.json` into its own `FORGE_APP_DATA`:

```json
{ "title": "Edition 12", "path": "/editions/12" }
```

`path` is optional and on the app's own address. The forge reads it as data
only (4 KB, one printable line).

## Lifetime and budget

A variant lives as long as its row, not as long as a pull: a reconcile keeps
it, a push to its branch redeploys it. It sleeps on production's schedule
(`SLEEP_AFTER_MS.production`), not a preview's thirty minutes, and wakes on
the next request. It counts as a live preview against the account's
`previews` limit, which the board shows. An app keeps at most
`VARIANTS_MAX` (6).

## The terminal, and who may deploy

The board is also in the terminal: `:` then "Variants" on a repository that is an
app (`src/tui/screens/variants.ts`). Anyone who can read sees the list; a person
who can write registers (`r`), sets (`s`) or drops (`u`) a value, retires after a
confirm (`x`) and makes one main (`m`), through the same actions as the page.

A push to a variant's branch redeploys it only when the pusher is a person who
can write. A variant runs with the app's sealed values and a copy of its data, so
an agent's push waits: it proposes through a pull, which has its own preview.
`variant.json` is read only as a regular file in the checkout, never through a
symlink. An app slugged like `v-<label>` before that shape was reserved keeps its
host.

## Not yet

A terminal into a variant, and a first-use morning-paper pair of branches
(that app's own repository holds `variant.json` and the `last-output.json`
write).
