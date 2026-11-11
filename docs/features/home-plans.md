# Plans on the home

Where a visitor sees what a hosted forge is and how to get one (#11139).

## Where

- Web: the signed-out home, section **Get your own forge** (`/#yours`): one line per plan, then one **Get a forge** button to `/forges/new`, then the free, open-source way to run it yourself (the guide link and the clone commands).
- Terminal: the palette's **Get your own forge** (`src/tui/screens/getforge.ts`), offered to everyone, guests included: the same plans, `Get a forge: <origin>/forges/new`, and the clone commands.
- `/llms.txt`: the "Get your own forge" line points at the plans on the home and at `/forges/new`.

## What a plan line says

The plan's name, its price ("Free", or "$19 a month" from the plan's `priceUsd`), the machine it runs on (CPU, memory, disk) and its own sentence. A paid plan with a crew credit adds the credit after that sentence: "$5 of crew credit each month", from the plan's `creditUsd`. The words are `src/billing/plan_words.ts`, shared by both doors.

A paid plan whose size has a [buy link](billing-links.md) also carries a "Get <plan>" link to it (on the web an anchor beside the price, in the terminal `Get <plan>: <link>`); the free plan never does, its way in is the one **Get a forge** button. When any plan carries a link, one line follows the plans on both doors: "Your forge is made after payment; an email with the link to open it arrives." (`AFTER_PAYMENT` in the same file).

Whether this forge takes new accounts is not said in this section: it is about getting a forge, not an account here.

The plans themselves are the forge's plans setting (`src/settings/plans.ts`; edit them at `/admin/limits`, the palette's *Plans*, or MCP `limits`).

## Cost

The home reads who may sign up, the plans and the buy links in one statement (`src/settings/door.ts`), so the section adds no query to the page's statement budget. A stored value that does not parse reads as its default.

## When the crew has no credit

A forge whose crew has no key and no included credit says so once on its first screen: "The crew cannot build until you add a model key or pick a plan." (`NO_CREDIT_WORDS`, `crewFirstLine` in `src/web/studio/crew_key.ts`; the terminal's first screen says the same line as text, `crewFirstText`, with credit too). The key is a link to `/settings/subscriptions` (admins), the plan a link to `/pricing`, the plans on a page of their own (`src/web/pricing.ts`). With credit the line is the next step: make an app or bring a repository. A tell sent with no credit is kept, and the flash says the crew cannot build yet, with the same two ways forward; that holds for the first screen's own box (`app=forge`, kept as a thought) as for a tell to an app. `/pricing` has no terminal screen: its door there is the palette's *Get your own forge*.
