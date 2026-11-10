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

## A repository of templates

A marked repository whose top-level folders hold both `TEMPLATE.md` and `template.json` is offered folder by folder, in place of the repository (`templateChoices`, `src/apps/template_folders.ts`). A folder missing either file is not offered.

- **Named** `owner/name/folder` on the same doors (page picker, `GET /api/v1/app-templates`, `template:` on `POST /api/v1/apps`). The picker shows TEMPLATE.md's first line as the title and the next as its description, escaped.
- **Copied:** only that folder's files, to the new repository's root, under the same caps and symlink refusal.
- **Literals:** `template.json` is `{ "files": ["README.md"], "literals": ["{{name}}", "{{description}}"] }`. Each named file must be in the folder (no `..`, no leading `/`) and each literal one of those two; anything else is `template_invalid` and nothing is made.
- **Never run.** A script in a folder (`new.mjs`) is copied as a file and not executed.
- The terminal's New app prompt lists the folders too (`openNewApp` loads the choices before the screen opens).
