# Forge-to-forge compatibility, measured (#8900)

Written by `scripts/forge-compat-lab.sh`; run it on any docker host to get this table again. It starts three real forges in containers on a private network, behind TLS with a throwaway authority, seeds them, and drives them with HTTP and git. No live forge is touched.

**What "old" is.** The real forge at forge-apps.benjivers.com reports 0.5.29, commit `2d910c08`. That commit and that tag are in no repository this lab can read. The oldest honest stand-in is trunk `ce7846af`, the last commit before `/api/v1/version`: its contract matches the live forge's published OpenAPI on 325 of 332 routes, with the same absences (`/api/v1/version`, `/api/v1/user/repos`) and the same OAuth metadata. The other 7 are routes only the live forge has (admin users, check secrets, org teams); none is one an origin calls. So this is a reconstruction of 0.5.29, not 0.5.29.

**The refused token.** A forge before `/api/v1/version` reads `Bearer` and `Basic` only (`src/http/server.ts` at `ce7846af`). This forge sent `Authorization: token …`, the Gitea scheme, so a good token answered 401 and read as "That token was refused by the origin". `ForgeProvider` now sends Bearer always. Scopes were not the cause: `ro` connects.

**Absent, and what this cannot show.** `absent` is a thing not built, or not checkable here, said plainly.

- An old forge cannot connect another forge at all: it has no forge provider, so that direction asks for an upgrade, not a fix here. By release: a forge older than 0.7.346 connects outward never (connect it from the newer side, see [Connecting from an older forge](forge-origin-older.md#connecting-from-an-older-forge)); 0.7.346 or later connects outward.
- A webhook needs `admin` scope at the origin, so a `ro` or `rw` token and every sign-in register none; issues and pulls come back on a sync or the sweep. With an admin token the hook registers, but the lab's source refuses to deliver to a private address, as its SSRF guard should, so a delivery end to end is unproven here.
- The live 0.5.29 was read anonymously only: its OAuth metadata, health, OpenAPI and 401s. Nothing was signed in to it.
- Not carried by design or not built: how the app runs, and its data and secrets.
- On a forge, a public repository someone was given write on reads as public, since a forge's JSON carries no rights.

The public group was also read from the real forge-apps.benjivers.com, anonymously, through the provider (`scripts/forge-compat-lab/live-public.ts`): 16 public repositories, none yours or shared, as an account owning nothing there should see.

## Result

| Direction | Area | Check | Result | Seen |
|---|---|---|---|---|
| forge-old | 1 discovery | health names version and commit | pass | version 0.5.29; /api/v1/version 404; /user/repos 404 |
| forge-old | 2 token scheme | GET /user with Bearer | pass | 200 as ann |
| forge-old | 2 token scheme | GET /user with token | pass | 401: an old forge reads Bearer and Basic only, so a forge must send Bearer |
| forge-old | 2 token scheme | GET /user with Basic | pass | 200 as ann |
| forge-old | 3 oauth endpoints | register, consent, token, refresh rotates, reused code and refresh refused | pass | lifetime day; Bearer ro |
| forge-old | 3 oauth endpoints | redirect-URI mismatch refused before any code | pass |  |
| forge-old | seed | issues, a pull, labels, comments, a tag, by two people, and a big tree | pass | 2436 files |
| forge-new | seed | issues, a pull, labels, comments, a tag, by two people, and a big tree | pass | 2436 files |
| forge-new2 | seed | issues, a pull, labels, comments, a tag, by two people, and a big tree | pass | 2436 files |
| forge-new reads forge-old | 1 discovery | an address that is no forge is refused in words | pass | unreachable: that host could not be reached |
| forge-new reads forge-old | 2 connect by token | a made-up token is refused | pass |  |
| forge-new reads forge-old | 2 connect by token | an administrator connects as themselves, a person's own account | pass | login boss |
| forge-new reads forge-old | 2 connect by token | an everyday ro token connects | pass | login ann, software forge |
| forge-new reads forge-old | 1 discovery | the address is stored as a forge | pass | kind gitea |
| forge-new reads forge-old | 4 list | own repositories across pages, private ones included, nobody else's | pass | 135 in 1 pages |
| forge-new reads forge-old | 5 bring | a public repository: history, branches, tags identical | pass | 3 refs |
| forge-new reads forge-old | 5 bring | issues and comments, authors kept | pass | #1, 1 comment |
| forge-new reads forge-old | 5 bring | pulls | pass | #2 open |
| forge-new reads forge-old | 5 bring | labels | pass |  |
| forge-new reads forge-old | 5 bring | a label stays on its issue | pass |  |
| forge-new reads forge-old | 5 bring | a private repository, with the credential | pass |  |
| forge-new reads forge-old | 5 bring | a big repository, whole tree | pass | 1 s, main 32d7ce0a |
| forge-new reads forge-old | 6 sync | a commit there arrives here with a sync | pass |  |
| forge-new reads forge-old | 6 sync | an issue opened there appears here (webhook, else sync) | pass | by sync (no webhook seen) |
| forge-new reads forge-old | 6 sync | a pull opened there appears here | pass | by sync |
| forge-new reads forge-old | 6 sync | with a ro token, writing here is refused in words, nothing kept | pass | 409 origin_refused: the origin refused this change; nothing was changed here either |
| forge-new reads forge-old | 7 failure | a revoked token: said plainly, marked to reconnect, and a new token repairs it | pass | failed: the origin has no such repository, or this account cannot see it; needsReauth |
| forge-new reads forge-old | 7 failure | connecting a new token after that works | pass | rw |
| forge-new reads forge-old | 6 sync | with a rw token, a comment here lands there, under the same issue | pass |  |
| forge-new reads forge-old | 6 sync | with a rw token, an issue opened here is opened there | pass |  |
| forge-new reads forge-old | 6 sync | webhook: a rw or signed-in token cannot register one (a hook needs admin scope there) | absent | no hook registered: the sweep is the only way back without admin scope |
| forge-new reads forge-old | 6 sync | webhook with an admin-scope token: an issue opened there arrives without a sync | absent | the hook is registered; its delivery is refused by the source's SSRF guard, as it should be for this lab's private network. Not verified end to end. |
| forge-new reads forge-old | 6 sync | a git push to a fresh mirror lands on the origin, and a pull opened here opens there | pass |  |
| forge-new reads forge-old | 6 sync | a git push to a mirror whose origin was disconnected and connected again still lands there | pass |  |
| forge-new reads forge-old | 7 failure | a repository this account cannot read does not come across | pass | job failed: the origin has no such repository, or this account cannot see it |
| forge-new reads forge-old | 7 failure | a token that lost access: the repository went private there, a sync says so and keeps the copy | pass | sync 200 the origin has no such thing; lastError the origin has no such thing; needsReauth false |
| forge-new reads forge-old | 7 failure | the origin down in the middle of a bring: fails in words, then succeeds | pass | job failed: the origin could not be reached |
| forge-new reads forge-old | 7 failure | the origin killed while a big bring runs: fails in words, then succeeds | pass | first: failed Fetching from the origin failed: Error: The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second ar |
| forge-new reads forge-old | 4 groups | owning nothing: yours is empty, the organization's repository is shared, others' are public | pass | 100 public on the first page |
| forge-new reads forge-old | 4 groups | public pages past the first, and search narrows it | pass | 121 in 2 pages |
| forge-new reads forge-old | 4 groups | the page labels all three | pass |  |
| forge-new reads forge-old | 6 work with | someone else's public repository comes across for someone with read only | pass |  |
| forge-new reads forge-old | 6 work with | ro: sending work back is refused in words, nothing there | pass | the origin refused: this connection cannot write there, and a fork there takes a token that can write (rw). Nothing was changed. Connect again with one, or ask  |
| forge-new reads forge-old | 6 work with | rw: sending work back forks it there and opens a pull, authored by them | pass | #1 by dee, from their fork |
| forge-new reads forge-old | 6 follow | a followed source: a new commit there opens one pull here | pass |  |
| forge-new reads forge-old | 3 sign-in | through the flow page, the approve form and back, connected as forge | pass | authKind oauth, expires 2026-11-05T18:00:41.377Z |
| forge-new reads forge-old | 4 list | with the signed-in token | pass | 135 repositories |
| forge-new reads forge-old | 5 bring | a bring with the signed-in token | pass |  |
| forge-new reads forge-old | 3 sign-in | an expiring token refreshes itself before expiry | pass | expiry moved to 2026-11-05T18:00:42.704Z |
| forge-new reads forge-old | 7 failure | a wrong state at the callback connects nothing and says so | pass | That authorization could not be matched to a connect you started here. Start again. |
| forge-new reads forge-old | 7 failure | a code used twice at the callback connects nothing the second time | pass | first ?connected=1, second ?error=state |
| forge-new reads forge-old | 7 failure | the wrong verifier and a mismatched redirect at the origin | pass |  |
| forge-new reads forge-old | 7 failure | the origin down at sign-in says so in words, then signs in | pass | 422: That address could not be reached, or no forge answered there. |
| forge-old reads forge-new | 1 discovery | an address that is no forge is refused in words | pass | unreachable: that host could not be reached |
| forge-old reads forge-new | 2 connect by token | a made-up token is refused | pass |  |
| forge-old reads forge-new | 2 connect by token | an administrator connects as themselves, a person's own account | absent | bad_token: an old forge reads another forge as Gitea and finds no login |
| forge-old reads forge-new | 2 connect by token | an everyday ro token connects | absent | bad_token: an old forge reads another forge as Gitea and finds no login |
| forge-old reads forge-new | 1 discovery | the address is stored as a forge | absent | not connected, so nothing stored |
| forge-old reads forge-new | 3 sign-in | the old forge offers no sign-in to another forge | absent | landed /settings/origins; (no message on the page) |
| forge-old reads forge-new | 4-7 | list, bring, sync, failure | absent | a forge older than forge-to-forge cannot connect another forge at all; upgrade it. Nothing here can fix an old build. |
| forge-new2 reads forge-new | 1 discovery | an address that is no forge is refused in words | pass | unreachable: that host could not be reached |
| forge-new2 reads forge-new | 2 connect by token | a made-up token is refused | pass |  |
| forge-new2 reads forge-new | 2 connect by token | an administrator connects as themselves, a person's own account | pass | login boss |
| forge-new2 reads forge-new | 2 connect by token | an everyday ro token connects | pass | login ann, software forge |
| forge-new2 reads forge-new | 1 discovery | the address is stored as a forge | pass | kind gitea |
| forge-new2 reads forge-new | 4 list | own repositories across pages, private ones included, nobody else's | pass | 143 in 1 pages |
| forge-new2 reads forge-new | 5 bring | a public repository: history, branches, tags identical | pass | 3 refs |
| forge-new2 reads forge-new | 5 bring | issues and comments, authors kept | pass | #1, 1 comment |
| forge-new2 reads forge-new | 5 bring | pulls | pass | #2 open |
| forge-new2 reads forge-new | 5 bring | labels | pass |  |
| forge-new2 reads forge-new | 5 bring | a label stays on its issue | pass |  |
| forge-new2 reads forge-new | 5 bring | a private repository, with the credential | pass |  |
| forge-new2 reads forge-new | 5 bring | a big repository, whole tree | pass | 1 s, main c50dfe6f |
| forge-new2 reads forge-new | 6 sync | a commit there arrives here with a sync | pass |  |
| forge-new2 reads forge-new | 6 sync | an issue opened there appears here (webhook, else sync) | pass | by sync (no webhook seen) |
| forge-new2 reads forge-new | 6 sync | a pull opened there appears here | pass | by sync |
| forge-new2 reads forge-new | 6 sync | with a ro token, writing here is refused in words, nothing kept | pass | 409 origin_refused: the origin refused this change; nothing was changed here either |
| forge-new2 reads forge-new | 7 failure | a revoked token: said plainly, marked to reconnect, and a new token repairs it | pass | failed: the origin has no such repository, or this account cannot see it; needsReauth |
| forge-new2 reads forge-new | 7 failure | connecting a new token after that works | pass | rw |
| forge-new2 reads forge-new | 6 sync | with a rw token, a comment here lands there, under the same issue | pass |  |
| forge-new2 reads forge-new | 6 sync | with a rw token, an issue opened here is opened there | pass |  |
| forge-new2 reads forge-new | 6 sync | webhook: a rw or signed-in token cannot register one (a hook needs admin scope there) | absent | no hook registered: the sweep is the only way back without admin scope |
| forge-new2 reads forge-new | 6 sync | webhook with an admin-scope token: an issue opened there arrives without a sync | absent | the hook is registered; its delivery is refused by the source's SSRF guard, as it should be for this lab's private network. Not verified end to end. |
| forge-new2 reads forge-new | 6 sync | a git push to a fresh mirror lands on the origin, and a pull opened here opens there | pass |  |
| forge-new2 reads forge-new | 6 sync | a git push to a mirror whose origin was disconnected and connected again still lands there | pass |  |
| forge-new2 reads forge-new | 7 failure | a repository this account cannot read does not come across | pass | job failed: the origin has no such repository, or this account cannot see it |
| forge-new2 reads forge-new | 7 failure | a token that lost access: the repository went private there, a sync says so and keeps the copy | pass | sync 200 the origin has no such thing; lastError the origin has no such thing; needsReauth false |
| forge-new2 reads forge-new | 7 failure | the origin down in the middle of a bring: fails in words, then succeeds | pass | job failed: the origin could not be reached |
| forge-new2 reads forge-new | 7 failure | the origin killed while a big bring runs: fails in words, then succeeds | pass | first: failed Fetching from the origin failed: Error: The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second ar |
| forge-new2 reads forge-new | 4 groups | owning nothing: yours is empty, the organization's repository is shared, others' are public | pass | 98 public on the first page |
| forge-new2 reads forge-new | 4 groups | public pages past the first, and search narrows it | pass | 131 in 2 pages |
| forge-new2 reads forge-new | 4 groups | the page labels all three | pass |  |
| forge-new2 reads forge-new | 6 work with | someone else's public repository comes across for someone with read only | pass |  |
| forge-new2 reads forge-new | 6 work with | ro: sending work back is refused in words, nothing there | pass | the origin refused: this connection cannot write there, and a fork there takes a token that can write (rw). Nothing was changed. Connect again with one, or ask  |
| forge-new2 reads forge-new | 6 work with | rw: sending work back forks it there and opens a pull, authored by them | pass | #1 by dee, from their fork |
| forge-new2 reads forge-new | 6 follow | a followed source: a new commit there opens one pull here | pass |  |
| forge-new2 reads forge-new | 3 sign-in | through the flow page, the approve form and back, connected as forge | pass | authKind oauth, expires 2026-11-05T18:01:59.681Z |
| forge-new2 reads forge-new | 4 list | with the signed-in token | pass | 143 repositories |
| forge-new2 reads forge-new | 5 bring | a bring with the signed-in token | pass |  |
| forge-new2 reads forge-new | 3 sign-in | an expiring token refreshes itself before expiry | pass | expiry moved to 2026-11-05T18:02:01.068Z |
| forge-new2 reads forge-new | 7 failure | a wrong state at the callback connects nothing and says so | pass | That authorization could not be matched to a connect you started here. Start again. |
| forge-new2 reads forge-new | 7 failure | a code used twice at the callback connects nothing the second time | pass | first ?connected=1, second ?error=state |
| forge-new2 reads forge-new | 7 failure | the wrong verifier and a mismatched redirect at the origin | pass |  |
| forge-new2 reads forge-new | 7 failure | the origin down at sign-in says so in words, then signs in | pass | 422: That address could not be reached, or no forge answered there. |
