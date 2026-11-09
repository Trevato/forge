# Calendar files (.ics) as a list of events

Open a `.ics` file in a repository, such as a calendar export, and read its events as a table: start, end, summary, location, in file order.

- **Web:** the blob page draws the table on the server (`src/web/render/ics.ts`, `parseIcs`). `?view=source`, Raw and Download work as for any file.
- **Terminal:** the workspace opens a `.ics` as the same table (`src/tui/screens/workspace.ts`, sharing `parseIcs` and `EVENT_CAP`); `s` flips to the source. The status line reads `N events`.
- Folded lines are unfolded and `\,` `\;` `\n` escapes are undone. UTC times show as `UTC`, `TZID` times keep their zone name, all-day events show dates and the last day (the file's end is exclusive).
- The first 500 events (`EVENT_CAP`) are shown; the rest are counted.
- A file with no `BEGIN:VCALENDAR` is not a calendar: it shows as source, with a one-line reason on the web.
- All text is escaped on output; the parser is pure and never throws.
