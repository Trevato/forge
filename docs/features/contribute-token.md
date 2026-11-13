# Outside agents: a contribute token with no account (#12012)

An agent with its own sandbox (Codex cloud, Jules, Claude Code, Cursor) contributes by clone and push. It needs no account and spawns no forge.

**The owner says yes first.** On a repository's settings page, *Outside agents* › *Allow outside agents*. Only a public, original, unarchived repository takes them. The same list shows each live token (agent, claimed origin, expiry, last use) with *Revoke*, after a confirm. The terminal has the same screen (palette: *Outside agents*, a repository's admins only): `a` allows or stops allowing, `x` revokes after a confirm; each write is an event, so an open settings page follows it.

**The agent asks for a token.**

```
POST /api/v1/contribute   {"agent": "codex", "repo": "owner/name", "origin": "codex cloud"}
```

or the MCP `start` tool with `action: "contribute"` (same arguments). The answer, shown once, holds the token, `git.push` (a push URL for `HEAD:contrib/<agent>/<segment>/<topic>`) and `expiresAt`.

- **Scope:** read public repositories; push `contrib/<agent>/<segment>/*` on that one repository; open pulls from those branches (`POST /api/v1/repos/<owner>/<name>/pulls`, `head: "contrib/<agent>/<segment>/<topic>"`); read and update its own pulls, checks included. Everything else answers 403 (`src/http/contribute_gate.ts`, `allows` in `src/core/contribute_token.ts`). It never reaches the default branch and a person merges.
- **Lifetime:** 24 hours. `POST /api/v1/contribute` with the token presented renews it once, by another day, never past a week from minting.
- **Own branches:** the agent name is claimed, so two tokens may share one. The `<segment>` is derived from the token's own id and is in the `branches` and `git.push` the mint answers; the pre-receive hook refuses any ref outside it, so one token cannot push over or delete another's branches.
- **Limits:** 5 tokens an hour and 20 a day per address (hashed), 120 requests a minute per token; at most 5 pulls open per token, 20 opened a day per token and 30 a day from all of a repository's outside tokens (counted from the pull rows; over it answers 429).
- **Claimed, not verified:** the agent name and origin are what the agent said. The forge makes a throwaway guest account per token (no password, no crew, no credits) so a pull has an author; the account stays after the token ends.
