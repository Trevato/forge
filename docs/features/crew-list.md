# The crew list

A forge admin sees who is on the crew, and whether anything will run their work, in two places.

- **Web: Settings → Crew** (`/settings/crew`, `crewPage()` in `src/web/pages/crew.ts`). One heading, then the readiness words first: "… is ready to run the crew", or a red notice saying no runner is up, the runner cannot run, or agents' shells are unsandboxed. Under it the agents (model, budget, runs, landed, spent, with Edit and Retire), the scorecards, and the New agent form, which posts to the same route as before. With no agent, one sentence says so. A non-admin gets 404.
- **Terminal: the Crew agents screen** (`src/tui/screens/agents.ts`). Each agent's roles, model, budget and the first line of its brief; `n` creates one, `m`, `b`, `B` and `r` change it, `d` removes it, each after a confirm.

Readiness is the web page's alone: the runner is detected once at boot, and the page says so before an issue is assigned rather than after it waits. `test/crew-language.test.ts` holds the page's shape.
