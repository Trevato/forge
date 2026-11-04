# Design audit — 2026-10-19 (#2678): a source-drift report

The owner's words: "a giant pile of interfaces with no apparent reason". This
audit says what is true, what it rests on, and what it does not yet cover.

## What this audit is not

It is a report on drift in the source, **not** a judgement of how the pages
look. It has **no screenshots**, so it says nothing about layout shift, 360px,
contrast or dark mode; the verdicts in Finding 2 are about purpose and overlap
read from code, and are provisional until the sweep (#2690) lands. The agent that wrote it runs in a sandbox that cannot
open a browser or reach a running forge, so the desktop/360px × light/dark sweep
is not here; it is the first item of the plan (#2690) for a run that can. Everything else is read from the source: `src/web/**`, `docs/DESIGN.md`,
and the counts from `bun scripts/design-lint.ts`.

## Finding 1 — the design system exists; the pages left it

`docs/DESIGN.md` already is "one design system": tokens (palettes as data in
`src/design/themes.ts`), a type scale (11.5 / 12.5 / 13 / 14 / 15 / 16 / 20px),
a 4px grid, three radii, one accent, ~70 named components. The clean app
template's advantage is not a better system; it is that it never grew past it.

The forge's own source has drifted, measured today:

| drift                                            | count | where most                                                              |
| ------------------------------------------------ | ----: | ----------------------------------------------------------------------- |
| hex / `rgb()` / `hsl()` literals outside themes  |    95 | `style/content.ts` (23), `studio/home.ts` (7), `pages/looks.ts` (6), `pages/site.ts` (3) |
| `font-size` off the scale (13.5, 12, 11, 10, 22, 18, 72 …) |  67 | `style/content.ts` (31), `style/components.ts` (16), `pages/map.ts` (12), `pages/board.ts` (6) |
| classes defined in stylesheets                   |   619 | DESIGN.md §5 names ~70 components; the rest are page-local              |

619 classes against ~70 documented components is the "pile": most pages grew
their own vocabulary instead of composing the named one.

## Finding 2 — the pages, and what each is for

Every top-level page has one entry here: every static `GET` route in `src/http/server.ts`
that returns a page (`test/design-audit.test.ts` holds this list to the router,
both ways). Each entry reads `route` — module · what it is for · what
duplicates it · what breaks `docs/DESIGN.md`. "Breaks" counts colour literals
(§2) and off-scale `font-size`s (§3) in the module as of
`docs/design/baseline.json`; "none seen" means the lint finds nothing, not that
the page was looked at (no screenshots here). Page-local classes are not
repeated per page: the module's share of the 619 is the stylesheet it uses.

Machine routes are not pages and have no entry: `/audit.csv`,
`/fleet/graph/live`, `/fleet/graph.csv`, `/settings/origins/callback`.

### Home, work and the crew

- `/` — `pages/site.ts` (`home`, studio mode in `studio/home.ts`) · where I am, what needs me · `/front` (same page for anyone), `/board`, `/asks` · colours 3 in `site.ts`, 7 in `studio/home.ts`.
- `/front` — `studio/home.ts` (`studioDoor`) · the signed-out door, and the site admin's controls over it · `/` for a signed-out reader · colours 7.
- `/explore` — `studio/explore.ts` · browse what the forge holds · `/search`, `/apps` · colours 2.
- `/board` — `pages/board.ts` (1,231 lines) · every app the viewer can see, with a wall mode · `/boards` (saved queries as panels), `/flow`, `/` · colour 1, sizes 6.
- `/board/returns` — `pages/returns.ts` · what the window's dollars bought · `/settings/subscriptions` spend tables, `/settings/usage` · none seen.
- `/big` — `pages/board.ts` (`bigRedirect`) · a redirect kept for old addresses into the board's wall mode · it is `/board` · none (no page of its own).
- `/bring` — `pages/bring.ts` · bring an app whole from another forge, with its history, as a private linked app · `/new`, the palette · none seen.
- `/boards` — `pages/boards-view.ts` · saved queries as panels · `/board` · none seen.
- `/feed` — `studio/home.ts` · the composer and one timeline, what home was before it became the living pipeline (#8015) · `/` · none seen.
- `/boards/data` — `pages/boards.ts` · the boards' query/data surface · `/board` · none seen.
- `/asks` — `studio/asks_page.ts` · what the crew is waiting on me for · `/` "needs me" list · colours 2.
- `/asked` — `studio/asked_page.ts` · what I answered, as a record · `/asks` · none seen.
- `/review` — `studio/review_page.ts` · every ask waiting on me, one row each, newest first · `/asks` (same asks, with buttons) · none seen.
- `/flow` — `pages/flow.ts` · the pipeline from ready issue to live deploy, and the bottleneck · `/system`, `/board`, `/` · none seen. A topbar button points here.
- `/talk` — `pages/talk.ts` · the person's one conversation with the forge: history, composer, Confirm and Cancel; replies stream in over `/talk/stream` · `/settings/confirms` (the same yes, as a list), the home tell box (one line to an app's crew) · none seen; styles in `docs/design/areas/talk.md`.
- `/notes` — `pages/notes.ts` · what the person wrote, newest first, with the planner's verdict and live state in one line, and one tap to overrule it · the home tell box (Notes button), the user menu, the palette · none seen; styles in `docs/design/areas/notes.md`.
- `/pipeline` — `pages/pipeline.ts` · the four steps a change follows (check, review, land, live), for a newcomer · a pull page's step line, `/flow` · none seen.
- `/map` — `pages/map.ts` (1,806 lines) · the dependency map of work across the forge · `/board`, issue dependency lists, `/:owner/:name/map` · colours 3, sizes 12: the largest private vocabulary.
- `/audit` — `pages/audit.ts` · every app's contract, who can do what · the app page's one-line policy · none seen. Names the audit of apps, not this document.
- `/repos` — `pages/my-repos.ts` · the repositories you may write, from the account menu · `/` (your apps), `/:owner` (a profile's repositories) · none seen.
- `/releases` — `pages/releases.ts` · the forge's kept releases and rollback · `/settings/backups` (both are "go back") · none seen.
- `/changelog` — `pages/changelog.ts` · the last 30 releases with their dates and pulls, public · `/releases` (the signed-in kept releases) · none seen.
- `/api` — `pages/api.ts` · the forge's OpenAPI operations by area, with search and Try it, public · the footer, the OpenAPI document, the terminal's API screen · none seen. An app's own spec is its `/:owner/:name/api` tab.
- `/contribute` — `pages/contribute.ts` · what this forge is and where outside work is welcome, open to anyone · `/llms.txt`, MCP `contribute` tool · none seen.
- `/search` — `pages/search.ts` · find across what I can read · the palette (`palette.ts`) · none seen.
- `/-/confirm` — `pages/search.ts` (`confirmPage`) · the "are you sure" step for a destructive action · none · none seen.

### Making things

- `/new` — `pages/site.ts` (`newRepoPage`) · make a repository · `/apps/new`, `/migrate` · colours 3 (file).
- `/apps` — `pages/apps.ts` · the apps the forge runs · `/audit`, `/explore` · colour 1.
- `/apps/new` — `pages/apps.ts` (`newAppPage`) · make an app from the template · `/new` · colour 1.
- `/apps/open` — `pages/apps.ts` (`appsOpen`) · a door from a name to a running app · `/apps` · colour 1.
- `/organizations/new` — `pages/org.ts` · make an organization · none · none seen.
- `/migrate` — `pages/migrate.ts` · bring a repository in from elsewhere · `/settings/origins` (mirror jobs) · none seen.

### Forges (the family)

- `/forges` — `pages/forges.ts` · the forges this one sent, as a client list · `/family` · colour 1.
- `/forges/new` — `pages/new-forge.ts` · send a new forge · none · colour 1.
- `/family` — `pages/family.ts` · parent, this forge and children as a tree · `/forges` (the same children) · colour 1.
- `/claim` — `pages/claim.ts` · claim a forge that was sent to me · none · colour 1.
- `/first-admin` — `pages/first-admin.ts` · the first person becomes admin · none · none seen.
- `/fleet/graph` — `pages/fleet-graph.ts` · the fleet as a graph · `/family`, `/forges` · none seen.

### Machine and operation (admin)

- `/system` — `pages/system.ts` · the machine as it is now: cores, load, memory, processes · `/flow`, `/` · none seen; updates in place over `/system/stream`, no reload script.
- `/resilience` — `pages/resilience.ts` · each protection in `docs/THREATS.md` against the last gate's tests · `/settings/resilience` (similar name, different content) · none seen.
- `/admin/limits` — `pages/admin-limits.ts` · every limit with value, default and reason · `/settings/capacity` (also a numbers-you-can-change page) · none seen.
- `/settings/capacity` — `pages/capacity.ts` · how many runs and checks go at once · `/admin/limits`, `/settings/usage` · none seen.
- `/settings/usage` — `pages/usage.ts` · route patterns by use, unused first · `/settings/telemetry`, `/board/returns` · none seen. Not about cost, despite the name.
- `/settings/telemetry` — `pages/telemetry.ts` · which agents may read telemetry · `/settings/crew` (agent grants) · none seen.
- `/settings/trusted` — `pages/trusted.ts` · who may fold in without review, until when, and the kill switch · `/review`, `/settings/crew` · none seen.
- `/settings/spend` — `pages/spend-tab.ts` · what the crew's runs spent, by credential, app, agent, issue and run kind · `/settings/subscriptions`, `/board/returns` · none seen. First tab of Usage (#2692).
- `/settings/resilience` — `pages/domains.ts` · failure domains and their last drill · `/resilience` · none seen.
- `/settings/backups` — `pages/backups.ts` (621 lines) · backups and restore · `/settings/resilience`, `/releases` · none seen.
- `/settings/flags` — `pages/flags.ts` · the forge's switches · none · none seen.
- `/settings/features` — `pages/features.ts` · apps absorbed as the forge's features, and their settings · `/apps` (the same apps, as apps) · none seen.
- `/settings/model` — `pages/model.ts` · which model the crew runs on · `/settings/crew` · none seen.
- `/settings/cloud` — `pages/cloud.ts` · cloud provider connection · none · none seen.
- `/settings/cloud/audit` — `pages/cloud.ts` · what the cloud connection did · `/audit` (different subject, same word) · none seen.
- `/settings/access` — `pages/access.ts` · who may reach the forge · `/settings/people`, `/settings/accounts` · none seen.

### Sign-in and account

- `/signin` — `pages/site.ts` · sign in · `/signin/parent` · colours 3 (file).
- `/signin/parent` — `http/rp.ts` · sign in with the forge that sent this one · `/signin` · no page (redirect).
- `/signin/parent/callback` — `http/rp.ts` · the return leg of that sign-in · none · no page (redirect).
- `/login` — `http/server.ts` (`signinAlias`) · the address people type to sign in · it is `/signin`, keeping a same-origin `next` · none (308, no page of its own).
- `/sign-in` — `http/server.ts` (`signinAlias`) · the same, hyphenated · it is `/signin` · none (308, no page of its own).
- `/signup` — `pages/site.ts` · make an account · `/signup` passkey flow (`signup-passkey.ts`) · colours 3 (file).
- `/verify` — `pages/site.ts` · confirm an email address · none · colours 3 (file).
- `/recover` — `pages/passkeys.ts` · get back in without a password · `/settings/passkeys` · none seen.
- `/settings` — `pages/account.ts` · my account · the rest of settings · colour 1.
- `/settings/password` — `pages/account.ts` · change password · `/settings/passkeys` · colour 1.
- `/settings/tokens` — `pages/account.ts` · my API tokens · `/settings/keys` (credentials of two kinds on two pages) · colour 1.
- `/settings/keys` — `pages/account.ts` · my SSH keys · `/settings/tokens` · colour 1.
- `/settings/passkeys` — `pages/passkeys.ts` · my passkeys · `/settings/password` · none seen.
- `/settings/confirms` — `pages/confirms.ts` · what the forge's agent asked to do and waits for my yes · the terminal's Confirms (y) · none seen.
- `/settings/secrets` — `pages/secrets.ts` · secrets apps may read · none · none seen.
- `/settings/subscriptions` — `pages/subscriptions.ts` (624 lines) · the model subscriptions the crew spends from, with spend tables (`pages/spend.ts`) · `/board/returns` · none seen.
- `/settings/accounts` — `pages/accounts.ts` · every account on the forge · `/settings/people` · none seen.
- `/settings/people` — `pages/people.ts` · people and their roles · `/settings/accounts`, `/settings/crew` · none seen.
- `/settings/crew` — `pages/crew.ts` · the named agents and what each may do · `/settings/model`, `/settings/telemetry` · none seen.
- `/settings/teams` — `pages/teams.ts` · the named crew teams, each with a charter, a dial and members · `/settings/crew` · none seen.
- `/settings/origins` — `pages/origins.ts` (1,497 lines) · other forges this one reads and mirrors from · `/migrate` · none seen.
- `/settings/security` — `pages/security.ts` · the Shield and the evidence an admin needs to act with no AI · `/settings/traffic`, `/settings/backups` · none seen.
- `/settings/traffic` — `pages/traffic.ts` · who used the answering time in the last 15 minutes · `/settings/usage`, `/settings/telemetry` · none seen.

## Operator views — why each is a page (#2696)

One line each; none is retired, and the reason it is not a board panel is the line.

- **`/audit`** — a page: a table of every app's contract, wide and exportable (`/audit.csv`); the board shows one row per app, not who can do what.
- **`/:owner/:name/waves`** — a page: one repository's notes by version, linked file by file; the board has no repository scope to hold it.
- **`/:owner/:name/variants/:group`** — a page: a deck is a decision (a vote post, a swipe) among the sibling pulls of one group; a panel could list the pulls, not decide among them.
- **`/:owner/:name/following`** — a page: the chain of forges this forge's code descends from, with the owner's one way out (sever); a destructive step with a record needs room and the `/-/confirm` step.
- **`/board/returns`** — a page, for now: the board's tokens line opened (see #2692); not a duplicate of the spend tables.
- **looks** (`/:owner/:name/looks/:env/:commit/:kind.png`) — not a page: a picture route, cached by commit, embedded by the pull page, the ask row and the app head. Nothing to retire.

## Finding 2b — what the pages do wrong, in sum

- Four pages answer "how full / what does it cost": `/settings/usage` (request
  use), `/settings/capacity`, `/settings/subscriptions` (spend), `/board/returns`.
  Two answer "what is the forge doing now": `/flow`, `/system`, plus `/`.
- Two pages are named "resilience" and mean different things (`/resilience`,
  `/settings/resilience`); two are named "audit" (`/audit`, `/settings/cloud/audit`).
- Two pages hold the same lists under different names: `/settings/accounts` and
  `/settings/people`; `/forges` and `/family`.
- The module that invents most: `pages/map.ts` (colours 3, sizes 12), then
  `pages/board.ts` (colour 1, sizes 6); the colour literals are spread thin over
  the studio and the site pages (see the table above).
- Repository pages (`/:owner/:name/*`) are not listed: the repo header and tabs
  already unify them.

## Finding 3 — what the clean app template does better

- One page, one purpose, one primary action. The forge's top bar carries
  Flow, search, help, theme, New, user — six controls before the page begins.
- It has no page-local CSS. Its stylesheet uses only token words
  (`font-size: var(--text-sm)`, no literal) and is linked by content hash and
  cached for a year. Every forge page file that carries colour or size
  literals (list above) is a page that reinvented a token.
- First paint is the product. Several forge pages are tables of everything;
  the template shows three numbers and a list.

## Merge or retire

These match the filed issues; each is a decision for its pull, not done here.

- **#2692** — usage, capacity, subscriptions' spend and the telemetry switch
  become one "Usage" page with `tabs()`. `/board/returns` stays: it is the
  board's tokens line opened.
- **#2693** — `/flow` folds into the board as panels; the topbar Flow button goes.
- **#2694** — `/resilience` folds into `/settings/backups` with
  `/settings/resilience`'s failure domains.
- **#2695** — `/map` is accounted for: keep only what `/board` and an issue's
  dependency list cannot show; move its 12 sizes and 3 colours onto tokens.
- **#2696** — operator views (`/audit`, waves, variants, looks, returns,
  following) each state why they are a page or become board panels.
- Not filed yet, noticed here: `/settings/people` into `/settings/accounts`;
  `/family` into `/forges`; `/settings/tokens` and `/settings/keys` into one
  credentials page; `/big` can be deleted once nothing links it.

## Not covered

Screenshots, contrast measurement per palette, the TUI surface, and pages
behind a specific repo (`/:owner/:name/*`), which the repo header and tabs
already unify and which are not where the drift is.

## Plan

`docs/design/plan.md` — small issues, in order. The check that holds the line
meanwhile is `scripts/design-lint.ts` (run by `test/design-lint.test.ts`, so it
runs in the gate).
