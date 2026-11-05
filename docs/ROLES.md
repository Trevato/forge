# Roles

An account is a **guest**, a **member** or an **admin**. Admin is the
`is_admin` flag; a member is a row in the `member` table; everyone else is a
guest. `src/core/roles.ts` holds the one table below, and `test/roles.test.ts`
fails if this copy differs from it.

Part 1 (#2301) shows and records roles. Part 2 (#2302) enforces the table: a
guest cannot create a repository, make an app their own, or start a crew run
(assign an agent, queue a run again, ask the crew to resolve a conflict). The
refusal says the account is a guest and what a guest can do instead, on the
page, in the API (`403 not_member`), in MCP and in the terminal. It is asked
last: an unverified account is told to verify, a suspended one is refused, an
agent and a stranger to a private repository meet their own reasons first. A
comment from a guest is still a comment; it just starts no run. Agents and
organizations are not guests.

## Helping build a public repository

A guest with a confirmed email can press **Help build this** on a public
repository. This makes a contribution fork (`src/core/contribute.ts`): a public
fork, marked in the same database write that creates it. The guest can do these
things with it:

- Push to it, or commit to it through the page, the API or MCP.
- Open a pull from it to its parent. A guest cannot open a pull from anywhere else.
- Delete it.

`canAdmin` answers no for the fork, so the guest has no settings, secrets,
webhooks, app or crew on it. Nothing runs for it: `checks/service.ts`,
`apps/runtime.ts` and `crew/dispatch.ts` each refuse a contribution fork. A
guest cannot fork a private repository, a mirror, an archived repository or
another guest's fork. An admin who promotes the guest makes the fork an
ordinary one.

A guest's pull is a guest pull (`src/origins/guest.ts`):

- Its check and preview run only on a head that a person who can write the
  repository approved (`src/core/pull_trust.ts`). A new push waits for a new
  approval.
- Its preview holds no app variables and no forge token until that person also
  approves the guest.
- The crew does not review it and does not land it on any repository, autonomous
  or not. It waits for a person.
- Its page names any path it touches among secrets, credentials, permissions,
  the contract and release machinery (`src/crew/fold_walls.ts`).

## Guest limits

Each limit is on `/admin/limits`, and each refusal says what to do next.

| Limit | Default | Refusal |
| --- | --- | --- |
| Forks one guest may make a day (`guest.forks_per_day`) | 3 | `guest_forks_today` |
| Guest forks on the whole forge a day (`guest.forks_forge_per_day`) | 50 | `guest_forge_forks_today` |
| Pulls one guest may send a day (`guest.pulls_per_day`) | 5 | `guest_pulls_today` |
| Storage in all of one guest's forks (`guest.storage_mb`) | 100 MB | `guest_storage`, or the push is refused |
| Storage in one guest fork (`guest.fork_storage_mb`) | 50 MB | The push is refused |
| Minutes before a first fork or pull (`guest.cooldown_minutes`) | 10 | `guest_cooldown` |
| New accounts per address an hour (`signup.per_source_hour`) | 5 | `POST /api/v1/users` answers 429 |
| New accounts on the whole forge an hour (`signup.per_forge_hour`) | 60 | `POST /api/v1/users` answers 429 |

A fork borrows its parent's objects, so its cost is what the guest pushes. A
deleted fork gives its storage back but not its place in the day's count. A
person's account can be held to a whole-account storage quota as well.

An admin stops new accounts at once with **Close sign-up now** on
`/settings/security`, which sets the `signup` setting to `closed` for every
door, `POST /api/v1/users` included. The same page counts today's new accounts
and links to them. Turnstile stays optional: set `FORGE_TURNSTILE_SECRET` and
`FORGE_TURNSTILE_SITEKEY` to turn it on.

## What is not covered

The limits count accounts and addresses. Someone with many addresses is held
only by the whole-forge ceilings. A push is capped by its compressed size, so a
small pack that expands when git reads it still costs CPU and memory.

## Admin settings

Part 3a (#2384) enforces "Administer the forge" for admin settings and
releases: every `/admin/*` page, `/api/v1/admin/*` call, and the `/releases`
page with its rollback refuse a member or guest with a 403 and "only an admin
can change the forge's settings or its releases" (`not_admin` in the API).
`src/http/admin_gate.ts` is the one gate, ahead of every handler;
`/releases.json` stays public. Token scopes are a later part.

Nothing switches the refusal off: the test suite runs with it everywhere, and
a suite whose people make things promotes them first (`promote` in
`test/helpers/members.ts`). The crew's wake-up sweep, which starts a run on an
agent-assigned issue that never had one, skips an issue whose last assigner is
a guest, so an assignment made before the guard starts nothing either. A
spawned forge's founder is made a member, so its first boot can hand the
direction to the planner.

On `/settings/people` an admin promotes a guest to member, with a starter
model allowance (dollars a month, default none, through the grant of #1145),
or demotes a member to guest. Demoting leaves any allowance as it is; take it
back on the account's page.

The page states what the roles mean in two sentences built from the table
(`roleLimits` in `src/core/roles.ts`): what a guest cannot do, every row a
member has and a guest lacks, and the admin refusal's own words, so it cannot
say less than the guards refuse (`test/people-role-limits.test.ts`).

<!-- roles-table -->
| Ability | guest | member | admin |
| --- | --- | --- | --- |
| Read what is public | yes | yes | yes |
| Comment and open issues | yes | yes | yes |
| Help build a public repository by forking it and sending a pull for review | yes | yes | yes |
| Create a repository or copy an app | no | yes | yes |
| Run a crew on a model allowance | no | yes | yes |
| Administer the forge | no | no | yes |
<!-- /roles-table -->
