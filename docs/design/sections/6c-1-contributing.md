### 6c·1. Contributing: fork at the origin, propose a change

The workflow the origins layer exists for — _grab their repo, branch, edit,
propose it back_ — is one intention, so it is two keys and one action call
(`actions/contribute.ts`), never five screens with five half-finished states
between them.

**`F` — fork at the origin.** On a live browse (and on the picker's rows) `F`
forks at the origin rather than here: a local fork of a mirror is a copy of a
copy with nowhere to propose it back to. One confirm card, saying the whole
sentence because two machines are involved —

```
╭─ Fork at the origin ───────────────────────────────╮
│ Fork octo/widgets to your account                  │
│ at codeberg.org and mirror it here?                │
│                                                    │
│ The copy here is your workbench.                   │
│                                    Cancel  ▸ Fork  │
╰────────────────────────────────────────────────────╯
```

— then the ordinary mirror card over the job the fork started, then the fork's
own workspace. A native repository keeps the native fork. Wherever a
repository forks something at an origin, the where-strip and the about card
say so: `· fork of octo/widgets`, read from `repo.origin_fork_of` on a mirror
and from the picker's cached `fork_of` on a live browse.

**`c` — propose a change.** When the source says `permissions.push === false`
— a live browse of somebody else's repository, or a mirror whose upstream is
not ours to push to — editing is allowed and the commit dialog becomes a
proposal dialog. Same buffers, same ticked files, no "commit to `<ref>`"
option (there is no ref of theirs you may write), and a branch that lands in
your fork:

```
╭─ Propose a change ──────────────────────────── octo/widgets ─╮
│ Message                                                      │
│ Update README.md                                             │
│ optional — this becomes the pull request's body              │
│ Files · 1 of 1                                               │
│ [x] ~ README.md                                              │
│ Branch in your fork                                          │
│ alice/edit-README-md                                         │
│ Pull request › octo/widgets · main                           │
│ Update README.md                                             │
│   Propose                                                    │
╰──────────────────────────────────────────────────────────────╯
```

`contribute` does the rest in one call: fork if a fork is needed, branch from
the _upstream's_ base rather than a stale copy of it, commit into the fork,
push it there, and open the pull upstream with the `owner:branch` head form
both forges take. The toast reads `opened pull #12 on octo/widgets`, and when
we hold a mirror of that upstream the imported pull is pushed on the stack so
the reader lands on what they just proposed. **A refusal keeps every buffer**
and names which half failed — `fork_timeout`, `origin_refused`,
`mirror_failed`, an edit reason, or "the commit landed but the pull did not
open". While such a workspace is open the status row says
`proposing to octo/widgets via your fork`, on every frame, so nobody has to
press `c` to find out where their change is going.

A repository the origin says you _may_ push to keeps the ordinary commit
dialog: on a mirror that is `editFiles` plus push-through, which is
`contribute`'s own `via: "direct"` path by another name.
