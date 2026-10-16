# Roles

An account is a **guest**, a **member** or an **admin**. Admin is the
`is_admin` flag; a member is a row in the `member` table; everyone else is a
guest. `src/core/roles.ts` holds the one table below, and `test/roles.test.ts`
fails if this copy differs from it.

Part 1 (#2301) shows and records roles. Part 2 (#2302) enforces two rows of
the table: a guest cannot create or fork a repository, make an app their own
(both are "make an app their own"), or start a crew run (assign an agent, queue
a run again, ask the crew to resolve a conflict). The refusal reads "the owner
has not made this account a member", on the page, in the API (`403 not_member`),
in MCP and in the terminal. It is asked last: an unverified account is told to
verify, a suspended one is refused, an agent and a stranger to a private
repository meet their own reasons first. A comment from a guest is still a
comment; it just starts no run. Agents and organizations are not guests.

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

<!-- roles-table -->
| Ability | guest | member | admin |
| --- | --- | --- | --- |
| Read what is public | yes | yes | yes |
| Comment and open issues | yes | yes | yes |
| Make an app their own | no | yes | yes |
| Run a crew on a model allowance | no | yes | yes |
| Administer the forge | no | no | yes |
<!-- /roles-table -->
