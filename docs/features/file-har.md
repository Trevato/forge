# A .har file as a request waterfall

A `.har` file (HTTP Archive 1.2, saved from a browser's network panel) opens on
its blob page as a table: method, status, URL, size and time per request, with a
timing bar placed on the session's own timeline. Source is one tap away.

- `src/web/render/har.ts` parses and draws; `kinds.ts` maps `.har` to the `har`
  kind (cap 5 MB); `renderers.ts` names the renderer.
- Size is `response.content.size`, else `bodySize`; `-1` shows as "—".
- The bar is a server-drawn inline SVG per row; no script, no inline style.
- Every URL, status text and header value is escaped. Text is cut at 2,000
  characters; 50 headers per side are shown, and the page prints
  "N more headers not shown" for the rest.
- At most 500 rows are drawn; the page says how many were left out.
- Bad JSON, no `log.entries`, or no requests: the source view, with the reason.
- The terminal workspace opens a `.har` as the same table (same parser, same
  500-row cap); `s` flips to the source, and a malformed file opens as source.
- Try it: open any `.har` in a repository's file view.
