# A new forge's first ten minutes

For site admins. A forge started in its own cell (a child forge) is treated gently while it is new.

- **Requests are held while it wakes.** A request for a sleeping forge, a form's POST included, waits up to 20 seconds (`wakeLimits.waitMs` in `src/spawn/host.ts`) for the cell to come up and gets its real answer. A wake that takes longer gets the self-refreshing "waking up" page. At most 16 requests wait on one forge at a time (`wakeLimits.waiters`); the rest get the waking page at once, so a crowd cannot pin connections.
- **No idle sleep.** The idle sweep leaves a forge alone for 10 minutes after its start (`NEW_FORGE_MS` in `src/spawn/cell.ts`).
- **A minute to start.** The parent waits about 60 seconds (`START_PROBES`) for a first start to answer. A start that never answers is asked to stop as a sleep is (SIGTERM first), so a slow boot is not written down as a crash.
- **The boots proof.** The forge's reachability proofs include `boots`: it fails when a start in the first ten minutes of the child's record never exited cleanly. It is read from the child's own `boots.json`, and an early unclean start stops counting an hour after it happened, so the alarm clears on its own.
- **Where a person sees it.** On the web, `/forges` (Forges you sent); in the terminal, the "Forges you sent" screen. Each forge's line there reads `Running, not reachable: boots 1 unclean restart in the first ten minutes` while the proof fails, next to any other failing proof. A passing proof adds no words. The proof is read when reachability is next swept (every five minutes).
- **What the proof cannot see.** The newest start is left out: from outside, a start that is still running cannot be told from one that crashed. So a crash with no start after it counts only once the next start is written, for example when the forge next wakes. The window counts from the forge's very first start (`firstAt` in `boots.json`), even after the ledger keeps only its last 50 starts.

Code: `src/spawn/cell.ts` (`firstAnswer`, `sleepIdle`), `src/spawn/host.ts` (`wakeLimits`), `src/kernel/boots.ts` (`uncleanInFirstMinutes`), `src/spawn/reach.ts` (`proveBoots`). Tests: `test/first-ten-minutes.test.ts`.

## The first screen: one box

For the owner of a new forge (the site admin, or their everyday account), the home is one box until they have told the crew something.

- **Web.** `/` shows "What do you want built?", the box, "Tell the crew", and one line about what pays for the crew (`crewNote` in `src/web/studio/crew_key.ts`): the included credit with what is left, "spent", or "needs a model key". Without a key of their own an admin also gets a link to Subscriptions (`/settings/subscriptions`), where the key is added. The first screen carries no key field, no password field and no second form, and exactly one primary button.
- **Terminal.** The home (`loadClientLines` in `src/tui/screens/dashboard.ts`) reads the same two lines, and `t` opens a prompt "What do you want built?" that keeps the words as the box does (`keepThought`).
- **The everyday account is offered after the first tell**, not before: once the owner has a tell (an issue they or their everyday account wrote), the home becomes the everyday one, and the "make your everyday account" step (web) or line (terminal, `E` makes it, `K` keeps admin) appears. Until then neither door mentions it.

Code: `src/web/pages/next-steps.ts` (`firstTell`), `src/core/next-steps.ts`. Tests: `test/next-steps-card.test.ts`, `test/tui-first-tell.test.ts`.
