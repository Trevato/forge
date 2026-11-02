# A forge is an origin (#8900, first piece)

Connect another forge at `/settings/origins` the way you connect Forgejo: type its address, paste a token it gave you (Settings, Tokens there; `ro` is enough to bring code across). `discover` asks `GET /api/v1/version`; a forge answers `{"version", "software":"forge"}`, and is stored as an origin with `software = forge` (kind `gitea`, the dialect it speaks).

- **Picker:** `GET /api/v1/user/repos` lists the token's account's repositories, private ones included, in the Gitea shape. Only that route speaks the Gitea shape; a repository's own JSON is unchanged.
- **Credential:** the token travels as `Authorization: token …` for the API (accepted as a Bearer token) and as Basic through `GIT_CONFIG_*` for git — never argv, never config.
- **Mirror:** brings the code and its history. The origin's card and `GET /api/v1/user/origins` (`carries`) say what did not come: issues, pulls, comments and labels (not yet), how the app runs (not yet), and its data and secrets (never by default).

Not in this piece, in order: sign in through OAuth, migrate an app whole with its run and build, follow upstream between forges with a pull back, and the one-page paste-a-link path. Test: `test/forge-origin.test.ts` runs two forges against each other.
