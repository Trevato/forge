# The studio

Two ways of seeing one forge. **Studio** is the default: apps are the unit,
and a person does three things to one — tell the crew, look at what it
made, decide when it asks. **Dev** shows the git underneath — code,
commits, branches, runs — unchanged. The switch is in the top bar and is a
cookie on that browser; the URLs are the same in both, so a link works
whichever way its reader sees.

## Five words

Every word on a studio page is one thing in git, and dev mode shows it.

| studio says | git underneath                                          |
| ----------- | ------------------------------------------------------- |
| **tell**    | an issue, assigned to a builder by the routing decision |
| **working** | a run, streaming its log                                |
| **look**    | an open pull with a green check and a preview           |
| **shipped** | a merge to the default branch, production redeployed    |

These are also a kanban board: tell is the backlog, working is in progress,
look is review, shipped is done. The crew's slot count
(**Settings → Autonomy**) is the WIP limit. The map is the plan. A week's
level-and-flow chart on the map is the cycle. Green check, preview, merged
is the definition of done. None of that needs its own vocabulary on the
page: the studio only offers principled moves.

## The app

An app's home in the studio (`/:owner/:name`, when the repository is an
app) shows, top to bottom: what it serves and where; the box; what is
happening now. Beside it, who is on the crew and what each is
for, this week's numbers (shipped, runs, spend, spend per shipped change),
and how the repository runs itself, when it does.

**Following** comes first when the app is a fork of another: one sentence on
where it stands against what it follows — in step, behind, ahead, or diverged
— and one thing to do about it. Behind, or diverged where git merges cleanly,
is **Take updates**, a click. Diverged where both sides changed the same file
is **Converge with the crew**: a builder merges the parent's branch, keeps
this app's direction where the two cannot both be kept, and the result comes
back as a change to look at, or lands on its own when the app runs on its
own. The words are the studio's; the mechanics are `docs/FOLLOWING.md`.

**The box** is the front door. A sentence becomes an issue — the first line
its title, the rest its body — and the routing decision hands it to a
builder: the builder with the least in flight, then by name. That is one
fixed-choice function (`crew/autonomy.ts`, `pickBuilder`), the place a
faster or wiser decider plugs in. The run starts on the crew's next tick,
and the page shows it waiting, then working.

**Nothing waits on you.** An autonomous app lands its own green changes
once `main` merges cleanly and the wall is clear (`docs/CONTRACT.md`). A
conflict sends its builder to bring the branch up to date; a red check past
the crew's tries parks the issue back on the map for a fresh plan rather
than handing it to you. The one thing that stops a change is the wall — a
contract loosened — and that shows on the pull and in the audit, never as a
queue here. A repository paused at its ceiling says so on its own card,
with the way to settings. Nothing here re-queues anything: a re-queue
button is what an operator presses instead of deciding.

**Now** lists what was told and not yet picked up, every open pull with its
state, and the last runs, each in one of the five words with who and when.
A run in flight carries _Stop_ (running) or _Cancel_ (waiting) for anyone
who can write here; its title opens the transcript, where the agent can be
steered mid-run (see `docs/APPS.md`, _Runs_).

## The home

`/` in the studio: what is on you (issues and pulls a person assigned to
you), and your apps — each with
whether it is live, what the crew last did there, and a way in. **New app**
is the same flow as ever. `/?mode=dev` is the repositories list without
switching the browser.

## The board

`/board` is the home's _Happening now_ as a wall for a second monitor
(**Focus** on that card opens it): no top bar, dark unless you chose a
theme, four regions that fill the window. **Working now** is one card per
run in flight — who, which app, what it is on, why, how long, what it has
cost — ordered by when it started. **Landed** is the last dozen shipped
changes across your apps, each with the app's production look on a phone.
**Decided** is the last dozen entries in the decision ledger: which issue
next, a landing, try again — the answer, how sure the decider was, and
what came of it. **Today** is one row per app that runs on its own: spend
against the ceiling, runs, shipped, and whether it is paused. Every region
is live — it swaps itself when a matching event lands, and the dot in the
corner says whether the stream is connected. `?apps=a,b` narrows it to some
apps. Keys: `f` fullscreen, `1`–`4` one region full-bleed, `0` all.
Everything links somewhere; nothing needs a click.

## What the studio never does

It never says _shipped_ before production redeployed, never hides that a
run cost money, never shows a preview that is not the pull's real head, and
never invents an answer for a card. The complexity is removed from the
surface, not from the system.
