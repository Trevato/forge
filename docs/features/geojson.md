# GeoJSON (.geojson) as an outline and a properties table

Open a `.geojson` file in a repository and see its features drawn as an outline, with a table of their properties.

- **Web:** the blob page draws an inline SVG on the server (`src/web/render/geojson.ts`): points, lines and polygons, equirectangular with longitude scaled by the cosine of the middle latitude, fitted to the bounding box. It scales to the column. Below it is a table of the first 100 features (geometry type, then up to 12 property columns, cells cut at 200 characters). A wide table scrolls sideways in a focusable region (Tab to it, arrow keys to scroll). `?view=source`, Raw and Download work as for any file.
- **Terminal:** the workspace opens a `.geojson` as the same table (`src/tui/screens/workspace.ts`, sharing `parseGeoJson` and `propertyRows`); `s` flips to the source. The status line reads `3 features`, with `first 100 shown` when cut.
- A FeatureCollection, a single Feature or a bare geometry is accepted. A feature without geometry is listed but not drawn; with none drawable a sentence says so. An empty collection shows only the count.
- Above 5,000 features nothing is drawn; above 20,000 vertices the outline is thinned evenly. The count stays true. No map tiles, no network.
- A file that is not valid GeoJSON (bad coordinates, unknown type) shows as JSON with a one-line reason. All text is escaped.
