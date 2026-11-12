# HTML preview

Open an `.html` or `.htm` file (up to 2 MB, no NUL bytes) in a repository and the blob page shows it as the page it is, in a frame (`src/web/render/html_preview.ts`). **Rendered** is the default; **Source** (`?view=source`) shows the markup, escaped, as for any text file; Raw and Download hand back the bytes untouched.

How it is held: the frame points at the media route, which serves the file as `text/html` only under `htmlPolicy` (`src/web/pages/media.ts`): `sandbox` with no `allow-*` token (opaque origin, no script, form or popup), `default-src 'none'`, and images and stylesheets only from this repository's files at the same ref. A relative `../../` reference that climbs out of the repository resolves to an address outside that scope and the browser does not fetch it. The frame element carries `sandbox=""` too, and only the blob page gets `frame-src 'self'`. The file's bytes never enter the blob page's markup. A download is always `application/octet-stream`.

Layout: the frame is 80vh tall (60vh and 360px at least on a phone, 390px wide included), with one hairline and no card around it. It is `color-scheme: light`, so its canvas is white and the page inside looks the same in either theme. Fixed height, so nothing shifts.

Terminal (SSH): the file opens as its source, like any text file; the rendered page is a web-only door, because a terminal cannot draw a page. `test/tui-workspace.test.ts` holds that.
