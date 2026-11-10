# /docs

`GET /docs` redirects (302) to the `docs/` folder of the forge's own repository (`FORGE_SENTINEL_REPO`, default `trevato/forge`) when it is public here; otherwise to the same folder on the upstream that llms.txt's clone line names. `GET /docs/NAME.md` does the same for one file; NAME must match `[A-Za-z0-9_-]+`, anything else is a 404. The target comes from configuration only. Footer and the `?` sheet link "Docs". Code: `src/web/pages/docs_link.ts`.

Only files directly in `docs/` are reachable as `/docs/NAME.md`; files in subfolders (`design/`, `features/`) are not, since NAME cannot contain a slash. Reach them by browsing from `/docs`.
