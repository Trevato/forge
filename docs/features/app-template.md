# New app from a template

A new app can start as a copy of another repository's tip instead of the starter app.

- **Name it:** `template: "owner/name"` on `POST /api/v1/apps` and the MCP `new_app` tool, or `/apps/new?template=owner/name` on the page (a read-only field carries it through the form).
- **Readable by the caller.** A template the caller cannot read answers `no_such_template`, the same as one that does not exist; a private name is never confirmed.
- **Capped.** At most 500 files, 512 KiB per file, 4 MiB in all; over any of them is `template_too_big`, which names all three.
- **No symlinks.** A symbolic link is `template_has_symlink`; a submodule or any other non-file is `template_unsupported`.
- **Refused before anything exists.** The tip is read before the repository is made, so a refusal leaves nothing to take back.
- **Doors:** the page, the API, MCP, and the terminal palette entry "New app from a template" (`templateAppScreen`).
- **Read in one pass:** one `ls-tree` and one `cat-file --batch`, each output capped (`maxBytes`); a blob that will not read is `template_unreadable`.
- Code: `src/apps/template_tip.ts`, `newApp` in `src/actions/apps.ts`. Tests: `test/actions-newapp-template.test.ts`, `test/apps-template-doors.test.ts`.
