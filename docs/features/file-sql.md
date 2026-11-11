# A `.sql` file opens as its schema

A file ending `.sql` opens as one block per statement instead of raw text. Source is one tap away (`?view=source`).

- **`CREATE TABLE`:** the table name, then a row per column: **name**, **type**, **NOT NULL**, **PRIMARY KEY** and **DEFAULT** (`—` when absent). A table-level `PRIMARY KEY (a, b)` marks those columns. Other table-level constraints (`FOREIGN KEY`, `UNIQUE`, `CHECK`) are listed under the table.
- **Anything else** (`CREATE INDEX`, `ALTER TABLE`, `INSERT` …): one row with the statement's first line.
- **Comments** (`-- …`, `/* … */`) are not statements; a `;` inside a quote or comment does not end one.
- **Cannot be read:** a file with no recognisable statement, or an unterminated quote or comment, shows Source with the reason, never an error. A `CREATE TABLE` it cannot parse is one row like any other statement.
- **Cap:** at most 500 statements and 500 columns a table, then `N more not shown`. Files over 1 MB keep Source.
- Every name is escaped and the page is drawn on the server. No script, no new CSS (`.sql-view` is a hook with no rule).

Code: `src/web/render/sql.ts`, `src/web/render/kinds.ts`. Tests: `test/render-sql.test.ts`.
