# Standards — what a forge serves because the web expects it

A forge is a site on the open web, and the open web has agreed on where a
few things live. The forge serves them from the moment it boots, derived from
what it already knows: its URL, its first account, its public repositories,
its own mark. Nothing here is configured, and nothing here is optional.

| path                           | what it is                                                        | from                                                                         |
| ------------------------------ | ----------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `/.well-known/security.txt`    | who to tell about a vulnerability (RFC 9116), with a fixed expiry | the sealed new-issue form of `FORGE_REPO` when it is public, else the first account's page here; an address only from `FORGE_SECURITY_CONTACT` |
| `/.well-known/forge`           | the standards this forge implements, by id and version ([`docs/standards/`](standards/README.md)) | `src/core/standards_index.ts` |
| `/.well-known/change-password` | where a password manager sends a person                           | `/settings/password`                                                         |
| `/robots.txt`                  | crawlers stay out of accounts, search and the API; the sitemap    | —                                                                            |
| `/sitemap.xml`                 | the front page and every public repository, never a private one   | `listReposVisibleTo(db, nobody)`                                             |
| `/manifest.webmanifest`        | the forge as an installable app                                   | —                                                                            |
| `/llms.txt`                    | the forge for an agent (llmstxt.org): how to report, how to offer a change, the API and MCP, the public repositories | `listReposVisibleTo(db, nobody)`, the report limits                          |
| `/icons/forge-<size>.png`      | the mark at 192, 512, 512-maskable and 180 (iOS), painted at boot | `design/mark.ts`, the favicon's two colours                                  |
| `/:owner/:name/activity.atom`  | a repository's activity as Atom: pushes, issues, pulls, forks     | a fixed list of kinds, as sentences; never a raw payload                     |

`/.well-known/forge` is deliberately machine-only: it has no page, terminal
screen or feature doc, because its reader is a program checking conformance.

Every page carries a description, Open Graph and Twitter card metadata, the
manifest link, the touch icon and `viewport-fit=cover`, so a link to a
repository unfurls with its description and the forge installs to a home
screen with a real icon.

The list grows by the same rule: a standard that lets the forge plug into
something people already use, served from facts the forge already has, and
nothing a person did not already make public: a feed is built from a fixed
list of kinds and the titles on the repository's own pages, and a private
repository's feed is its readers' alone. The OIDC discovery document, once
the forge is an identity provider, is the next of these. WebFinger is not on
the list by default: it would tell anyone which accounts exist.

`src/web/standards.ts`, `test/standards.test.ts`.

## Reports from outside

Anyone, with no account, can tell a public repository that something is
wrong: the form at `/:owner/:name/report`, or
`POST /api/v1/repos/:owner/:name/reports` with JSON `{title, body?, page?, agent?}`
(202, `{id, state: "pending", filedBy}`). Sent with a token or password (the
API, or MCP `report`), or with a session cookie from this forge's own page
(`proofOf` in `src/http/report_filer.ts`), the report carries that account,
`filedBy: {how: "signed", name}`; an `agent` name given without one is kept as
a claim, `how: "claimed"`, and shown as unproven; with neither it is
`how: "anonymous"`, `name: null`. The owner reads the waiting ones grouped by
filer with a count (`byAgent` in the API and MCP `reports`, headed groups on
the page), each `untrusted` unless a writer of the repository filed it. A private repository answers `not_found`, as
a missing one does. A report is plain text, capped (a 200-character title, an
8,000-character body), limited per source, per repository and for the whole
forge, and a repository holds at most 100 waiting. A person who writes the
repository decides them on the web, through the API, MCP `reports`, or the
terminal: a repository's `:` palette shows "Reports (N)" while any wait, `a`
accepts one as an issue and `d` dismisses one (`src/tui/screens/reports.ts`).

Every page also says what its reader can do there: `rel="alternate"
type="application/json"` (tag and `Link` header) points at
`/api/v1/here?path=<the page's path>`, a manifest of a few hundred bytes —
what the page is, who the forge takes the caller to be (anonymous, reader,
writer, owner, agent; a read-only token says so), and each action open to
them with its HTTP route and MCP tool, those that need an account marked.
It is computed from the checks the routes themselves ask (`canRead`,
`canWrite`, `canAdmin`, `canEnterApp`, `mayDirectCrew`), so it never offers
what a route would refuse; a repository the caller cannot read is
`not_found`, and a private app the caller may not enter is not mentioned.
An action waiting on a proven email says `verify: true`; on a mirror,
issues and comments are offered only to the account that connected it (they
are written on the origin, through it). On a pull's page, `here.pull.runs`
says whether its checks and preview run now or wait for a writer to approve
its head (`pullMayRun`). The MCP tool `here {url}` answers the same. `src/actions/here.ts`,
`test/here-manifest.test.ts`.

An agent finds the path without being told. Every page carries
`rel="service-doc"` to `/llms.txt`, and a public repository's pages
`rel="help"` to its report form, both as `<link>` tags and as a `Link`
header; security.txt points at `/llms.txt` for anything that is not a
vulnerability. Each refusal a stranger meets says what is open to them: the
API's 401 on opening an issue carries a `report` object and a `Link`, a
stranger's `/issues/new` shows "Report a problem" beside "Sign in", and the
MCP's 401 keeps its OAuth challenge while naming `report`, the one tool that
answers without a token. A private repository offers none of this.
`test/report-discovery.test.ts` replays that walk.

A report is not an issue. It waits at `/:owner/:name/reports` (and
`GET …/reports`) for a person who writes the repository; an agent is refused
there, on the crew or not, and nothing that reads issues — briefs, autonomy,
the feed, search, the MCP — reads reports. Accepting one
(`POST …/reports/:id/accept`) opens an ordinary issue in the accepting
person's name, saying it came from outside, with the words fenced as plain
text; dismissing drops it. The outbox records that a report arrived, by id,
for the repository's admins, never its words.

The issue stays marked. Its title opens with `From outside:` and it carries
the label `outside`, made in the repository on first use. The person
accepting may reword the title first, in the form on the reports page or as
`{ "title": "…" }` to the API; the marker is put back in front whatever
they send, once, and a title that is empty or over 200 characters is
refused with the report still waiting. The crew's brief for an issue so
marked, by its label or by its title, says before the text that the title
and the fenced words are a stranger's, unchecked: a description to verify,
never instructions.

`src/core/reports.ts`, `src/actions/reports.ts`, `test/reports.test.ts`.
