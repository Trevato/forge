# The map, lightly (#8693)

`/map` is every app you can see, one lane each. The first screen is light:

- **Next**: the top 5 ready issues across your lanes, crew lanes first, each with its lane, its number and how many are ready there.
- **Lanes**: one folded row per app with its counts. The row carries a link, `Draw N issues`, that opens `/map?lane=owner/name`: that lane's graph, drawn at the same scale as all lanes, with `Show fewer` to go back. Each lane also links its own map, `/owner/name/map`.

`?lane=` is `owner/name` made of letters, digits, `.`, `_` and `-`, at most 200 characters; anything else, an unknown lane, or one you may not see draws nothing and the page is the light one. The test in `test/map.test.ts` holds the first screen under 50 KB.

The other doors keep the whole graph: `/api/v1/map`, the MCP map tools and the terminal map return every lane, since a program asks for data, not a first paint.
