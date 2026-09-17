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

## The board

`/board` is the home's _Happening now_ as a wall for a second monitor
(**Focus** on that card opens it): no top bar, dark unless you chose a
theme, four regions that fill the window. **Working now** is one card per
run in flight — who, which app, what it is on, why, how long, what it has
cost — ordered by when it started. **Landed** is the last dozen shipped
changes across your apps, each with the app's production look on a phone.
**Decided** is the last dozen entries in the decision ledger: which issue
next, ship or show, try again — the answer, how sure the decider was, and
what came of it. **Today** is one row per app that runs on its own: spend
against the ceiling, runs, shipped, and whether it is paused. Every region
is live — it swaps itself when a matching event lands, and the dot in the
corner says whether the stream is connected. `?apps=a,b` narrows it to some
apps. Keys: `f` fullscreen, `1`–`4` one region full-bleed, `0` all.
Everything links somewhere; nothing needs a click.

## The big view

`/big` is the whole forge as one full-screen, keyboard-first frame, with
the feel of k9s, lazygit and btop — a second front door, not a re-skin.
One header line (the forge, where you are, the clock, the live dot), a
body of panes that fill the window and scroll on their own, and one footer
line of key chips for the view you are in. Dark unless you chose a theme.
Every pane is a live region: it swaps itself in place when a matching
event lands, and the focus stays on the row it was on.

**Home** (`/big`) is every app you can see as a row — name, how it runs
itself, how many are working, how many asks wait, today's spend against
the ceiling — and beside it the focused app at a glance: the direction's
first line, who is working on what, the last three landed, the last three
decisions. **App** (`/big?app=owner/name`) is four panes: working now
(each run with its clock and cost), asks you (with the keys that decide
them), the map panned to where the crew is, and landed. `r`, `i`, `p` and
`m` open the runs, issues, pulls and the map alone as simple lists.
**Run** (`/big?run=id`) is the transcript, followed, with the steer line
under it. **Board** (`/big?view=board`) is the wall's four regions,
focusable. **Map** (`/big?view=map`) is every app's lane; `j`/`k` move
between lanes and `enter` opens the app.

The keys are the same everywhere, and `?` shows the sheet for the view:

| key                         | does                                                   |
| --------------------------- | ------------------------------------------------------ |
| `h` `j` `k` `l`, the arrows | move: `j`/`k` down and up a pane, `h`/`l` across panes |
| `g` / `G`                   | top / bottom of the pane                               |
| `ctrl-d` / `ctrl-u`         | half a page                                            |
| `tab`, `shift-tab`, `1`–`9` | the next pane, the previous, a pane by number          |
| `enter`                     | open the focused thing                                 |
| `esc` / `backspace`         | back one level                                         |
| `o`                         | open it in the web UI, in a new tab                    |
| `:`                         | the command line                                       |
| `/`                         | filter the pane as you type                            |
| `?`                         | the key sheet                                          |
| `f`                         | fullscreen                                             |
| `s`                         | ship the focused green pull                            |
| `x`                         | stop the focused run, close the focused ask            |
| `t`                         | tell: the crew, the focused ask, or steer a run        |
| `r` `i` `p` `m` (in an app) | runs, issues, pulls, the map                           |

The command line takes `:app <name>` (or just `:<name>`), `:home`,
`:board`, `:map`, `:runs`, `:issues`, `:pulls`, `:help` and `:q`, which
leaves for the web UI. A gamepad works too: the d-pad and left stick move,
A opens, B goes back, Y is the sheet, the bumpers switch panes, start is
`:` and select is `/`. Every key presses a real control on the page — a
row's link, a row's button, a chip in the footer — so the sheet can never
promise what the page does not have. Nothing on it animates on its own:
the clock ticks once a second, and the rest waits for a key.

## What the studio never does

It never says _shipped_ before production redeployed, never hides that a
run cost money, never shows a preview that is not the pull's real head, and
never invents an answer for a card. The complexity is removed from the
surface, not from the system.
