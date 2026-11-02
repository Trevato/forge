### 5c. Apps, runs and the crew

`docs/APPS.md` is the contract; these are its units on a page, and the same
rule holds: the page never decides. Six of them:

**New app** — `/apps/new`, one form: a name, a sentence about what it should
do, visibility, and an agent from the crew when there is one. One POST makes
the repository with a working app in it, makes it an app, starts production,
and — with a sentence and an agent — opens issue #1 assigned. The flash names
the production URL and the agent. A forge with no agents says so on the form
in one line and offers the same button without the select.

**Run as an app** — on a repository's settings, the App section: enable with a
slug, an access choice and the preview-data policy; edit them; disable behind
a confirm page. The app strip (§5) appears on the repository the moment it is
on.

**Open** — never the bare hostname. Every link to an environment goes through
`…/app/:env/open`, which checks `canRead` and answers with the URL — carrying a
grant for a private app — so the same link works for a public app and a
private one and a stranger gets `not_found` from the forge rather than a
guess at a hostname.

**Redeploy / Stop** — two POSTs on the studio app page (`studio/app.ts`;
dev's old `/:owner/:name/app` redirects there), writers only: production's
in the head card, each preview's on its row; a stop keeps the data (a
redeploy brings it back), a stopped environment shows the honest word and
the run that stopped it.

**Assign** — the assignee card on an issue and a pull: nobody, then people
who can read the repository, then the crew marked as agents. Assigning an
agent is the dispatch, so the select says so beside the crew. An agent's own
pull opens already assigned to it.

**Cancel a run** — one POST on the run page while it is unfinished; the log
keeps everything up to the cancel and the badge says `cancelled`.

The merge box gains a seventh state, _Waiting on checks_, when
`require_checks` is on and the head's deploy is not green; the refusal is
`mergePull`'s (`checks_required`) and the chip links the run. A pull's
**Preview** card and its **Checks** line read the same run rows a
`runStateBadge` does elsewhere — a check is a deploy, never a separate
object that can drift.

**Website spec findings** — under a pull's Checks line, from the preview's
latest deploy run (`core/preview_findings.ts`): a **disclosure** whose
summary is the count (edge-owned findings counted apart) and whose body is
a `.list` of `.row`s, one per finding, with its specification.website
section as an https link. Report-only, so the words never say failed; the
summary is at least 44px tall for a thumb. The terminal says the same count
at the end of the checks row.
