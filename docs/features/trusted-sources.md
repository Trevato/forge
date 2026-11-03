# Trusted sources (#8937)

Settings → Trusted sources lists who folds in without a person's review: an account **on a named forge**, until a date, set by whom. The same name on another forge is a stranger. Remove is one click; past its date an entry falls to review by itself, with a `trust.expiring` note 3 days before. Every change is an event (`trust.set`, `trust.removed`). The list starts empty: an owner fills it (nothing is seeded by a migration).

A trusted source's pull (recorded in `pull_source`, from a followed upstream's address) is admitted by the autonomy tick like the crew's own: its check, the boot proof and the walls still stand, then it lands by true merge with `Landed-from` / `Landed-via` trailers. The walls (`src/crew/fold_walls.ts`) are an allowlist: a trusted pull may change `src/`, `test/`, `docs/`, `examples/` and the README; any other path waits for a person, and so do secrets, credentials, permissions, the contract, release machinery, every migration and the machinery that enforces these walls (fold-in, autonomy, the trust list's actions, page and screen, the auth routes, event audiences). Everyone else is a guest: nothing runs with secrets and the pull waits on `/review` with Approve and Decline.

Work whose `Landed-via` already names this forge is not taken again, so forges following each other in a ring do not re-land it. The kill switch ("Stop all folding in") ends all of it at once; "Revert landings" opens a revert pull for everything one source landed.


**Where it comes from.** A pull is stamped with its source only when the upstream follow opens it, from the followed address (`https://forge/account/repo`), once; a person's or a guest's pull under the same branch name is never stamped. The account is the owner of the followed repository, **not a verified commit author**: trust is "work from the repository this account owns", and commits keep whatever author they carry. There is no other intake: the autonomy tick's sweep is how it lands.

**Visible.** A landing carries `Landed-from` / `Landed-via` trailers, the `pull.merged` event names `source`, and the changelog (which swaps live when a pull merges) credits the row "folded in from account@forge".

**Both doors.** Settings → Trusted sources on the web, and **Trusted sources** in the terminal's command palette (a forge admin's): `a` trusts, `x` removes, `s` is the kill switch (stop or resume), `v` reverts what the one under the cursor landed. Both ask before reverting, and both go through `src/actions/trusted_sources.ts`.
