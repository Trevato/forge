# Forge it

A **Forge it** button (rocket icon, outline weight, so it is not mistaken for Fork) sits beside Fork on every repository page, for any signed-in person. One press makes a fresh forge named for the repository (`Bakery_Shop` becomes `bakery-shop`) with that repository as its app, and sends the browser straight to the new forge's claim link. The claim code rides the URL fragment, so there is nothing to copy; choosing a username and password there signs the person in as the new forge's admin.

- Terminal: the repository screen's palette (`:`) has `Forge it`; a confirm, then the claim link once (`src/tui/screens/forge_it.ts`). Both doors share `src/spawn/forge_it.ts`.
- Route: `POST /:owner/:name/forge` (`src/web/pages/forge-it.ts`), same-origin and `admin`-scoped like `POST /forges/new`, which it calls through the spawn door with the defaults.
- A private repository is forged only by those who can read it. Limits (children per forge, rate) are the spawn door's.
- Pressing it twice makes one forge: the second press goes to `/forges`, and the link is not shown again (ask for a new one there).
- Agents: the same thing is MCP `spawn` / `POST /api/v1/forges` with `apps: ["owner/name"]`.
- Tests: `test/tui-forge-it.test.ts` for the terminal; `test/forge-it.test.ts` walks press, claim, signed-in admin, files.

Not here: a hosted child's crew runner (#4416), arriving signed in with no claim form (#2928), choosing a template (#7534, #7535).

Direction: this is a feature ahead of the pipeline-first order only in being a small door onto the spawn path that already exists; it adds no pipeline code. The owner asked for it on #7642.
