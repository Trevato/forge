# Forge-to-forge compatibility, measured (#8900)

Written by `scripts/forge-compat-lab.sh`; run it on any docker host to get this table again. It starts three real forges in containers on a private network, behind TLS with a throwaway authority, seeds them, and drives them with HTTP and git. No live forge is touched.

**What "old" is.** The real forge at forge-apps.benjivers.com reports 0.5.29, commit `2d910c08`. That commit and that tag are in no repository this lab can read. The oldest honest stand-in is trunk `ce7846af`, the last commit before `/api/v1/version`: its contract matches the live forge's published OpenAPI on 325 of 332 routes, with the same absences (`/api/v1/version`, `/api/v1/user/repos`) and the same OAuth metadata. The other 7 are routes only the live forge has (admin users, check secrets, org teams); none is one an origin calls. So this is a reconstruction of 0.5.29, not 0.5.29.

**The refused token.** A forge before `/api/v1/version` reads `Bearer` and `Basic` only (`src/http/server.ts` at `ce7846af`). This forge sent `Authorization: token …`, the Gitea scheme, so a good token answered 401 and read as "That token was refused by the origin". `ForgeProvider` now sends Bearer always. Scopes were not the cause: `ro` connects.

**Absent, and what this cannot show.** `absent` is a thing not built, or not checkable here, said plainly.

- An old forge cannot connect another forge at all: it has no forge provider, so that direction asks for an upgrade, not a fix here.
- A webhook needs `admin` scope at the origin, so a `ro` or `rw` token and every sign-in register none; issues and pulls come back on a sync or the sweep. With an admin token the hook registers, but the lab's source refuses to deliver to a private address, as its SSRF guard should, so a delivery end to end is unproven here.
- The live 0.5.29 was read anonymously only: its OAuth metadata, health, OpenAPI and 401s. Nothing was signed in to it.
- Not carried by design or not built: how the app runs, its data and secrets, and following a source by the Followed sources action between forges (this table reads origins, not followed sources).

## Result

