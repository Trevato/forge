# Release what the Later gate holds

Before #7797, triage linked an issue to wait for the Later gate when it named no pillar. The rule is gone; the links stayed. Owner-run, on the forge's data directory:

    bun scripts/release-later.ts <dataDir> trevato/forge            # list, writes nothing
    bun scripts/release-later.ts <dataDir> trevato/forge --apply    # unlink them
    bun scripts/release-later.ts <dataDir> trevato/forge --only 7636,7637 --apply

An issue is listed when the gate is the only open issue it waits for; the list says who linked it, so a deliberate deferral by a person can be left out with `--only`. Only the edge to the gate is deleted. Run it again: an empty list confirms it. Triage no longer links work to the gate for lack of a pillar (`test/triage.test.ts` fails if it does), so nothing re-holds them. A person's reversal ("take #N back") still defers its issue behind the gate on purpose; that is a different edge and the list will show it. The script exits 2 with a plain message on a missing `forge.db`, one without the forge's tables, an unknown repository, or bad arguments.
