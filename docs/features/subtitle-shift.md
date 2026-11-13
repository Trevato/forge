# Shift a subtitle file

A `.srt` or `.vtt` file's page has a "Shift every cue by (seconds)" field for writers. Type `2.5` or `-1`, press "Shift and save": every cue's start and end move by that much and the result is saved as one commit, "Shift subtitles by +2.5 s". Readers and guests see no field.

- The offset is a signed decimal in seconds, at most 3600 either way; anything else is refused on a page that says why and writes nothing. A time never goes below zero.
- Only the two timestamps of each timing line change. Numbers, ids, cue settings, notes, text and line endings (LF or CRLF) are kept byte for byte. A timestamp is written as `MM:SS.mmm` with three millisecond digits (`1,5` becomes `1,500`); an hour field keeps the digits it had (`1:02:03,004` stays `1:02:03,004`), and a WebVTT stamp without hours grows one only when the shift carries it past an hour.
- A file with no readable cue is refused: there is nothing to shift.
- On a protected default branch, an ordinary writer's shift goes to a new branch (`<you>/shift-<file>-<id>`) and opens a pull; an admin's lands on the branch being viewed. A ref that is not a branch (a tag, a commit) does the same.

## In the terminal

With a repository open, the palette offers "Shift subtitles" to a writer only. It asks for the file's path, then the seconds, and shifts the file on the default branch. It is the same action as the page (`src/actions/subtitle_shift.ts`), so the gate, the range, the commit message and the protected-branch rule are the same; the write is announced as a push, so an open web page of the file follows.

The pure shift is `src/core/subtitle_shift.ts`; the form is `shiftForm` in `src/web/render/subtitles.ts`, posting to the file edit route.
