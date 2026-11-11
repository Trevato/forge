# App templates

A site admin marks repositories as app templates at `/settings/app-templates` (Settings → App templates), or with `POST /api/v1/admin/app-templates` `{ "repo": "owner/name", "marked": true }` (admin scope; anyone else gets 403). The marking is the `app_template` table. `trevato/app-template` is marked by default, comes first, and cannot be unmarked.

New app (`/apps/new`, and the terminal's New app) shows a "Start from" picker when more than one marked template is readable by the caller; with one, nothing changes. `GET /api/v1/app-templates` lists what the caller is offered. A template the caller cannot read is never listed, and naming it (`template` on `POST /api/v1/apps`, `?template=`) answers 404.

Code: `src/core/app_templates.ts` (read), `src/actions/app_templates.ts` (mark).
