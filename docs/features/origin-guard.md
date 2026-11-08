# The operator guard and proposing through your fork (#8938)

The operator may name hosts to guard (`FORGE_ORIGIN_CLIENT_ID`, `FORGE_ORIGIN_DENY_PUSH`; see "The operator guard" in [`docs/ORIGINS.md`](../ORIGINS.md)). On such a host an origin is refused when its account administers the instance or can push to a protected repository.

- **Paused:** when the guard cannot verify an account (the host is down, say), the origin still reads and syncs but writes nothing. `/settings/origins` shows "Couldn't verify this connection; writes paused" with a **Check again** button (`POST /settings/origins/:id/check`, once a minute per origin). A refused origin shows **Needs re-auth**.
- **In the terminal:** Connected origins marks a paused origin `writes paused`, says why on the top line, and `v` checks it again, saying what it found in the page's words (`CHECK_WORDS`, `src/actions/origin_words.ts`). Test: `test/tui-origins-guard.test.ts`.
- **Try it:** set `FORGE_ORIGIN_DENY_PUSH=system/*` and connect a token that can push there on Settings → Origins; it is refused with the repository named.
- **Propose via your fork:** an account that can only read a repository, or any repository the operator protects, proposes through the account's own fork there (`src/origins/fork-route.ts`, `contribute` in `src/actions/contribute.ts`). Test: `test/propose-via-fork.test.ts`; the guard: `test/origin-guard.test.ts`.
