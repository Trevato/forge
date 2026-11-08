# Flows

`/<owner>/<repo>/flows` is one picture per repository (#9434): on the left what flows in — the origin it was forked from, the upstream and sources it follows, the npm packages its `package.json` pins with the newest release upstream — and on the right what flows out: its forks and the mirror it pushes to. Each line has its state and when it last moved.

- **No crew, no model.** Reading pins, comparing versions (`src/flows/semver.ts`), the gap (patch, minor, major), and the page are deterministic. Test: `test/flows.test.ts`, no credential.
- **Read upstream.** An admin of the repository taps *Read upstream releases now* (same-origin POST); the radar asks the npm registry for each exact pin and stores the answer in `dep_latest`. The page itself never touches the network.
- **Doors.** A **Flows** entry in the repository header's More menu (and the palette, from the same `repoSteps` list), and the terminal's *Flows of a repository* verb (`src/tui/screens/flows.ts`). Both read through `readFlows` (`canRead`, `visibleForks`) and start the radar through `startRadar` (`src/flows/start.ts`): admin only, never an agent.
- **Bounded.** A run asks four packages at a time within 30 s total; a repository has one run at a time; one identity gets four runs a minute. Followed and upstream URLs are shown without userinfo, query or fragment.
- **Pins.** Only exact floors (`1.2.3`, `^1.2.3`, `~1.2.3`) are compared; tags and URLs are skipped. Names are validated before they reach a URL.

- **Link health (#9561).** Every line carries a health badge: healthy, news, diverged, unreadable, not read lately (no comparison in 90 minutes) or paused (`followHealth`, `src/flows/view.ts`). A mirror's own origin shows as a line from the head reading in `origin-ahead.md`.
- **Probe.** The clock already compares heads (`checkDue` for the upstream and sources, `runAheadReads` for an origin); an admin's *Compare heads now* (`POST /:owner/:name/flows/probe`, `src/flows/probe.ts`) runs the same reads on ask: admin only, never an agent, one at a time, four a minute.
- **Bounded.** A probe reads at most 8 enabled sources, four at a time, and answers within 30 s; it announces itself (`repo.links_probed`, readers of the repository) so an open page offers the refresh. An origin line is stale on the same 90-minute rule; every origin reading records when it was taken.
- **Terminal.** The Flows screen shows the same lines with health tones and the same gates: `c` compares heads (admin), `p` pulls in what's new (writer, `takeFromOrigin`), `o` names the page that offers a pull to the parent. A guest sees only what they may read.
- **Actions.** A writer of a mirror with news sees *Pull in what's new* (the existing `sync/take`, which refuses a diverged mirror); a writer of a fork sees *Offer what's useful* (the existing pull-to-parent page).

Left out: the CHANGELOG sections between pin and newest (dropped until a lookup can read one within a byte bound); a schedule and the issue the crew files from a report; advisories and code scanning (and the release block on a new high finding); per-line buttons (actions are listed under the columns); counting a fork's commits ahead of its parent; GitHub release tags; the all-repositories admin view; "last moved" for forks. Each is its own pull on top of `dep_latest` and `readFlows`.
