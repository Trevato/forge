# Tell here

Telling the crew from any page (tell from anywhere) opens in place: `tellInPlace()` in `src/web/client.ts` fetches the
server's own composer (the thread's `.comment-form` saying a tell) and lays it over the bottom of the page, so nothing
shifts and Enter sends it with the page's path as `from`. Any failure falls back to the plain link.

- `.tell-here` — the fixed box holding that composer: pinned to the bottom of the viewport, at most 620px wide and
  centred, above the page; the `.comment-form` inside drops its margin and takes `--shadow-2` so it reads as raised.
