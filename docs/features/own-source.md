# A child forge's own source

Every new child forge is born with `<admin>/forge`, a fork of the parent's code
(`src/spawn/forge_code.ts`), so its crew can work on the forge itself.

- Its `forgeRepo` setting names it (an admin's earlier choice stands), so the
  forge shows that repository as itself.
- The parent is its upstream, recorded as `forgeCode` in `parent.json`: take
  updates, or send a change back as a pull on the parent through the origin.
- Its crew is seated on it, each with the role they hold on the child's other
  repositories.

Merging there runs on the next image; it does not redeploy the child.

## Existing children: a recorded one-shot

`src/spawn/forge_code_backfill.ts` runs at the parent's boot. The first run
writes `forge-code-backfill.json` under the parent's data directory: the
children that exist then, and what became of each. Later boots read that file
and open nothing once every child is settled; children born afterwards are
made with their source and are not in it. No child names live in source.

- A child whose `parent.json` already records its source is settled without
  opening its database.
- A child that is awake (open here or in a cell) is skipped and tried at the
  next boot: opening its database writes, and its write lock is its own.
- A failure is recorded as an error and retried at the next boot.

A `forge` repository a person made is left alone. "We made it" is a record:
`forgeCodeStarted` in `parent.json`, written before the repository is created.
A run that died after creating the repo (fetch failed, or `parent.json` not
yet written) leaves the record, and the next pass finishes the fetch; a repo
without the record is a person's and stays theirs.

## Both doors, and what was exercised

The terminal needs nothing of its own: `<admin>/forge` is an ordinary public
repository there, listed and opened like any other. Settings (`forgeRepo`) is
a web page. Exercised by `test/forge-code-own-source.test.ts`: a spawned child
has the repo, the setting and the parent as origin; backfill is idempotent,
finishes an unfinished run, leaves a person's repo alone, and is a recorded
one-shot; adoption seats the crew with copied roles and keeps an earlier
`forgeRepo`.

## Why it goes before the pipeline list

A forge that cannot be worked on from inside cannot take part in the pipeline
list (#6534, #6611, ...): those items are changes to the child's own code, and
each needs a repository on the child to land in and an upstream to send back
to. This is the ground they stand on.
