# Trusted sources (#8937)

Settings → Trusted sources lists who folds in without a person's review: an account **on a named forge**, until a date, set by whom. The same name on another forge is a stranger. Remove is one click; past its date an entry falls to review by itself, with a `trust.expiring` note 3 days before. Every change is an event (`trust.set`, `trust.removed`). The list starts empty: an owner fills it (nothing is seeded by a migration).

A trusted source's pull (recorded in `pull_source`, from a followed upstream's address) is admitted by the autonomy tick like the crew's own: its check, the boot proof and the walls still stand, then it lands by true merge with `Landed-from` / `Landed-via` trailers. The walls (`src/crew/fold_walls.ts`) are an allowlist: a trusted pull may change `src/`, `test/`, `docs/`, `examples/` and the README; any other path waits for a person, and so do secrets, credentials, permissions, the contract, release machinery, every migration and the machinery that enforces these walls (fold-in, autonomy, the trust list's actions, page and screen, the auth routes, event audiences). Everyone else is a guest: nothing runs with secrets and the pull waits on `/review` with Approve and Decline.

Work whose `Landed-via` already names this forge is not taken again, so forges following each other in a ring do not re-land it. The kill switch ("Stop all folding in") ends all of it at once; "Revert landings" opens a revert pull for everything one source landed.


**Where it comes from.** A pull is stamped with its source only when the upstream follow opens it, from the followed address (`https://forge/account/repo`), once; a person's or a guest's pull under the same branch name is never stamped. The account is the owner of the followed repository, **not a verified commit author**: trust is "work from the repository this account owns", and commits keep whatever author they carry. There is no other intake: the autonomy tick's sweep is how it lands.

**Visible.** A landing carries `Landed-from` / `Landed-via` trailers, the `pull.merged` event names `source`, and the changelog (which swaps live when a pull merges) credits the row "folded in from account@forge".

**Both doors.** Settings → Trusted sources on the web, and **Trusted sources** in the terminal's command palette (a forge admin's): `a` trusts, `x` removes, `s` is the kill switch (stop or resume), `v` reverts what the one under the cursor landed. Both ask before reverting, and both go through `src/actions/trusted_sources.ts`.

## Following several sources (#9003)

Settings → Trusted sources shows each entry's end as a date and the days left (`Until 2026-12-02 (29 days left)`); a date is read as the end of that UTC day, and a day that does not exist (`2026-02-31`) or any other shape is refused.

A repository's settings (**Followed sources**) follow any number of sources next to its one upstream: paste one per line, `address [branch] [as account]`, in one action. An address is an https or http git address (a forge, or a Forgejo fork); it is read anonymously, or with the actor's connected origin when its https origin is the address's. A migrated repository links back by adding where it came from. The account a source's work is trusted as is the address's owner (`jmoran` for `…/jmoran/forge-jay.git`); only a forge admin who is a person may name another with `as` (for `https://forge-apps.benjivers.com/apps/foundry.git`, `as benjivers`). It is never taken from anything the source says.

Every 30 minutes (and on "Check sources now") each source is checked like the upstream: a new head that merges cleanly opens one pull, `upstream/<source>-<tip7>`, stamped with the source; the next head moves that pull rather than opening another. A trusted account's pull lands on its own; any other account's waits as a guest. A conflict opens one issue for the crew, and no second while it is open; the agent's pull that closes it carries the source. A fold of 50 commits or more, and the crew's resolution of a conflict, are reviewed by the crew before they land; all of them land by true merge.

## Followed sources at the terminal

On a repository's About card an admin presses `s` for the list of followed sources: `a` follows an address (`<url> [branch] [as account]`), `x` stops following the one under the cursor, `u` checks them all now. These go through the same actions as Settings → Followed sources, so the gate (admin of the repository), the audit and the event are the same, and an open settings page updates as the terminal writes.

A source's address is fetched like the repository's own upstream: `vettedEnv` vets the host (private and loopback addresses are refused) and pins the address that passed, https and http only. The clock checks sources four at a time and starts no new check once a sweep has run ten minutes; what is left is due at the next tick.

A pull that an agent opens or edits to say it closes a source's conflict issue is stamped with that source when it is opened or edited (`adoptResolution`), never by a predicate that only reads.
