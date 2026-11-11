# GPS tracks (.gpx) as a route outline

Open a `.gpx` file in a repository and see the route drawn as an outline, with its track name, distance, climb and point count.

- **Web:** the blob page draws an inline SVG on the server (`src/web/render/gpx.ts`). It scales to the column (`max-width: 100%`), so it fits a phone; the facts are `status-rows`. `?view=source`, Raw and Download work as for any file.
- **Terminal:** the workspace opens a `.gpx` as a Fact / Value table (`src/tui/screens/workspace.ts`, sharing `parseGpx` and `gpxFacts`); `s` flips to the source. The status line reads `4 facts`.
- Distance is the haversine sum, climb the sum of rises. No map tiles, no network.
- Beyond 20,000 points (`POINT_CAP`) the outline is thinned evenly, ends kept; the count stays true.
- A file that is not readable GPX shows as source, with a one-line reason on the web. DOCTYPE entities are never expanded; all text is escaped.
