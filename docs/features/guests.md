# How a person with no account gets in to contribute

**Status: recommended, not yet chosen.** The owner said on #9428 (2026-11-05)
that both a forge of one's own and a guest account here should work. This page
lays out the options and their costs so a person can pick the order. The choice
is recorded at the bottom once the owner or a writer comments it on #9573.

Signup on the root forge is invite-only (the `signup` setting is `invite`, and
the static gate `forge-signup-gate` in front of `/signup` serves the
invite-only page). A stranger who finds a public app and wants to change it has
no way in. Three ways could give them one.

## What exists today

- `src/core/roles.ts`: a guest can read, comment and **contribute** (fork a
  public repository and send a pull for review). A guest cannot make
  repositories, run a crew or administer. See `docs/ROLES.md`.
- `docs/features/guest-pulls.md`: a pull from another forge is a guest pull. Its
  preview gets no variables or forge token and the crew does not review it
  until a writer approves it once. Checks never carry secrets.
- The `signup` setting (`open`, `invite`, `closed`) and invite links
  (`docs/OPERATING.md`).
- `/forges/new` and the MCP tool `spawn` give a person a forge of their own.

## Option A: their own forge, and a guest pull from it

The person runs or is given their own forge, forks the public app there, and
sends a pull across. It arrives as a guest pull.

- **For:** no account on the root forge at all, so nothing new to abuse here;
  the pull path and its guards already exist; the person owns their work.
- **Risks:** the highest bar for a newcomer ("run a forge" is not a grandma
  step); a forge needs a machine or hosting, and hosting is not shipped; the
  forge is unknown to us, so every pull is from an unvetted origin, which
  writers must approve one by one.
- **Cost to build:** low. A clear page that says how, plus the one-command
  deploy (#9571).

## Option B: an invite request

A stranger asks for an invite on `/signup`: a name and a reason. A person (or
the crew on automode, as a filter only) approves, and an invite link is sent.

- **For:** keeps signup closed to bots; every account was looked at once; fits
  the invite model already in place.
- **Risks:** a person must answer every request, so it scales with attention
  and goes stale when nobody is looking; the form is a spam target (needs rate
  limit and validation at the boundary); waiting kills a gamer's momentum; the
  request text is untrusted input a reviewing agent must not follow.
- **Cost to build:** medium. A request table, an admin list, a limit, and
  notice to the owner.

## Option C: a guest account limited to forks and pulls

Signup opens for guests only. A guest gets the `contribute` ability already in
the roles table: fork a public repository, send a pull. Nothing else.

- **For:** the shortest path for a stranger and the one that matches "get users
  using it"; the role already exists, so a guest is already refused crew runs,
  apps and administration.
- **Risks:** open signup invites bots and storage abuse. Needed first, in this
  order: a storage quota per guest, a low rate limit on signup and on pulls, no
  crew runs and no apps for a guest, guest pulls reviewed by the crew on
  automode and by a person otherwise, and a stranger's pull barred from
  secrets, credentials, permissions and release machinery (#9575). Only then
  may the static `forge-signup-gate` be removed, which is an owner-visible
  switch. Opening `signup` to everyone also lets a guest see what members see
  of public pages, so the limits above must hold before the switch.
- **Cost to build:** the highest: quota, limits, a guest-only signup path (the
  `signup` setting has no "guests only" value today), and removing the gate.

## What the crew recommends

**C, with A as the standing alternative on the same page, and B not built.**

1. Say both ways plainly on every public app and repo: "make an account to send
   a change" and "or use a forge of your own". No one is taught anything;
   the page says what happens to their pull.
2. Build C in this order: quotas and rate limits, the guard on a stranger's pull
   (#9575), the guest-only signup value, then the owner removes the gate.
   Until the limits exist, signup stays invite-only and A is the only way in.
3. Do not build B. It adds a queue a person must tend and is slower than C for
   the same protection, which C gets from limits and review.

If the owner would rather not open signup yet, A alone is safe today; it costs
only the clear page and #9571.

## What this decides for the work that follows

- #9574 (a stranger's path to a first pull) builds the page for A and C.
- #9575 (a stranger's pull is filtered and guarded) is needed before C opens.
- No code changes with this page.

## Decision

Not yet recorded. When the owner or a writer comments the choice on #9573, add
it here: the option, the date, who chose it. The issue is closed only then.
