# Landing a fork's pull in slices

A pull from a fork too long to review in one piece lands in slices (#9010).
Each slice is a range of the author's own commits, from what the base already
holds up to one commit you pick, merged with its own merge commit. Nothing is
rebased or squashed, so every commit of theirs becomes an ancestor of the base
and their next `git merge` of it is clean or a fast-forward.

- **On the page**: the pull's Files tab has a Slices card; a person who may
  write lands from it (an agent proposes and does not land). Pick a commit
  (the oldest are listed first) and press *Land slice*; in the terminal, `S`
  on the pull does the same. The card lists the slices that landed and how
  many commits are left.
- **The last slice** is the author's head: picking it merges the pull through
  the ordinary merge, with its review and checks gate, and closes it.
- **Through the API**: `POST /api/v1/repos/{owner}/{name}/pulls/{number}/slices`
  with `{"upTo": "<commit oid>"}` answers `{mergeOid, last, left}`; a commit
  that is not one of the pull's the base lacks answers 422 `bad_slice`.

A slice's merge commit carries a `Slice-of: #N` trailer; the card reads the
landed slices back from the base's history, so there is no separate record to
drift.

Every slice passes the gate the whole pull would: a standing hold refuses it
(409 `held`), and so do a head review that does not let the pull land and a
head check that is red — or, where the repository requires checks, missing or
run against an older base (409 `review_required` / `checks_required`). The
head is what was reviewed and checked, and a slice is an ancestor of it. Only
a pull from a fork lands in slices; a branch of the repository itself answers
422 `not_fork`.
