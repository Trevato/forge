# An OpenAPI document opens as its operations

`openapi.json`, `openapi.yaml`, `openapi.yml` and `*.openapi.{json,yaml,yml}` open as the API they describe, not as the schema; Source is one tap away (`?view=source`).

- **Is it OpenAPI?** The top-level `openapi` starts with `3.`, or `swagger` is `2.0`. A file under one of those names that parses as anything else keeps the config view it always had; one that says `openapi:` or `swagger:` at the top but does not parse shows its source with the reason. Past 500 operations the first 500 are drawn and one line counts the rest.
- **One table per tag**, in the order the document's `tags` list gives, then tags only operations name, then untagged operations last. One row per operation: method, path, summary, and `deprecated` when marked. An operation with several tags is listed under its first.
- **Cap:** at most 500 operations are drawn, cut while reading, then one line `N more operations not shown`. Files over 1 MB stay source.
- **Fallback:** an OpenAPI document with no `paths` object, or with no operations, shows Source with the reason.
- Every string is escaped and cut to 300 characters. No script, no new CSS: it uses the `table` component. YAML is read by the parser `yaml-config.ts` uses; no dependency added.

**Terminal:** the workspace opens it as Tag, Method, Path and Summary rows ("N operations" in the status line, deprecated in the summary), over the same `parseOpenApi`; `s` flips to the source.

Code: `src/web/render/openapi.ts`, `src/web/render/kinds.ts`, `src/tui/screens/workspace.ts`. Tests: `test/render-openapi.test.ts`, `test/tui-workspace.test.ts`.
