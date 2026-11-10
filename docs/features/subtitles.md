# Subtitles as a transcript

`.srt` (SubRip) and `.vtt` (WebVTT) files open as a transcript: one row per cue, its start time and its text.
One parser, `parseSubtitles` in `src/web/render/subtitles.ts`, serves both doors.

- **Web:** the blob page draws a bare two-column table (`Start`, `Text`) on the server; up to 5,000 cues. Tags (`<i>`, `<v Name>`, `{\an8}`) are stripped and the text escaped. A cue that does not parse is counted in one line *below* the table, naming the first one and what to do ("check the arrow line"); the rest still draws. `?view=source`, Raw and Download work as for any file.
- **Terminal:** the workspace file view shows the same cues as an aligned table, like `.csv`; `s` flips between the table and the source. The status line reads `N cues` and, when some failed, how many were unreadable.
- A file with no cues shows its source.
- SRT and VTT timing syntax is accepted in either file (comma or dot, hours optional).
