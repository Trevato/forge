# Adapter facts on the app page and in the terminal (#10037)

An app whose `forge.json` declares an `adapter` shows its **source**, how
often it pulls (**every**), its **last pull** (state, written/skipped/failed,
when), the **next pull** and the **cursor** of the last good pull.

- **Web:** the app page (`/<owner>/<repo>/app`) shows an "Adapter" section of
  plain rows in the side column. Only people who see owner facts
  (`canSeeOwnerFacts`) get it.
- **Terminal:** open the repository, press the palette key and choose
  "<owner>/<repo> — Adapter" (`src/tui/screens/adapter.ts`). Same gate, same
  rows.
- Both list the **last ten pull runs** under the facts (`pullRunLines`,
  limit 10): when, ok or failed, written/skipped/failed and, for a failed
  run, its error sentence. With no runs, one muted line says "No pull runs
  yet." under the always-present "Pull runs" heading.
- Both read `adapterFactsOf` (`src/apps/adapter_facts.ts`).
- An app with no adapter shows nothing on the page. Its terminal screen
  says it declares no adapter.
- Both doors render the same wording, `adapterFactRows`; the web adds only
  markup.

Cost: the page resolves the default branch's tip and reads the parsed spec
from a cache keyed by that tip (`declaredByTip`), plus two limit-1 reads of
`pull_run_app` / `pull_run_app_ok` and one limit-10 read of the runs; no git parse on a repeat view.
