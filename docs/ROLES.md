# Roles

An account is a **guest**, a **member** or an **admin**. Admin is the
`is_admin` flag; a member is a row in the `member` table; everyone else is a
guest. `src/core/roles.ts` holds the one table below, and `test/roles.test.ts`
fails if this copy differs from it.

Part 1 (#2301) shows and records roles. Nothing is refused because of a role
yet: the table says what each role is meant to do once later parts enforce it.

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
