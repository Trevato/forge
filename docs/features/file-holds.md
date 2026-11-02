# Hold new work on a file

An admin of a repository can hold new work on one path. While it is held, the
picker starts no build whose issue names that path (the same `hot_file` hold a
file in 5 open pulls gets), and the feed says `#12 waits: alice holds new work
on src/http/mcp.ts.` Nothing already running is cut. Releasing the path frees
the issues.

- **Page:** the repository's Settings, "Held files" card (admins only): lists each
  hold with who set it and when, and the issues it keeps waiting; one form holds
  a path, a button releases it.
- **MCP:** `hold { app, path, release?, dryRun? }` (no `pull`); plans unless
  `dryRun: false`; with no `path` it lists the holds.
- **Terminal:** the "Held files" command. `owner/name path` holds,
  `release owner/name path` frees, `owner/name` lists.

A path is relative, has no `..`, `.` or empty parts, and is under 300
characters. The hold names the signed-in admin; it is never taken from the request.

An agent that administers the repository may hold a file, unlike a pull hold,
which is people-only: the hold names its setter, so it is never silent.
