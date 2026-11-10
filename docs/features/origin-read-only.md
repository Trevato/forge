# Connecting an origin read-only (#10519)

Tick **Read-only** when you connect an account by token (Settings → Origins, either form), pass `"readOnly": true` to `POST /api/v1/user/origins`, or answer `yes` to the last prompt of `c` in the terminal's Connected origins screen. Reading and syncing go on; nothing is ever written back: no comments, issues, reviews, branches, forks, proposals, pushes or mirror-out.

- **What you see:** the origins list says "read-only: nothing is written back" on the row (the terminal row says `read-only`). A refused write says so in a plain sentence; the REST door answers `409` with `"error": "origin_read_only"`.
- **Merging** on a mirror is never done from here, read-only or not (`mirrored`).
- **Stored:** `origin.read_only`, default 0, so every connection from before stays as it was. The token stays sealed either way.
- **Try it:** connect with Read-only ticked, mirror a repository, comment on it: refused, and the origin saw no write.
- Test: `test/origin-read-only.test.ts`.
