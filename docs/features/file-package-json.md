# A `package.json` opens as its manifest

A file named exactly `package.json` opens as rows instead of raw text: name and version, one line of facts (`type`, `engines`, license, package manager), then **Scripts** (name, command in mono), **Dependencies**, **Dev dependencies**, and peer/optional dependencies, each with its range. Source is one tap away (`?view=source`). `package-lock.json` and other `.json` keep the config form.

- Malformed JSON, JSON that is not an object, or a manifest with no name, facts or sections keeps the source view with no banner.
- At most 500 rows per section, then `N more not shown`. Files over 1 MB keep Source.
- Every cell is escaped; drawn on the server; no script, no new CSS (`.package-view` is a hook with no rule). Commands and ranges are `code.break` (wrap anywhere) in the existing `.table-scroll`, so a phone never gets a wide page.

**Terminal:** the workspace opens the same rows (`packageTable` in `src/tui/screens/workspace.ts`, over the same `parsePackage`); `s` flips to the source.

Code: `src/web/render/package-json.ts`, `src/web/render/kinds.ts`. Tests: `test/render-package-json.test.ts`, `test/tui-workspace.test.ts`.
