# Muting from the inbox keeps you in place

On `/asks`, "Mute owner/name" under a row mutes that repository. The form carries the page's query as `back`; after the POST you land on the same `/asks?…` (filters kept) with a toast: "Muted owner/name" and an **Undo** button that posts to `/asks/listen`. "Listening to owner/name again" does the reverse, with an Undo that mutes again. Plain forms and redirects: it works without JavaScript.

- `back` is followed only when it is `/asks` or `/asks?…` with no `#`; anything else lands on `/asks`.
- The toast shows only for a repository you can read.
- The flash lives in the address (`?muted=<id>` / `?listened=<id>`), so a reload or a shared link shows it again, and Undo then acts on the current state. The Undo's own `back` drops the flash keys.
- The terminal already does both: its asks screen mutes through the bulk "mute" verb and "listen again" lifts every mute (`src/tui/screens/dashboard.ts`), each with a toast.
