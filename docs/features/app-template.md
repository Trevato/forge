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

## The default app is a repository

The app New app starts from when no template is named is `trevato/app-template` (`apps.template` in `forge_setting` names another), copied at its default branch's tip: one commit, no history (#10305). The strings that used to make it (`src/apps/scaffold.ts`) are gone.

- **Name and description.** The template's `template.json` is `{ "name": "app-template", "description": "A new app on the forge.", "files": [...] }`: the literals the forge replaces, and the only files it replaces them in (`.json` files get the JSON-escaped form). Nothing else is touched, so the template runs and passes its own tests as it stands. `template.json` is not copied. An empty description keeps the template's line. (This is the root template's form; a folder of a template repository uses the `{{name}}` form above.)
- **A copy in every forge.** `templates/app-template.json` is the template's files, carried in the image (`Dockerfile` copies `templates/`). A forge without the repository (a child, a pack forge, a fresh install), or whose copy has no readable `template.json`, uses it; so does `src/spawn/template_birth.ts` (`bakedFiles`). Refresh it with `bun scripts/take-template.ts <checkout>`, which reads bytes and refuses any file that is not UTF-8 text (the bundle is JSON), and marks the bundle `pinned: true` with HEAD as `commit`. A test fails when a pinned bundle's `commit` is not a 40-hex id; the file in the tree says `pinned: false` until it is taken. **Not done:** the file in the tree was generated from the removed strings, so its `commit` is the forge commit they were written at, not a commit of trevato/app-template, and the release build does not yet run `take-template.ts` at a pinned commit; until it does the copy and the repository can differ.
- **`apps.template` is operator-only on purpose.** It is a `forge_setting` key with no page or terminal control: which repository every new app copies is a forge-wide choice, set by whoever runs the forge, not by an app owner. A user picks another template per app with `template:` (see above).
- **Two `template.json` forms, pinned by a test.** The root template names its literals (`name`, `description`, `files`); a folder of a repository of templates uses `files` and `literals`. Each parser rejects the other's form. Both read paths with no dot segments, no `.git`, no absolute path, and the tip copy has the same caps as the rest (500 files, 512 KiB each, 4 MiB; over any falls back to the image's copy).
- **Checked both ways.** In the template's repository a pull runs its own `bun test`, then `bun scripts/birth-check.ts <checkout>` from this repository, which fills the tip as New app does, boots the result on a port the kernel chose (retried if taken) and waits on `/healthz` and `/`. Wiring that into the template repository's `forge.json` is done in that repository, not here.
- **Code and tests.** `src/apps/template.ts`; `test/app-template.test.ts`, `test/template-scripts.test.ts` (the two scripts). The fresh-app suites (`test/scaffold*.test.ts`, `test/apps-new.test.ts`) boot the filled copy.
