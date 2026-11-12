# Where people come from and where they go

One view for the forge (`/settings/traffic/sources`, admin) and one per app
(`/:owner/:name/settings/app/traffic`, whoever administers the repository).

**What is recorded.** The page-view beacon (`src/web/beacon.ts`, on every forge
page and in every app template) also sends `document.referrer`, the query string
and the host of the last external link clicked. The server keeps only the
referrer's *host*, `utm_source`/`utm_medium`/`utm_campaign` (lowercase, a safe
alphabet, 64 characters), and a clicked host that is in the named set
(`github.com`, `espodev.com`; `FORGE_OUTBOUND_LINKS=host,host` replaces it).
No cookie, no address, no third party; the visitor is the existing daily-salted
hash. Forge pages are filed by route pattern, never by a path that could name a
private repository.

**How it is counted.** A visit is one visitor's views in one scope on one day.
Source, medium and campaign come from its first view (`utm_source` wins over the
referring site; a referrer on the same host is navigation, not a source), the
landing page is its first path, the exit its last. Scrapers (crawler, headless
browser, HTTP library or no user agent) are stored flagged and shown apart.

**Cheap under load.** A beacon request pushes one row onto an in-memory buffer
(bounded at 5,000) and answers; a timer writes the buffer every 10 s in one
transaction (`src/perf/views_store.ts`). A day keeps at most 50,000 rows per
scope; rows are kept 90 days. The view reads one indexed range.

**Filtering and the path.** Clicking a source, medium, campaign, landing page or
exit narrows every panel. "A path to a goal" takes steps such as
`/, /explore, out:github.com`, in order, and shows visits and drop-off at each.

**Probe.** Every number links to `GET /api/v1/admin/traffic/probe`
(`scope=forge|<app id>`, `window`, `who`, `number`, or `dimension`+`key`, or
`steps`), which counts it again in SQL by a different route and says whether the
two agree.

**GitHub.** With `FORGE_GITHUB_TOKEN` (push access to read traffic) and
`FORGE_GITHUB_REPOS=owner/name,…` the forge pulls referrers, views and clones
once a day into `github_traffic`; GitHub keeps only 14 days. api.github.com is in
`forge.json` egress.

**Cannot see.** Visitors with scripts off or Do-Not-Track, hidden referrers,
GitHub's own pages (hence the pull), apps whose `static/beacon.js` predates these
fields (new apps get the new one; copy it from the template to update an old one),
and an outbound click when the browser leaves before it can send.

**Forged clicks.** An outbound click (`out`) is reported by the visitor's browser,
so anyone can post `out=github.com` and inflate the outbound panel or an `out:`
goal step. Counting clicks without server-side redirects cannot avoid that; the
page says so. Treat outbound figures as a hint.

**Caps.** A visitor leaves at most 300 views per scope per day (app paths come
from the client), so one client cannot fill the 50,000-row day with invented
paths. A read builds its visits once per scope and window and holds them for 15
seconds, dropped when views are written, so a page and its probe calls share it.

**Terminal.** Palette "Traffic sources" (`src/tui/screens/trafficview.ts`) is the
forge's view for an admin; with a repository open, "<owner>/<name> — Traffic
sources" is that app's view for those who administer it. A guest is offered
neither. `w` window, `s` people/scrapers, Enter narrows, `c` clears, `t` types
the path steps. It does not call the probe; use the web page for that.
