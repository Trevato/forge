# SQLite files as tables

A `.db`, `.sqlite` or `.sqlite3` file whose first bytes are the SQLite header opens on the blob page as its tables and views (`src/web/render/sqlite.ts`).
A file with one of those names but no header stays an ordinary binary file.
The list shows each name, its kind, its row count (tables only; a view is never counted) and its columns; a table that cannot be read says so in its row.
Click a name (`?table=<name>`) for its first 100 rows, columns capped at 100 and cells at 300 characters; NULL and a BLOB's size are written as words.
The database is opened read-only in memory from the committed bytes and closed again; no SQL comes from the reader, and a table name is used only if `sqlite_master` lists it.
A name the file does not hold goes back to the list with a note, and that page is not kept in the page cache.
Up to 5 MB is drawn; a larger file shows Download. A truncated or damaged file shows the source with a one-line reason. Raw and Download work as for any file.

## In the terminal

The terminal's file screen (`src/tui/screens/workspace.ts`) already covers a SQLite file as it does any binary: it says `Binary file, <size>.` and never prints bytes. It does not list tables; for that, open the blob page in the browser, or download the file and run `sqlite3` on it.
