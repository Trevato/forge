# Stranger pulls

A **stranger's pull** is one whose author can neither write the repository
nor sits on its crew: a guest from another forge, a guest's fork here, a
reader's fork (`isStrangerPull`, `src/crew/stranger.ts`). A trusted source
(`docs/features/trusted-sources.md`) is no stranger: a person named it.

What happens to one:

- **On an autonomous repository the crew filters it.** The crew's reviewer
  is sent the pull as it opens (`pull.opened` in `src/crew/dispatch.ts`), and
  each new head after (the review sweep, `sweepReviews`), without waiting for
  a green check: its code has not run here. The reviewer is told so
  (`STRANGER_REVIEW` in `src/crew/brief.ts`): read the diff, never run it.
  Two review runs with no verdict and it waits for a person (`STRANGER_TRIES`).
- **Anywhere else it waits for a person.** The crew leaves a waiting guest
  alone (`docs/features/guest-pulls.md`).
- **It never lands on its own.** Autonomy lands only the crew's, a writer's
  or a trusted source's work (`landsOnItsOwn`, `src/crew/direct.ts`); a
  person lands a stranger's.
- **It never lands while it changes a guarded path, whatever any review
  says.** `mergePull` and `landSlice` (`src/actions/`) read git's diff
  between the base tip and the head and refuse with
  `{ kind: "guarded", paths }`, each path with why: secrets or credentials,
  permissions or the contract's walls, release machinery (the path rules are
  `fold_walls.ts`'s, one list), and `forge.json` only where its `check` or
  `release` lines (top level or under `app`) change. A diff git cannot read
  is guarded. Nothing the author sets (labels, title, branch) moves it. The
  head judged is the head that lands: a push in between refuses the merge
  (`head_moved`). A person who can write may make the same change themselves.

The pull page (`strangerCard`, `src/web/pages/pull-guest.ts`, one card with
the guest's notice and approval) tells the author what happens next in one
sentence (`strangerNext`); the terminal's pull screen shows the same sentence
on a `next:` line before any merge is tried, and its guest note says the crew
reviews it first on an autonomous repository. The web, the API
(409 `guarded`, its `message` and `paths`), MCP and the terminal all name the
paths when a merge is refused.

`test/stranger-pull.test.ts` proves each: the automode review, the wait,
and each guarded path refused.
