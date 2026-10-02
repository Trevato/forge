# Audit: many humans and many agents (#385)

Read from the code on `main`; each gap is an issue, and #385 waits for them.

| Area | Finding | Issue |
| --- | --- | --- |
| Claims, hand-offs | Reassigning never releases the previous agent's run | #413 |
| Review gate | No code queues a `review` run; autonomous landing ignores the author | #414 |
| Attribution | A pull names the agent, not the person who told; the commit names neither together | #415 |
| The map | A dropped blocker frees its dependents; no close reason | #416 |

Read and found sound, no issue: token scope floors (`core/tokens.ts`) and org
access as the highest team permission (`core/orgs.ts`, `orgAccess`). An agent
cannot assign, and a person's comment reaches the builder through `route()`.
