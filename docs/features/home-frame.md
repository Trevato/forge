# Home paints its frame first (#7660)

Signed in, `/` answers from memory. Its slow regions — `kpis` (figures, vitals,
clog, alarms), `waiting`, `panels`, `asked` (the tab's count) and `feed` — are
kept per viewer as last drawn (`src/core/region_memory.ts`, driven by
`src/web/studio/home_last.ts`).

- Current (write clock unmoved, under 30 s): served as is, phase `…;desc="hit"`.
- Stale (a write since): served anyway, wrapped `<div id="home-<name>" data-region data-refresh="/live/home/<name>">`,
  redrawn after the response (at most every 5 s per region), and the page's
  script fetches `/live/home/<name>` and swaps the fresh one in. Each region is
  its own request, so a late one never blocks another.
- Never drawn for this viewer in this process, older than 10 min, or drawn
  under different access: drawn while they wait, once.

**Access.** A copy is only reused while the viewer's access fingerprint
(`src/core/access_fingerprint.ts`: their role and the repositories the one
`REPO_VISIBLE` rule lets them read) is what it was when the copy was drawn. Losing
admin, leaving a team, a repository turning private or its owner being suspended
each change it, so the next response draws fresh, with or without JavaScript.
`test/home-memory.test.ts` revokes access and checks the first response.

**Keys.** The variant is rebuilt by `homeVariant` from `all`, a valid feed
`cursor` and its `day`; anything else in the query string is ignored, so the keys a
client can make are few. Each viewer holds at most 16 entries and the store 256
viewers; a flood of queries pushes out only the sender's own.

**No script.** A stale region carries a `<noscript>` link to its fragment; that
is the whole path without JavaScript, and it is as old as the copy until followed.
The swap is a small script of its own (`refreshJs`) rather than `liveRegionsJs`:
that one pulls only on an event or a beat, and a beat on a region that did not
change would poll for as long as the page is open.

**Not covered.** A change that does not move access (another admin's action, an
assignment, a mute) shows as stale until the swap lands, at most one request
behind. Pins drop the owner's `panels` at once (`forgetRegion`), so a redirect to
home shows them.

**Terminal.** The terminal's home (`ssh`, `FORGE_APP_SSH`) is unchanged: it draws
its own screen from the same reads, not from this memory.

Tests: `test/home-frame.test.ts` (thousands of issues; p95 of the server's own
time after a write under 50 ms; first response under 100 KB uncompressed),
`test/home-memory.test.ts`. Tests that write and then read home use
`test/helpers/home-fresh.ts`, which does what the page's script does.

## An empty timeline

A signed-in person whose timeline has nothing in it sees one line under the tell box, the named `empty` component with a title only: "Nothing yet. Tell the crew what to build." (`EMPTY_FEED`, `src/web/studio/feed.ts`). The tell box is already first on the page, so no field steals focus (a phone keyboard would cover the sentence). The terminal's Feed screen draws the same constant.
