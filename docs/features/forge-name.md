# Is a forge name free?

`GET /forges/name/<name>` says whether the home page's Start my forge would
take that name, as `{"verdict":"free"|"taken"|"invalid"|"reserved","why":"…"}`.

- **Verdicts.** `invalid`: not 1-39 characters of a-z, 0-9 and `-`, or starts or
  ends with `-`. `reserved`: one of the forge's own words (`admin`, …).
  `taken`: a forge of that name exists or is being made. Otherwise `free`.
- **One rule.** The door (`POST /forges/start`) refuses by the same function
  (`src/spawn/name_verdict.ts`), so `free` is never a lie.
- **Try:** `curl https://<forge>/forges/name/some-new-name`.
- **Limits.** More than 60 asks a minute from one address is a `429` with
  `retry-after`. Every answer is `no-store`.
- **In the terminal:** signed out, open the palette (ctrl-k), "Is a forge name
  free?", type a name, Enter; a toast gives the reason. It uses the same
  `forgeNameVerdict` (`src/actions/spawn.ts`) as the route.
- Tests: `test/forge-name.test.ts`.
