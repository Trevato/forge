# Tell here

Telling the crew from any page (tell from anywhere) opens in place: `tellInPlace()` in `src/web/client.ts` fetches the
server's own composer (the thread's `.comment-form` saying a tell) and lays it over the bottom of the page, so nothing
shifts and Enter sends it with the page's path as `from`. Any failure falls back to the plain link.

- `.tell-here` — the fixed box holding that composer: pinned to the bottom of the viewport, at most 620px wide and
  centred, above the page; the `.comment-form` inside drops its margin and takes `--shadow-2` so it reads as raised.

- `.tell-picture` — the picture a sender chose to send with a note, on its issue page: at most the card's width, height
  following (no layout shift beyond the image's own load).

- `[data-tell]` — the wrapper of an issue's page (#9384): text wraps anywhere, the two columns may shrink, code scrolls
  inside its own box. It is an attribute hook, not a component class.

## Client home: `client-app-finished`

A muted line on a client's app row, `Finished <time>: <title>`, for the app's
newest merged pull. It sits with `client-app-about`, `client-app-agents` and
`client-app-doing`; it uses `muted` and adds no colour or size. The
terminal says the same words.

## App page: the tell line

The owner's tell on an app's page is one `.bar.tell-box` line, a field and a Tell button, as on home. It adds no
class and no `card`; a stranger gets no form.
