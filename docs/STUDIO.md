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
requirements enforced inside it), and _not like this_ (a comment); its row
leads with the preview as pictured on a phone (`docs/APPS.md`, _The look_),
and the picture opens the pull, where both pictures are. A repository
paused at its ceiling says so, with the way to settings. A pull
the crew is on right now — a run queued or running for it — is working,
not a question, and is not listed until the crew is done with it. An
autonomous app's green pulls are never a question: the decider and the
crew's reviewer look at them, and conflicts with `main` are the builder's
to fix, so what reaches you from an autonomous app is only the day's ceiling;
what the crew cannot finish it parks and re-plans rather than hands to
you. Shipping a pull that conflicts, from any app, sends its agent
to bring the branch up to date rather than handing you the conflict. Nothing
here re-queues anything: a re-queue button is what an operator presses
instead of deciding.

Check several asks and one bar above them offers what fits them all — ship
the green ones, close the stopped ones — as one decision (`POST
/studio/asks`), each done exactly as its own button would have. Deciding
never leaves the page: the row looks busy until it lands, then goes; one
that could not be done stays, with the reason on it.

When a decider is configured, an ask card's own option can carry a **lean**
— a small word (_likely_, _probably_, _maybe_) beside the option a careful
owner would pick, from asking the decider the same question a person is
looking at. The lean is never why the page waits: a card renders with
whatever lean is already known, and a card with none yet is asked for after
the page is on its way to the browser, so the answer is there on a later
render, not this one. A forge with no decider configured shows no lean and
asks nothing, exactly as before deciders existed.

**Now** lists what was told and not yet picked up, every open pull with its
state, and the last runs, each in one of the five words with who and when.
A run in flight carries _Stop_ (running) or _Cancel_ (waiting) for anyone
who can write here; its title opens the transcript, where the agent can be
steered mid-run (see `docs/APPS.md`, _Runs_).

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
