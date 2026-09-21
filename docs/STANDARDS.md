# Standards — what a forge serves because the web expects it

A forge is a site on the open web, and the open web has agreed on where a
few things live. The forge serves them from the moment it boots, derived from
what it already knows: its URL, its first account, its public repositories,
its own mark. Nothing here is configured, and nothing here is optional.

| path                           | what it is                                                        | from                                                   |
| ------------------------------ | ----------------------------------------------------------------- | ------------------------------------------------------ |
| `/.well-known/security.txt`    | who to tell about a vulnerability (RFC 9116), with a fixed expiry | the first account's email, or `FORGE_SECURITY_CONTACT` |
| `/.well-known/change-password` | where a password manager sends a person                           | `/settings/password`                                   |
| `/robots.txt`                  | crawlers stay out of accounts, search and the API; the sitemap    | —                                                      |
| `/sitemap.xml`                 | the front page and every public repository, never a private one   | `listReposVisibleTo(db, nobody)`                       |
| `/manifest.webmanifest`        | the forge as an installable app                                   | —                                                      |
| `/icons/forge-<size>.png`      | the mark at 192, 512, 512-maskable and 180 (iOS), painted at boot | `design/mark.ts`, the favicon's two colours            |

Every page carries a description, Open Graph and Twitter card metadata, the
manifest link, the touch icon and `viewport-fit=cover`, so a link to a
repository unfurls with its description and the forge installs to a home
screen with a real icon.

The list grows by the same rule: a standard that lets the forge plug into
something people already use, served from facts the forge already has. Feeds
of a repository's activity, WebFinger for accounts, and the OIDC discovery
document once the forge is an identity provider are the next of these.

`src/web/standards.ts`, `test/standards.test.ts`.
