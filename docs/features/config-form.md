# Config files as a form

A `.json`, `.yml`/`.yaml` or `.toml` file in a repository opens as a form (#7336, #7337, part of #7329).

## Reading

The blob page's **Rendered** view draws the file's values as read-only
fields. **Source**, **Raw** and **Download** are where they always are.
A file that is not valid says why, with the line and column, above
its text. Other config files (INI, `.env`) keep their source view.

## Editing

**Edit as form** opens `/:owner/:name/config/:ref/*path`. You need to be
signed in. A private repository's file is a 404 to anyone who cannot read it.

- **Without a schema** each value's type picks its control. A string is a text
  input, or a textarea when it has more than one line. A number is a number
  input and a boolean is a checkbox. `null` is shown as `null`. A nested
  object is a fieldset. An array of scalars is a row of chips, and an array
  of objects is a list of cards you can add, remove and move up or down.
- **With a schema** the fields follow it. An `enum` becomes a select, and
  `description` becomes help text. `required`, `minimum`, `maximum` and
  `pattern` are set as the inputs' own attributes, so the browser checks
  them as you type. The server checks `required`, the bounds, `enum` and
  `type` again on save. It never runs a pattern the repository wrote.
  A glob in `.forge/schemas.json` is matched segment by segment in
  O(glob × path); no regular expression is built from it.
  Properties the schema names but the file does not have are offered as
  **+ key** buttons. Local `$ref`s (`#/definitions/…`, `#/$defs/…`) are
  followed.
- **Finding the schema.** The first one found is used:
  1. `$schema` in the file, if it is a path. A path that starts with `/`
     is read from the repository root; any other path is read from the
     file's folder. A URL is ignored.
  2. A sibling `<name>.schema.json` (`app.yml` and `app.toml` look for `app.schema.json`).
  3. `.forge/schemas.json`, an object that maps globs to schema paths, for
     example `{ "config/**/*.json": "schemas/config.json" }`.

## YAML and TOML

Both read into the same form as JSON and use the same schema lookup. The
difference is the save: they are patched, not rewritten.

- **YAML** goes through the `yaml` package's Document API. Comments, anchors,
  quoting, key order and every line you did not change are written as they
  were. A file you did not change is returned byte for byte. A file of several
  documents (`---`) is one fieldset per document ("Document 1", …), and only
  a document you changed is rewritten. An alias shows as the value it points
  at; a change that only an alias holds is refused, with the reason, rather
  than guessed. A key that is not text, or an alias that fans out to over
  2,000 values, sends the file to its source view.
- **TOML** goes through `@decimalturn/toml-patch`, which keeps comments and
  layout and rewrites only the values that differ. Dates and times show as the
  text they were written as. TOML has no null, so a form that would write one
  is refused. A table is a fieldset and an array of tables is a list of cards.
- After either writes, the result is read back and must equal what the form
  held; if it does not, nothing is committed.
- One limit: YAML sequences are indented the way most of the file does it,
  so a file that mixes both styles has its changed document re-indented.

### The two vendored libraries

Neither is a dependency in `package.json`: each is one bundled file under
`src/web/render/vendor/`, with its licence beside it, run on the server only
(no script is sent to the page).

| Bundle | Pinned | Licence | Why |
| --- | --- | --- | --- |
| `yaml.mjs` | yaml 2.9.1 (eemeli/yaml) | ISC, `YAML-LICENSE` | Its Document API keeps comments, anchors, quoting and key order, which a parse-and-dump cannot. Writing a YAML parser that does the same is far larger and riskier. |
| `toml-patch.mjs` | toml-patch 3.3.2 (@decimalturn/toml-patch) | MIT, `TOML-PATCH-LICENSE` | `patch` rewrites only the values that differ, so TOML comments and layout survive. |

To regenerate (or bump) one, in a scratch directory outside the repository
(this reproduces both files byte for byte; `bun build` writes `// @bun` as
its first line, which the header replaces):

```
bun add yaml@2.9.1 @decimalturn/toml-patch@3.3.2
( echo "// yaml 2.9.1 (eemeli/yaml, ISC), bundled from node_modules/yaml/browser; licence in YAML-LICENSE"
  bun build node_modules/yaml/browser/index.js --format=esm --target=bun | tail -n +2 ) > yaml.mjs
( echo "// @decimalturn/toml-patch 3.3.2 (MIT), bundled from its dist; licence in TOML-PATCH-LICENSE"
  bun build node_modules/@decimalturn/toml-patch/dist/toml-patch.js --format=esm --target=bun | tail -n +2 ) > toml-patch.mjs
cp node_modules/yaml/LICENSE YAML-LICENSE
cp node_modules/@decimalturn/toml-patch/LICENSE TOML-PATCH-LICENSE
```

Copy the four files over their namesakes in `vendor/`. Each bundle's SHA-256
is pinned here, and `test/config-yaml-toml.test.ts` fails when a bundle, its
header or this page disagree:

- `yaml.mjs` sha256 `409e0ae0ebbe4017070541566da9a5ae666f0b4990ce9d8aa20c09c92d277454`
- `toml-patch.mjs` sha256 `b675b1478a5c3e773347425fd476455367b950406f7c2490f2f2c93400b67c3f`

On a bump, change the version in the commands, the headers and the table,
and the two hashes.

Hostile input is bounded before it is walked: a file over 256 KB is never
parsed (page and save both check the size first), YAML aliases and merge
keys share a 2,000-value budget, and nesting deeper than 64 is refused in
YAML and TOML alike.

## Saving

**Review** shows the change as a diff, under a commit message.

- **A writer** commits one commit to the branch.
- **Anyone else** gets **Propose change**: one commit on a new branch and a
  pull request into the branch they were reading. That includes a reader,
  an agent, and a writer facing a protected default branch. A writer's
  branch goes in the repository itself. A reader's goes on their fork; the
  forge makes the fork if they have none, and the usual fork rules apply
  (`actions/propose_edit.ts`).
- A JSON file is written back with its own key order, indent (spaces or tabs),
  line endings and final newline. Numbers keep their spelling.
- A save that changes nothing writes nothing.
- If the file changed on the branch after you opened it, the save stops
  and asks you to review again.

All of this works without JavaScript, as plain form posts: each card button
submits the form, and the form comes back with the change applied.

Files over 256 KB, or with more than 2,000 values, open in the source view
and can be edited as text.

## In the terminal

The workspace is the terminal's editor. Open a repository, press `e` on a
file, then `c`:

- A writer gets the commit dialog, as before.
- A signed-in reader of a forge repository now gets **Propose a change**:
  `ctrl+s` puts the commit on a branch of their fork (made if needed) and
  opens a pull back. This is the same `proposeEdit` the web uses, with the
  same refusals in the same words. The status line says "proposes from your
  fork".
- Before any commit or proposal, each JSON, YAML or TOML file in the change is checked
  against its schema (`schemaRefusal`, found the same three ways). A file
  that breaks it is refused in the dialog, naming the field and the schema,
  and nothing is written.
- There is no form screen in the terminal yet, for JSON, YAML or TOML: values
  are edited as text. #8934 adds one.

## Try it

Every preview's sample repository (`/preview-admin/sample`) holds
`service.yml` and `service.toml` (`src/spawn/preview-config.ts`, seeded by
`spawn/preview-seed.ts`, also into a sample seeded before they existed).
They have comments, an anchor and a merge key (YAML), and a date and an
array of tables (TOML). Open either on the blob page, press **Edit as
form**, change one value and **Review**: the diff touches only that line.
