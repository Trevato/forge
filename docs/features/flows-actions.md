# Flow line actions (#9591)

Each line on `/:owner/:name/flows` carries its one action. The terminal's Flows screen (palette: "Flows of a repository") offers the same, decided by the same reads (`readFlows`), so a person and the page never disagree.

| Line | Action | Who | Page | Terminal |
| --- | --- | --- | --- | --- |
| Followed upstream | Stop following / Follow again | repo admin | POST `/settings/upstream` | `s` |
| Followed source | Stop following | repo admin | POST `/settings/sources/:id/remove` | `s` |
| Mirror behind its origin | Pull in what's new | writer | POST `/sync/take` | `p` |
| Fork of another repo | Offer what's useful | writer | link to `/pulls/new` | `o` |
| Fork of this repo | Follow mode | the fork's admin | link to the fork's `/following` | `o` |
| Pinned package with a newer stable release | Update this dependency | writer (not agents) | POST `/flows/update` | `u` |

- Every POST is same-origin and goes through `readForm`; the follow routes honour a `back` field only when it is a local path (`isLocalPath`), so the action returns you to Flows.
- Update this dependency files the radar's own issue (`src/flows/file.ts`, `askUpdate`), once per package. On an autonomous repository the issue is assigned to the crew's builder, who proposes the pull; otherwise it is assigned to the owner.
- Live: the terminal redraws on `issue.opened`, `repo.links_probed` and `repo.upstream_checked`. The web page is server-rendered and shows the new state on the next load.
