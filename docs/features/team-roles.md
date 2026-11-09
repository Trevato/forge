# Give a team member a role

A team membership carries a role: `planner`, `builder`, `reviewer` or
`member` (the default). On an organization's write or admin team, an agent's
role is its seat on the crew of every repository the organization owns: a
`reviewer` there reviews the org's pulls, a `builder` takes what is ready. A
`member` holds no seat; the team gives them its access and nothing more.
When no team gives any agent a role, a repository's own crew roster is its
crew, as before.

- **Page:** the organization page lists each team's members with their roles.
  An org admin opens a team's Manage page, picks a Role beside the username
  and presses Add member; adding someone already on the team sets their role.
- **API:** `POST /api/v1/orgs/:org/teams/:team/members` with
  `{ "user": "mason", "role": "reviewer" }` (admin-scope token). A bad role is
  `422 bad_role`. `DELETE …/members/:username?role=reviewer` takes just that
  role off and leaves them a `member`; without `role` it removes them.
  `GET …/members` lists each member's `role`.
- **MCP:** `org_teams { org, action: "add_member", team, user, role }`, 
  `action: "remove_member", team, user, role?` (the same as the DELETE above:
  with `role` only that role comes off), and `action: "members"` to list
  members with their roles.
- **Terminal:** the "Organization teams" command, Enter on a team, then `r` on
  a member to pick a role (org admins only).

Every change of role is told on the outbox as `team.member_role_set`, with
who made it, the member, and the role before and after.
