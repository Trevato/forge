# The studio

Two ways of seeing one forge. **Studio** is the default: apps are the unit,
and a person does three things to one — tell the crew, look at what it
made, decide when it asks. **Dev** shows the git underneath — code,
commits, branches, runs — unchanged. The switch is in the top bar and is a
cookie on that browser; the URLs are the same in both, so a link works
whichever way its reader sees.

## Five words

Every word on a studio page is one thing in git, and dev mode shows it.

| studio says  | git underneath                                          |
| ------------ | ------------------------------------------------------- |
| **tell**     | an issue, assigned to a builder by the routing decision |
| **working**  | a run, streaming its log                                |
| **look**     | an open pull with a green check and a preview           |
| **shipped**  | a merge to the default branch, production redeployed    |
| **asks you** | a pull the crew stopped on, or a green one for a look   |

These are also a kanban board: tell is the backlog, working is in progress,
look is review, shipped is done, asks you is blocked. The crew's slot count
(**Settings → Autonomy**) is the WIP limit. The map is the plan. A week's
level-and-flow chart on the map is the cycle. Green check, preview, merged
is the definition of done. None of that needs its own vocabulary on the
page: the studio only offers principled moves.

## The app

An app's home in the studio (`/:owner/:name`, when the repository is an
app) shows, top to bottom: what it serves and where; the box; what asks
you; what is happening now. Beside it, who is on the crew and what each is
for, this week's numbers (shipped, runs, spend, spend per shipped change),
and how the repository runs itself, when it does.

**The box** is the front door. A sentence becomes an issue — the first line
its title, the rest its body — and the routing decision hands it to a
builder: the builder with the least in flight, then by name. That is one
fixed-choice function (`crew/autonomy.ts`, `pickBuilder`), the place a
faster or wiser decider plugs in. The run starts on the crew's next tick,
and the page shows it waiting, then working.

**Asks you** is every parked question a person has to answer, three
sentences each with the real options in place. A pull the crew stopped on
— red past the crew's own limit since a person last spoke — offers _tell
them what to try_ (a comment, which starts a feedback run), _close it_,
and _see the change_. A green pull waiting for a look offers _open the
preview_, _ship it_ (a squash merge, as you, with your review and check
requirements enforced inside it), and _not like this_ (a comment). A
repository paused at its ceiling says so, with the way to settings. Nothing
here re-queues anything: a re-queue button is what an operator presses
instead of deciding.

**Now** lists what was told and not yet picked up, every open pull with its
state, and the last runs, each in one of the five words with who and when.

## The home

`/` in the studio: what asks you across every app you can land, what is on
you (issues and pulls a person assigned to you), and your apps — each with
whether it is live, what the crew last did there, and a way in. **New app**
is the same flow as ever. `/?mode=dev` is the repositories list without
switching the browser.

## What the studio never does

It never says _shipped_ before production redeployed, never hides that a
run cost money, never shows a preview that is not the pull's real head, and
never invents an answer for a card. The complexity is removed from the
surface, not from the system.
