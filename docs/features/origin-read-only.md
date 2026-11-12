# Connecting an origin read-only (#10519)

Tick **Read-only** when you connect an account by token (Settings → Origins, either form), pass `"readOnly": true` to `POST /api/v1/user/origins`, or answer `yes` to the last prompt of `c` in the terminal's Connected origins screen. Reading and syncing go on; nothing is ever written back: no comments, issues, reviews, branches, forks, proposals, pushes or mirror-out.

- **What you see:** the origins list says "read-only: nothing is written back" on the row (the terminal row says `read-only`). A refused write says so in a plain sentence; the REST door answers `409` with `"error": "origin_read_only"`.
- **Merging** on a mirror is never done from here, read-only or not (`mirrored`).
- **Stored:** `origin.read_only`, default 0, so every connection from before stays as it was. The token stays sealed either way.
- **Try it:** connect with Read-only ticked, mirror a repository, comment on it: refused, and the origin saw no write.
- Test: `test/origin-read-only.test.ts`.

## Private to its owner (#10520)

A repository mirrored from a read-only origin is created private, whatever the origin says, and cannot be made public while the origin is read-only: `PATCH /api/v1/repos/:owner/:name` with `"visibility": "public"` answers `409` `origin_read_only` (the same through the MCP and the settings page). Being private it is left out of every list, count, search, the changelog and Talk for anyone but its owner, by the same visibility filter as any private repository. Test: `test/origin-read-only-private.test.ts`.

## On the owner's profile (#10522)

The owner's own `/:owner` lists each read-only origin's mirrors under **work (read-only)**, each with its last fetch time; when the last fetch failed, one line says why (token refused, host unreachable, repository gone), taken from the sync result, never a stack. Server-rendered for the owner only: anyone else gets no section and no placeholder. The scheduled sync already fetches commits, branches, open and merged pulls and reviews. Mirrors also still appear in the owner's Repositories list. Test: `test/origin-read-only-profile.test.ts`.
