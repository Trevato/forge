### 6e·1. Reviews, threads, and the merge gate

A pull is judged in three places, and each says one thing.

**The verdict (`R`).** A card with three radios and an optional note —
`( ) approve  ( ) request changes  ( ) comment`, `ctrl+d` submits. Approve is
**absent** when the viewer wrote the change, because `submitReview` refuses it
(`self_review`) and a disabled control would only be a slower way to be told
no. A verdict renders in the conversation as a timeline item with a state chip
(success / danger / muted), and it is recorded against the head it was passed
on — so a push dismisses it and the item wears `before the latest push` in
muted rather than quietly still counting.

**The gate.** The merge box grows a second line saying where the verdicts
stand: `2 approvals · changes requested by bob`, and `N dismissed by a push`
when a push has cleared some. When the reviews do not let it land the box
reads `review` in `attn` and `m` says the reason out loud rather than doing
nothing:

```
╭─ Merge ──────────────────────────────────────────────────────────╮
│  review  Needs an approval of this head before it can merge      │
│ no approvals yet                                                 │
╰────────────────────────────────────── fix › main · 1 file +1 -1 ─╯
```

That is a rendering of `reviewGate` (`core/pulls.ts`) and nothing more: an
outstanding request for changes blocks whatever the setting says, and
`require a review before merging` (repo settings, `R`) additionally demands an
approval of the current head. The refusal is mechanical in `mergePull`, which
reads the gate from the live head — a check computed earlier and handed down
is a check that can be skipped.

**Threads.** Review comments sharing one anchor are one conversation. In the
files tab the section header reads `3 threads · 1 unresolved`; `x` settles or
reopens the thread the cursor is standing on (a writer, or whoever raised it);
`n`/`p` walk the unsettled ones while the cursor is inside one, and go back to
walking hunks when it is not. A settled thread collapses to a single dim line
— `✓ resolved by alice · 2h · enter to expand` — because the point of settling
something is to stop looking at it, and `enter` opens the record back up
because the point of a record is that it is still there. Standing on the diff
line a thread hangs from counts as standing on the thread: that is what a
reader means by "this one".

A pull list row wears the same verdict in one tabular column — `✓` approved,
`✗` changes requested, `·` nobody has looked — read for the whole page in one
grouped query, never one per row.
