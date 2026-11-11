# A compose file opens as its services

`compose.yaml`, `compose.yml`, `docker-compose.yaml` and `docker-compose.yml` open as a table instead of raw YAML. Source is one tap away (`?view=source`), and Raw is beside it.

- **Rows:** one per service: its image (else `build` and the context), ports, volumes, `depends_on` and the **names** of its environment variables. Values are never shown.
- **Fallback:** a file that is not valid YAML, holds several documents, is not a map or has no `services` shows as YAML with one line saying why, and no error banner.
- **Cap:** at most 100 services and 50 entries per column, then a `more services not shown` line. Files over 1 MB keep Source. Values are cut at 300 characters.
- **Phone:** the table scrolls sideways inside its own region.
- **Terminal:** not drawn there; the terminal shows a compose file as source, as it does the other kinds it has no table for.
- Every value is escaped, drawn on the server; no script, no new CSS, no dependency.

Code: `src/web/render/compose.ts`, `src/web/render/kinds.ts`. Test: `test/render-compose.test.ts`.
