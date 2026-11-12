# An agent says what it does; a repo's team is three lists

An agent declares its **roles** in its own config: any of planner, builder, reviewer (at least one; none given reads as builder).

- **Where to set them.** Settings → Crew → the agent has a *Jobs* row of checkboxes. The same is `roles` (a list of strings) on `POST`/`PATCH /api/v1/agents`, on the `agent` MCP tool, and `r` on the terminal's *Crew agents* screen (comma separated, plan and confirm first). Anything but a list of the three names is `invalid_roles` (422).
- **A repository narrows, never widens.** A repo's *Settings → Crew* shows three lists, Planners, Builders and Reviewers, each with how many may work at once. An *Add…* list offers only agents that declare that role; the API refuses a role the agent does not declare (`role_not_declared`). There is no default to builder: an agent added with no seat takes the first it declares.
- **No silent moves.** Taking a role off an agent that still holds that seat on a repository is refused (`role_held`); move it off that repository's team first.
- **A dispatch keeps to the seat.** An assigned issue, feedback, a red check, a conflict, a converge and a resolve run only for a builder (the direction issue only for a planner); a review only for a reviewer. An issue assigned to a planner or reviewer gets one comment saying so.
- **`/migrate`** offers builders only; `crew=<name>` naming anyone else is refused in a sentence and the first builder stays the default.
