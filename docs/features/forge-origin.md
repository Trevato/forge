# A forge is an origin (#8900, first piece)

Connect another forge at `/settings/origins` the way you connect Forgejo: type its address, paste a token it gave you (Settings, Tokens there; `ro` is enough to bring code across). `discover` asks `GET /api/v1/version`; a forge answers `{"version", "software":"forge"}`, and is stored as an origin with `software = forge` (kind `gitea`, the dialect it speaks).

- **Picker:** `GET /api/v1/user/repos` lists the token's account's repositories, private ones included, in the Gitea shape. Only that route speaks the Gitea shape; a repository's own JSON is unchanged.
- **Credential:** the token travels as `Authorization: token …` for the API (accepted as a Bearer token) and as Basic through `GIT_CONFIG_*` for git — never argv, never config.
- **Mirror:** brings the code and its history, and the issues, pulls and comments, read in the forge's own JSON (`src/origins/providers/forge-work.ts`) with the real author kept. The origin's card and `GET /api/v1/user/origins` (`carries`) say what did not come: labels and how the app runs (not yet), and its data and secrets (never by default).
- **Write-through:** a comment, an issue or a state change here goes to the other forge first, with the connecting person's token (`rw` needed), and is refused with nothing changed here when the forge is down or says no. A pull is opened there with `createPull` (the contribute path); its merge comes back with the next sync.

Not yet: webhooks and a catch-up for missed events, review and check state coming back live, guest rules for a crew on the receiving side, following upstream with one action.

Not in the first piece, in order: sign in through OAuth, migrate an app whole with its run and build, follow upstream between forges with a pull back, and the one-page paste-a-link path. Test: `test/forge-origin.test.ts` runs two forges against each other.

## Both doors, and what was exercised

The terminal reaches the same code as the web and the API: `src/tui/screens/issue.ts` and `pull.ts` comment and change state through `addCommentThrough` and `setIssueStateThrough` (`src/actions/issues.ts`), which call `providers.createComment` / `setState` when the repository is a mirror. No terminal screen or entry changed, so the write-through tests cover it; there is no separate terminal path to test.

A forge's comments carry no edit time, so `updatedAt` is read when the forge sends one and is the creation time otherwise: an edited comment syncs once the forge reports edits. A thread is paged to its end; one of more than 100,000 comments is a failed sync, never a short one.

The preview of the pull was not exercised: the write-through is proven by `test/forge-origin.test.ts` (two forges in one process, including the origin going down and coming back), not by hand on the preview.
