# Ways to the fleet graph

The fleet graph (`/fleet/graph`) shows runs and spend by the hour and by the day. Wherever spend is shown, you can reach the graph in one step, already narrowed to what you were looking at. The graph checks the names again (`fleetSelection`) and shows only what you may see.

**On the web** (each link is a plain `<a>`, and each name goes in as its own URL-encoded `repo=`, built by `fleetGraphHref` in `src/web/fleet-graph.ts`):

- **Board** (`/board`): "Fleet graph" sits beside the Tokens line. It is a 44px target, and on a phone it wraps under the line. With no `?apps=` it opens your whole graph. With `?apps=` it opens exactly the apps the board lists whose spend you may see (`narrowedGraphHref`). When that list is empty there is no link, so it never shows the whole fleet in place of the apps you asked for.
- **Spend** (`/settings/spend`): "Fleet graph" above the tables opens your whole graph. Each `owner/name` in "By app" opens the graph on that app.
- **An app's page**: under "On its own", Graph opens the graph on that app. Only the owner sees it, as with the rest of that block.

**In the terminal:** on Usage, `f` opens the fleet graph. On a repository's Usage (the palette's "Usage of a repository"), `f` opens the graph on that repository alone, titled `Fleet graph · owner/name` (`src/tui/screens/usage.ts`, `src/tui/screens/fleetgraph.ts`). `w` switches between 24 h and 14 d.
