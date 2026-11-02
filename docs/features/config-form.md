# Config files as a form

A `.json` file in a repository opens as a form (#7336, part of #7329).

## Reading

The blob page's **Rendered** view draws the file's values as read-only
fields. **Source**, **Raw** and **Download** are where they always are.
A file that is not valid JSON says why, with the line and column, above
its text. YAML, TOML and other config files keep their source view.

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
  2. A sibling `<name>.schema.json`.
  3. `.forge/schemas.json`, an object that maps globs to schema paths, for
     example `{ "config/**/*.json": "schemas/config.json" }`.

## Saving

**Review** shows the change as a diff, under a commit message.

- **A writer** commits one commit to the branch.
- **Anyone else** gets **Propose change**: one commit on a new branch and a
  pull request into the branch they were reading. That includes a reader,
  an agent, and a writer facing a protected default branch. A writer's
  branch goes in the repository itself. A reader's goes on their fork; the
  forge makes the fork if they have none, and the usual fork rules apply
  (`actions/propose_edit.ts`).
- The file is written back with its own key order, indent (spaces or tabs),
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
- Before any commit or proposal, each JSON file in the change is checked
  against its schema (`schemaRefusal`, found the same three ways). A file
  that breaks it is refused in the dialog, naming the field and the schema,
  and nothing is written.
