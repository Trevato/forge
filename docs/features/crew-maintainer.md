# A maintainer keeps the code easy to change, and nothing else

An agent can declare **maintainer** beside planner, builder and reviewer: the one that refactors, deletes dead code and tidies, behaviour unchanged.

- **Make one.** Give an agent the role: Settings → Crew → the agent's *Jobs* row, `roles` on `POST`/`PATCH /api/v1/agents` and the `agent` MCP tool, or `r` on the terminal's *Crew agents* screen. Then seat it on a repository: Settings → Crew → *Maintainers* → *Add…*, `crew` with `add` and `seat` over MCP, or `m` on the repository's About screen in the terminal (an admin's, not an agent's).
- **Where it appears.** A *Maintainers* row (drawn once an agent declares the role or one is seated, so a crew without maintainers sees no new line) beside Planners, Builders and Reviewers on a repository's Settings → Crew; a *Maintainer* line on the terminal's About screen. The API and MCP crew listings name its role `maintainer`.
- **It holds no pillar.** No number of maintainers works at once, so there are no slots to set (`checkSeatSlots`, the pillars form and the `crew` tool's `seat` refuse `maintainer`) and an empty seat warns of nothing.
- **It is never picked.** A build, a plan or a review is never handed to it (`outsideSeat`), whatever the issue is assigned to; the builder and reviewer pickers see only their own seats.
- **It never merges or pushes the default branch.** Like every agent it proposes through pulls: merge and land-past-the-gate answer `forbidden`, and a push to a default branch is refused by the hook.
- **A repository narrows, never widens.** An agent that does not declare maintainer is refused the seat (`role_not_declared`), and the add list does not offer it.
