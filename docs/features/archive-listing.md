# Archive listing

A `.zip`, `.tar` or `.tar.gz` (also `.tgz`) in a repository shows what is inside it, without unpacking it to disk. Code: `src/web/render/archive.ts` (the bounded reader, `listArchive`), `archive-view.ts` (the page), `src/tui/ui/archive-note.ts` (the terminal).

## What opens

The name picks the kind and the bytes confirm it (zip signature, `ustar` marker, gzip signature). A `.gz` counts only as the end of `.tar.gz`. A file named `.zip` whose bytes are not a zip stays a plain binary file.

## What is shown

- **Page:** a table of path, size and modified date (UTC), sorted by path, with the entry count and the unpacked size under it. Names are escaped; control and bidi-override characters show as `�`.
- **Terminal:** in the workspace, the file's note gives the format, the entry count and the unpacked size (`zip, 14 entries, 3.4 MB unpacked.`). Same gating as the page.

## Limits

| Limit | Value | Where |
|---|---|---|
| Entries listed | 2,000 (the rest are counted, and the footer says how many are not listed) | `ENTRY_CAP` |
| Archive file size | 50 MB | `RENDER_CAP.archive` |
| Unpacked size of a `.tar.gz` | 128 MB (gunzip stops there) | `GUNZIP_CAP` |

Zip and tar are read from their directory and headers only; no entry's contents are decompressed. Only `.tar.gz` is gunzipped, in memory, under the 128 MB cap.

## Fallbacks

When the list cannot be shown, the page gives the Download card titled "Archive", with one sentence:

- Over 50 MB: "This archive is over 50 MB, too large to list here. Download it instead."
- A `.tar.gz` past the cap: "This archive unpacks to more than 128 MB, so its list is not read here."
- Encrypted zip: "This zip is encrypted, so its list is not shown."
- Damaged or cut short: "This archive is damaged or cut short, so its list cannot be read."
- Damaged gzip: "This archive is damaged, so its list cannot be read."

The terminal shows the same sentences.
