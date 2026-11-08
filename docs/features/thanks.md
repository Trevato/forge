# The thank-you note

When a pull whose author lives elsewhere lands, its author gets a note on the pull. It thanks them by name, links the
landing commit and says what changed between their head and the base on the way (`src/origins/thanks.ts`, called by
`mergePull` in `src/actions/pulls.ts` after the landing).

**Who is thanked** (`whomToThank`), first match wins:

- a pull brought in from the read-only mirror (`mirror-pulls.ts`) thanks its author by their name there, bare
  (`tdobbertin-espo`), so it never mentions a user here who happens to share the name;
- work from another forge (a `pull_source` row) thanks `account@host`;
- a fork a person keeps thanks its owner as `@user`, which notifies them.

**Who is not thanked:** a pull written by an agent (a crew pull), and a pull made inside the repository.

**What the note says:**

- `Thank you, <name>: pull #N landed in <commit>`, with the commit linked when the forge knows its URL;
- how many commits by whom touched how many files, and whether it landed as a merge (so `git merge main` on their
  side stays clean) or was squashed into one commit;
- what changed from their head on the way:
  - the slices that landed before the last one (`Slice-of` merges on the base);
  - every merge of the base into their branch, which is where conflicts were resolved;
  - a squash that made several commits into one.

  When none of these happened, the note says it landed as they pushed it.

**Once per landing.** A pull that already carries a note by the person who landed it, naming the landing commit,
gets no second note (`landingThanked` in `src/core/issues.ts`). A comment anyone else posts that looks like the note
does not count, so it cannot suppress the real one.

**The copy on the origin pull.** For a pull brought from the mirror, the same note is posted as a comment on the
mirror pull, through the mirror's provider (`thankOnOrigin`). It is sent after the merge answers, so a landing never
waits on another host. A failure is logged as a warning and nothing is retried.

For work from another forge (`pull_source`), the note is written only on the pull here: the forge does not store
which pull it came from on the other side, so there is nowhere to post the copy.
