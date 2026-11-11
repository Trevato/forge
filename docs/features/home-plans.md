# Plans on the home

Where a visitor sees what a hosted forge is and how to get one (#11139).

## Where

- Web: the signed-out home, section **Get your own forge** (`/#yours`): one line per plan, then one **Get a forge** button to `/forges/new`, then the free, open-source way to run it yourself (the guide link and the clone commands).
- Terminal: the palette's **Get your own forge** (`src/tui/screens/getforge.ts`), offered to everyone, guests included: the same plans, `Get a forge: <origin>/forges/new`, and the clone commands.
- `/llms.txt`: the "Get your own forge" line points at the plans on the home and at `/forges/new`.

## What a plan line says

The plan's name, its price, the machine it runs on (CPU, memory, disk) and its own sentence. The words are `src/billing/plan_words.ts`, shared by both doors. A plan whose size has a [buy link](billing-links.md) also shows "Pay for <plan>".

The plans themselves are the forge's plans setting (`src/settings/plans.ts`; edit them at `/admin/limits`, the palette's *Plans*, or MCP `limits`).

## FORGE_BILLING_PROVIDER

Which payment provider the forge sells through, read on every request (no restart needed):

| value | what the plans show |
| --- | --- |
| `stripe` | each paid plan's monthly price, e.g. "$19 a month"; the free plan reads "Free" |
| unset, `none`, or anything else | no price: a paid plan reads "Paid", the free plan "Free" |

It only changes what is shown; it charges nothing by itself.

## Cost

The home reads who may sign up, the plans and the buy links in one statement (`src/settings/door.ts`), so the section adds no query to the page's statement budget. A stored value that does not parse reads as its default.
