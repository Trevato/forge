# Flows

`/<owner>/<repo>/flows` is one picture per repository (#9434): on the left what flows in — the origin it was forked from, the upstream and sources it follows, the npm packages its `package.json` pins with the newest release upstream — and on the right what flows out: its forks and the mirror it pushes to. Each line has its state and when it last moved.

- **No crew, no model.** Reading pins, comparing versions (`src/flows/semver.ts`), the gap (patch, minor, major), and the page are deterministic. Test: `test/flows.test.ts`, no credential.
- **Read upstream.** An admin of the repository taps *Read upstream releases now* (same-origin POST); the radar asks the npm registry for each exact pin and stores the answer in `dep_latest`. The page itself never touches the network.
- **Doors.** A **Flows** entry in the repository header's More menu (and the palette, from the same `repoSteps` list), and the terminal's *Flows of a repository* verb (`src/tui/screens/flows.ts`). Both read through `readFlows` (`canRead`, `visibleForks`) and start the radar through `startRadar` (`src/flows/start.ts`): admin only, never an agent.
- **Bounded.** A run asks four packages at a time within 30 s total; a repository has one run at a time; one identity gets four runs a minute. Followed and upstream URLs are shown without userinfo, query or fragment.
- **Pins.** Only exact floors (`1.2.3`, `^1.2.3`, `~1.2.3`) are compared; tags and URLs are skipped. Names are validated before they reach a URL.

Left out: the CHANGELOG sections between pin and newest (dropped until a lookup can read one within a byte bound); a schedule and the issue the crew files from a report; advisories and code scanning (and the release block on a new high finding); acting on a line in place (update, follow, send back); GitHub release tags; the all-repositories admin view; "last moved" for forks. Each is its own pull on top of `dep_latest` and `readFlows`.
