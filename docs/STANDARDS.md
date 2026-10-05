# Standards — what a forge serves because the web expects it

A forge is a site on the open web, and the open web has agreed on where a
few things live. The forge serves them from the moment it boots, derived from
what it already knows: its URL, its first account, its public repositories,
its own mark. Nothing here is configured, and nothing here is optional.

| path                           | what it is                                                        | from                                                                         |
| ------------------------------ | ----------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `/.well-known/security.txt`    | who to tell about a vulnerability (RFC 9116), with a fixed expiry | the first account's page here; an address only from `FORGE_SECURITY_CONTACT` |
| `/.well-known/change-password` | where a password manager sends a person                           | `/settings/password`                                                         |
| `/robots.txt`                  | crawlers stay out of accounts, search and the API; the sitemap    | —                                                                            |
| `/sitemap.xml`                 | the front page and every public repository, never a private one   | `listReposVisibleTo(db, nobody)`                                             |
| `/manifest.webmanifest`        | the forge as an installable app                                   | —                                                                            |
| `/icons/forge-<size>.png`      | the mark at 192, 512, 512-maskable and 180 (iOS), painted at boot | `design/mark.ts`, the favicon's two colours                                  |
| `/:owner/:name/activity.atom`  | a repository's activity as Atom: pushes, issues, pulls, forks     | a fixed list of kinds, as sentences; never a raw payload                     |

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
`POST /api/v1/repos/:owner/:name/reports` with JSON `{title, body?, page?}`
(202, `{id, state: "pending"}`). A private repository answers `not_found`, as
a missing one does. A report is plain text, capped (a 200-character title, an
8,000-character body), limited per source, per repository and for the whole
forge, and a repository holds at most 100 waiting.

A report is not an issue. It waits at `/:owner/:name/reports` (and
`GET …/reports`) for a person who writes the repository; an agent is refused
there, on the crew or not, and nothing that reads issues — briefs, autonomy,
the feed, search, the MCP — reads reports. Accepting one
(`POST …/reports/:id/accept`) opens an ordinary issue in the accepting
person's name, saying it came from outside, with the words fenced as plain
text; dismissing drops it. The outbox records that a report arrived, by id,
for the repository's admins, never its words.

`src/core/reports.ts`, `src/actions/reports.ts`, `test/reports.test.ts`.
