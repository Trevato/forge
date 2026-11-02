# Since you were here

Home shows a digest headed `Since you were here · 2 days`: the pulls that landed in public repositories since you last loaded `/`.

- The forge records your last load in `home_visit` (sqlite), at most once a minute per user.
- The window starts at that time, at least 1 hour and at most 7 days. A first visit looks back 24 hours.
- Nothing landed in the window: no section. Private repositories are never read.

## The terminal

The terminal's home (`ssh`, the dashboard) shows the same lines under the same heading, read from the same `home_visit` row. The terminal only reads it: opening home on the web is what moves "since you were here".

## MCP

`feed` adds `digest` to its first page (not to `cursor` pages): `{ heading, lines: [{ repo, says, href }] } | null`, `null` when nothing landed. It is the same `sinceDigest` as home and, like the terminal, only reads the visit.

## A read that writes

`GET /` writes the viewer's `home_visit` row, but only for a real navigation: a request marked `Sec-Purpose`/`Purpose` prefetch, prerender or preview, or whose `Sec-Fetch-Dest` is not `document`, reads the row and leaves it alone. That is a deliberate exception to "a GET changes nothing": it is one upsert per user per minute at most, it holds no content, and the response does not depend on the write (the digest uses the visit *before* this one).
